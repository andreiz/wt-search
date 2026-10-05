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
from wts.state import Status, advance, fail, reset
from wts.words import Sentence, split_sentences

log = logging.getLogger("wts")
_CHUNK_COLUMNS = "seq, start_ms, end_ms, text, word_times, is_boilerplate"


def prepare_episode(
    row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> tuple[list[Sentence], list[str]]:
    data = json.loads(Path(row["transcript_path"]).read_text())
    # The downloaded file's own length beats the feed's (inserted ads can make it longer).
    words, flags = clean_transcript(data, row["audio_duration_s"] or row["duration_s"])
    words = apply_corrections(words, corrections, row["stem"])
    return split_sentences(words), flags


def chunk_episode(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    corrections: Sequence[CorrectionRule],
    index: BoilerplateIndex,
) -> bool:
    """Rebuild one episode's chunks. Returns True if they differ from what was stored."""
    sentences, flags = prepare_episode(row, corrections)
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
    return True


def refresh_chunks(
    conn: sqlite3.Connection, corrections: Sequence[CorrectionRule], index: BoilerplateIndex
) -> int:
    """Re-chunk already-chunked episodes; changed ones go back to `chunked` for re-embedding."""
    rows = conn.execute(
        "select * from episodes where status in (?, ?, ?) order by published_at",
        (Status.CHUNKED, Status.EMBEDDED, Status.PUBLISHED),
    ).fetchall()
    changed = 0
    for row in rows:
        try:
            if not chunk_episode(conn, row, corrections, index):
                continue
        except Exception as exc:  # noqa: BLE001 — one bad transcript must not block every run
            fail(conn, row["id"], "chunk", repr(exc)[:500])
            log.error(f"re-chunking failed: {exc!r}", extra={"step": "chunk",
                                                             "episode": row["stem"]})
            continue
        changed += 1
        if row["status"] != Status.CHUNKED:
            reset(conn, row["id"], Status.TRANSCRIBED)
            advance(conn, row["id"], "chunk")
    return changed
