"""Repairs beside a transcript, and the cleaned words with the accepted ones spliced in.

Spec 2026-10-26 transcript repair §5.4. Whisper's raw JSON is never edited: an episode's repairs
live in `<data>/repairs/<stem>.json`, each with a status. `accepted` (by the
maintainer on the review page) and `auto` (by the rule, when switched on) are applied, after the
guards and before corrections, by `cleaned_words`, which `wts chunk` and the review page share.

The file names the transcript it was made from by sha256; a file for another transcript (the
episode was re-transcribed) is stale and applies nothing until `wts repair` remakes it.
"""

import hashlib
import json
import logging
import os
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from wts.guards import clean_transcript
from wts.holes import Span
from wts.words import Word, normalize_text

log = logging.getLogger("wts")

STATUSES = ("proposed", "accepted", "rejected", "auto")
APPLIED = ("accepted", "auto")


@dataclass
class Repair:
    id: str  # f"{hole[0]}-{hole[1]}"
    hole: Span
    clip: Span
    index: int  # position of the first replaced word in the cleaned words
    from_ms: int
    to_ms: int
    before: list[Word]
    after: list[Word]
    second_after: list[Word] | None
    fails: list[int]  # the rule's failed checks; empty: it would apply this
    status: str = "proposed"
    machine: str | None = None  # where the fresh pass was heard ("walnut"); None in older files


@dataclass
class RepairsFile:
    transcript_sha: str
    flags: list[Span] = field(default_factory=list)  # every flag found, repaired or not
    repairs: list[Repair] = field(default_factory=list)
    complete: bool = True  # False when a clip pass failed: the episode is tried again


def repairs_path(transcript_path: Path) -> Path:
    """`<data>/repairs/<stem>.json`, beside the transcripts folder, not in it: whatever reads
    "every .json in transcripts/" (corrections checks, the spikes) must not take a repairs file
    for a transcript."""
    return transcript_path.parent.with_name("repairs") / transcript_path.name


def transcript_sha(transcript_path: Path) -> str:
    return hashlib.sha256(transcript_path.read_bytes()).hexdigest()


def _words_out(ws: Sequence[Word] | None) -> list | None:
    return None if ws is None else [[w.text, w.start_ms, w.end_ms, w.prob] for w in ws]


def _words_in(raw: list | None) -> list[Word] | None:
    return None if raw is None else [Word(t, s, e, p) for t, s, e, p in raw]


def save_repairs(transcript_path: Path, rf: RepairsFile) -> None:
    data = {
        "transcript_sha": rf.transcript_sha,
        "flags": [list(f) for f in rf.flags],
        "complete": rf.complete,
        "repairs": [
            {
                "id": r.id, "hole": list(r.hole), "clip": list(r.clip), "index": r.index,
                "from_ms": r.from_ms, "to_ms": r.to_ms, "before": _words_out(r.before),
                "after": _words_out(r.after), "second_after": _words_out(r.second_after),
                "fails": r.fails, "status": r.status, "machine": r.machine,
            }
            for r in rf.repairs
        ],
    }
    path = repairs_path(transcript_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def load_repairs(transcript_path: Path) -> RepairsFile | None:
    path = repairs_path(transcript_path)
    if not path.is_file():
        return None
    data = json.loads(path.read_text())
    return RepairsFile(
        transcript_sha=data["transcript_sha"],
        flags=[tuple(f) for f in data["flags"]],
        repairs=[
            Repair(
                id=r["id"], hole=tuple(r["hole"]), clip=tuple(r["clip"]), index=r["index"],
                from_ms=r["from_ms"], to_ms=r["to_ms"], before=_words_in(r["before"]),
                after=_words_in(r["after"]), second_after=_words_in(r["second_after"]),
                fails=r["fails"], status=r["status"], machine=r.get("machine"),
            )
            for r in data["repairs"]
        ],
        complete=data.get("complete", True),
    )


def apply_repairs(words: list[Word], repairs: Sequence[Repair]) -> list[Word]:
    """`words` with the applied repairs spliced in. A repair whose `before` words aren't where
    it says (or that overlaps one already applied) is skipped with a warning."""
    out = list(words)
    limit = len(out) + 1  # applied back to front, so earlier positions stay valid
    for r in sorted((r for r in repairs if r.status in APPLIED), key=lambda r: -r.index):
        end = r.index + len(r.before)
        here = [w.text for w in out[r.index:end]]
        if end >= limit or here != [w.text for w in r.before]:
            log.warning(f"repair {r.id} skipped: the transcript's words there have changed")
            continue
        out[r.index:end] = r.after
        limit = r.index
    return out


def _text(ws: Sequence[Word]) -> str:
    return normalize_text(" ".join(w.text for w in ws))


def carry_decisions(old: Sequence[Repair], new: list[Repair]) -> None:
    """Give a new repair an old one's decision when their holes overlap and they propose the
    same words: re-transcribing an episode shouldn't mean reviewing it all again."""
    for n in new:
        for o in old:
            if o.status != "proposed" and o.hole[0] < n.hole[1] and n.hole[0] < o.hole[1] \
                    and _text(o.after) == _text(n.after):
                n.status = o.status
                break


def cleaned_words(row: sqlite3.Row) -> tuple[list[Word], list[str]]:
    """The guards' words for this episode, with its applied repairs spliced in."""
    path = Path(row["transcript_path"])
    words, flags = clean_transcript(
        json.loads(path.read_text()), row["audio_duration_s"] or row["duration_s"]
    )
    return with_repairs(path, words), flags


def with_repairs(transcript_path: Path, words: list[Word]) -> list[Word]:
    """The transcript's cleaned words with its applied repairs spliced in; the same words when
    it has no repairs file, or one made for an earlier version of the transcript."""
    rf = load_repairs(transcript_path)
    if rf is None or rf.transcript_sha != transcript_sha(transcript_path):
        return words
    return apply_repairs(words, rf.repairs)
