"""What the review page shows for one episode: its words, sentences, chunks and weak spots.

The words are the cleaned and corrected ones `wts chunk` produces (`prepare_episode`), so the
page shows what search has.
"""

import json
import sqlite3
from collections.abc import Sequence
from pathlib import Path

from wts.chunking import prepare_episode
from wts.corrections import CorrectionRule

LOW_PROB = 0.5  # a word Whisper was less sure of than this counts as unsure


def episode_payload(
    conn: sqlite3.Connection, row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> dict:
    sentences, _ = prepare_episode(row, corrections)
    words = [[w.text, w.start_ms, w.end_ms, w.prob] for s in sentences for w in s.words]
    firsts, index = [], 0
    for s in sentences:
        firsts.append(index)
        index += len(s.words)
    chunks = [
        {key: c[key] for key in ("id", "seq", "start_ms", "end_ms", "is_boilerplate")}
        for c in conn.execute(
            "select id, seq, start_ms, end_ms, is_boilerplate from chunks "
            "where episode_id = ? order by seq",
            (row["id"],),
        )
    ]
    keys = row.keys()
    return {
        "episode": {
            "id": row["id"],
            "number": row["number"],
            "title": row["title"],
            "published_at": row["published_at"],
            "stem": row["stem"],
            "duration_s": row["duration_s"],
            "flags": json.loads(row["flags"]),
            # Added by migration 007; an older database has no such column.
            "reviewed_at": row["reviewed_at"] if "reviewed_at" in keys else None,
            "has_audio": bool(row["audio_path"]) and Path(row["audio_path"]).is_file(),
        },
        "words": words,
        "sentences": firsts,
        "chunks": chunks,
        "worst": worst_stretches(words),
    }


def worst_stretches(
    words: Sequence[Sequence], window_ms: int = 60_000, top: int = 5, min_words: int = 20
) -> list[dict]:
    """The stretches with the largest share of unsure words, worst first.

    The rule of `spikes/transcript_peek.py worst`: fixed consecutive windows from 0 (0-60 s,
    60-120 s, ...), by each word's start; a stretch with fewer than `min_words` words is mostly
    music or silence, so its share means little and it is skipped. Words are
    `[text, start_ms, end_ms, prob]`.
    """
    probs: dict[int, list[float]] = {}
    for _, start_ms, _, prob in words:
        probs.setdefault(start_ms // window_ms, []).append(prob)
    stretches = [
        (k, sum(p < LOW_PROB for p in ps) / len(ps), sum(ps) / len(ps))
        for k, ps in probs.items()
        if len(ps) >= min_words
    ]
    # Ties go to the lower mean probability, then the earlier stretch.
    stretches.sort(key=lambda s: (-s[1], s[2], s[0]))
    return [{"start_ms": k * window_ms, "share": share} for k, share, _ in stretches[:top]]


def chunk_position(conn: sqlite3.Connection, chunk_id: int) -> tuple[int, int] | None:
    """`(episode_id, start_ms)` of a local chunk, or None if there is no such chunk."""
    row = conn.execute(
        "select episode_id, start_ms from chunks where id = ?", (chunk_id,)
    ).fetchone()
    return (row["episode_id"], row["start_ms"]) if row else None
