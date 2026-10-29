"""`wts chunk`: raw transcript → guards → corrections → sentences → chunks.

Everything here is deterministic and cheap, so it can be re-run whenever the guards or
corrections.yaml change, without re-transcribing. Boilerplate (boilerplate spec 2026-10-28) is
the word runs that enough episodes share: each chunked episode's run hashes are cached in
`run_hashes`, counted across the corpus, and the spans they cover become chunks of their own,
flagged `is_boilerplate` (embed and publish skip them; search hides them unless asked).
"""

import json
import logging
import sqlite3
from collections import Counter
from collections.abc import Collection, Sequence

import numpy as np

from wts.boilerplate import Params, find_spans, run_hashes, shared_runs, tokens
from wts.chunker import build_chunks
from wts.corrections import CorrectionRule, apply_corrections
from wts.repairs import cleaned_words
from wts.state import Status, fail, requeue_embedding
from wts.words import Sentence, join_split_words, normalize_text, split_sentences

log = logging.getLogger("wts")
_CHUNK_COLUMNS = "seq, start_ms, end_ms, text, word_times, is_boilerplate"

# Bump this whenever a change to the chunking code (guards, sentence splitting, the chunker)
# changes what it produces. The chunk step re-chunks every episode once when it differs from the
# stored value, and the changed ones go back to `chunked` for re-embedding.
CHUNKER_VERSION = 4  # 3: boilerplate spans cut and flagged; 4: loops run to the end (2026-10-28)
_IN_CORPUS = (Status.CHUNKED, Status.EMBEDDED, Status.PUBLISHED)


def chunking_inputs(corrections_sha: str) -> str:
    """What the stored chunks were built from, besides the transcripts: compared by the step."""
    return f"{corrections_sha}:v{CHUNKER_VERSION}"


def prepare_episode(
    row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> tuple[list[Sentence], list[str]]:
    # The guards' words with accepted repairs spliced in (repair spec §5.4).
    words, flags = cleaned_words(row)
    words = apply_corrections(words, corrections, row["stem"])
    # After corrections, so a rule still sees "Rubo" on its own in "Rubo -style" (and "10" in
    # "10 %").
    return split_sentences(join_split_words(words)), flags


def store_run_hashes(
    conn: sqlite3.Connection, episode_id: int, hashes: np.ndarray, n: int
) -> None:
    with conn:
        conn.execute(
            "insert into run_hashes (episode_id, n, hashes) values (?, ?, ?) "
            "on conflict (episode_id) do update set n = excluded.n, hashes = excluded.hashes",
            (episode_id, n, hashes.astype(np.uint64).tobytes()),
        )


def corpus_shared_runs(
    conn: sqlite3.Connection, params: Params | None = None, *, include: int | None = None
) -> np.ndarray:
    """The run hashes shared by enough episodes: those chunked, embedded or published, plus
    `include` (the episode being chunked) whatever its status."""
    params = params or Params()
    marks = ", ".join("?" for _ in _IN_CORPUS)
    # An episode that failed at embed or publish still has its text and chunks: it counts, or
    # one flaky publish would unhide passages elsewhere until it's retried.
    rows = conn.execute(
        f"select r.hashes from run_hashes r join episodes e on e.id = r.episode_id "
        f"where r.n = ? and (e.status in ({marks}) or e.id = ? "
        f"or (e.status = ? and e.error_step in ('embed', 'publish')))",
        (params.run_words, *_IN_CORPUS, -1 if include is None else include, Status.ERROR),
    )
    return shared_runs((np.frombuffer(r[0], np.uint64) for r in rows), params.min_episodes)


def load_shared(conn: sqlite3.Connection, n: int) -> np.ndarray | None:
    """The shared runs the stored chunks were last cut against; None if never stored."""
    row = conn.execute("select n, hashes from shared_runs where id = 1").fetchone()
    return np.frombuffer(row[1], np.uint64) if row and row[0] == n else None


def save_shared(conn: sqlite3.Connection, shared: np.ndarray, n: int) -> None:
    with conn:
        conn.execute(
            "insert into shared_runs (id, n, hashes) values (1, ?, ?) "
            "on conflict (id) do update set n = excluded.n, hashes = excluded.hashes",
            (n, shared.astype(np.uint64).tobytes()),
        )


def episodes_holding(conn: sqlite3.Connection, hashes: np.ndarray) -> set[int]:
    """Corpus episodes whose cached run hashes include any of `hashes`."""
    if not len(hashes):
        return set()
    marks = ", ".join("?" for _ in _IN_CORPUS)
    return {
        episode_id
        for episode_id, blob in conn.execute(
            f"select r.episode_id, r.hashes from run_hashes r join episodes e "
            f"on e.id = r.episode_id where e.status in ({marks})",
            _IN_CORPUS,
        )
        if np.isin(np.frombuffer(blob, np.uint64), hashes).any()
    }


def _words(sentences: Sequence[Sentence]) -> list:
    return [w for s in sentences for w in s.words]


def index_episode(
    conn: sqlite3.Connection, row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> None:
    """Cache the episode's run hashes from its current text, without touching its chunks."""
    sentences, _ = prepare_episode(row, corrections)
    n = Params().run_words
    store_run_hashes(conn, row["id"], run_hashes(tokens(_words(sentences)), n), n)


def chunk_episode(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    corrections: Sequence[CorrectionRule],
    shared: np.ndarray | None = None,
) -> bool:
    """Rebuild one episode's chunks. Returns True if they differ from what was stored.

    The episode's run hashes are cached first; it is then cut against `shared`, or, when that
    is None, against the counts of the whole corpus including its own new text.

    An `embedded`/`published` episode whose chunks changed goes back to `chunked` in the same
    transaction, so its vectors can't outlive the text they were made from.
    """
    sentences, flags = prepare_episode(row, corrections)
    words = _words(sentences)
    params = Params()
    store_run_hashes(conn, row["id"], run_hashes(tokens(words), params.run_words),
                     params.run_words)
    if shared is None:
        shared = corpus_shared_runs(conn, params, include=row["id"])
    chunks = build_chunks(sentences, find_spans(words, shared, params))
    new = [
        (c.seq, c.start_ms, c.end_ms, c.text, c.word_times, int(c.is_boilerplate)) for c in chunks
    ]
    stored = [
        tuple(r)
        for r in conn.execute(
            f"select {_CHUNK_COLUMNS} from chunks where episode_id = ? order by seq", (row["id"],)
        )
    ]
    with conn:
        conn.execute("update episodes set flags = ? where id = ?", (json.dumps(flags), row["id"]))
        if stored == new:
            return False
        # Update in place by (episode, seq) so chunk ids stay stable; they become Vectorize ids.
        conn.execute(
            "delete from chunks where episode_id = ? and seq >= ?", (row["id"], len(new))
        )
        conn.executemany(
            f"insert into chunks (episode_id, {_CHUNK_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?) "
            "on conflict (episode_id, seq) do update set start_ms = excluded.start_ms, "
            "end_ms = excluded.end_ms, text = excluded.text, word_times = excluded.word_times, "
            "is_boilerplate = excluded.is_boilerplate",
            [(row["id"], *values) for values in new],
        )
        if row["status"] in (Status.EMBEDDED, Status.PUBLISHED):
            requeue_embedding(conn, row["id"])
    return True


def _corpus_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "select * from episodes where status in (?, ?, ?) order by published_at", _IN_CORPUS
    ).fetchall()


def refresh_chunks(
    conn: sqlite3.Connection,
    corrections: Sequence[CorrectionRule],
    *,
    rehash: bool,
    only: Collection[int] | None = None,
) -> int:
    """Re-chunk already-chunked episodes (or just those in `only`); changed ones go back to
    `chunked` for re-embedding.

    With `rehash` (their text may have changed) every episode's run hashes are rebuilt first,
    so all are cut against one count of the corpus as it now is, whatever the order.
    """
    if rehash:
        for row in _corpus_rows(conn):
            try:
                index_episode(conn, row, corrections)
            except Exception as exc:  # noqa: BLE001 — as below
                fail(conn, row["id"], "chunk", repr(exc)[:500])
                log.error(
                    f"re-chunking failed: {exc!r}", extra={"step": "chunk", "episode": row["stem"]}
                )
    shared = corpus_shared_runs(conn)
    changed = 0
    for row in _corpus_rows(conn):
        if only is not None and row["id"] not in only:
            continue
        try:
            if chunk_episode(conn, row, corrections, shared):
                changed += 1
        except Exception as exc:  # noqa: BLE001
            # One bad transcript must not block every run.
            fail(conn, row["id"], "chunk", repr(exc)[:500])
            log.error(
                f"re-chunking failed: {exc!r}", extra={"step": "chunk", "episode": row["stem"]}
            )
    return changed


def boilerplate_texts(conn: sqlite3.Connection) -> Counter[str]:
    """Each flagged chunk's normalised text → how many different episodes have it."""
    seen = {
        (normalize_text(text), episode_id)
        for text, episode_id in conn.execute(
            "select text, episode_id from chunks where is_boilerplate = 1"
        )
    }
    return Counter(text for text, _ in seen)
