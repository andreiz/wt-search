"""`wts chunk`: raw transcript → guards → corrections → sentences → boilerplate → chunks.

Everything here is deterministic and cheap, so it can be re-run whenever the guards,
corrections.yaml or the boilerplate index change, without re-transcribing.
"""

import json
import logging
import sqlite3
from collections.abc import Sequence
from pathlib import Path

from wts.boilerplate import BoilerplateIndex
from wts.chunker import build_chunks
from wts.corrections import CorrectionRule, apply_corrections
from wts.guards import clean_transcript
from wts.state import Status, fail, requeue_embedding
from wts.words import Sentence, join_split_words, split_sentences

log = logging.getLogger("wts")
_CHUNK_COLUMNS = "seq, start_ms, end_ms, text, word_times, is_boilerplate"


def prepare_episode(
    row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> tuple[list[Sentence], list[str]]:
    data = json.loads(Path(row["transcript_path"]).read_text())
    # The downloaded file's own length beats the feed's (inserted ads can make it longer).
    words, flags = clean_transcript(data, row["audio_duration_s"] or row["duration_s"])
    words = apply_corrections(words, corrections, row["stem"])
    # After corrections, so a rule still sees "Rubo" on its own in "Rubo -style" (and "10" in
    # "10 %").
    return split_sentences(join_split_words(words)), flags


def chunk_episode(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    corrections: Sequence[CorrectionRule],
    index: BoilerplateIndex,
    *,
    reindex: bool = True,
) -> bool:
    """Rebuild one episode's chunks. Returns True if they differ from what was stored.

    An `embedded`/`published` episode whose chunks changed goes back to `chunked` in the same
    transaction, so its vectors can't outlive the text they were made from. `reindex=False`
    leaves the boilerplate index alone because the caller has already brought it up to date.
    """
    sentences, flags = prepare_episode(row, corrections)
    if reindex:
        index.replace_episode(row["id"], sentences)
    chunks = build_chunks(sentences, index.mask(row["id"], sentences))
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


def refresh_chunks(
    conn: sqlite3.Connection, corrections: Sequence[CorrectionRule], index: BoilerplateIndex
) -> int:
    """Re-chunk already-chunked episodes; changed ones go back to `chunked` for re-embedding.

    Two passes: first every episode's fingerprints are brought up to date, then each is
    classified against the finished index. One pass would classify an episode against older
    fingerprints of the episodes after it, and nothing would revisit it. The price is reading
    and cleaning every transcript twice.
    """
    rows = conn.execute(
        "select * from episodes where status in (?, ?, ?) order by published_at",
        (Status.CHUNKED, Status.EMBEDDED, Status.PUBLISHED),
    ).fetchall()

    def failed(row: sqlite3.Row, exc: Exception) -> None:
        # One bad transcript must not block every run.
        fail(conn, row["id"], "chunk", repr(exc)[:500])
        log.error(f"re-chunking failed: {exc!r}", extra={"step": "chunk", "episode": row["stem"]})

    indexed = []
    for row in rows:
        try:
            sentences, _ = prepare_episode(row, corrections)
            index.replace_episode(row["id"], sentences)
        except Exception as exc:  # noqa: BLE001
            failed(row, exc)
        else:
            indexed.append(row)
    changed = 0
    for row in indexed:
        try:
            if chunk_episode(conn, row, corrections, index, reindex=False):
                changed += 1
        except Exception as exc:  # noqa: BLE001
            failed(row, exc)
    return changed
