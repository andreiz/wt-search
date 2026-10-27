"""One episode's repair pass (repair spec §5.1–5.3): holes → clip passes → judged proposals.

`steps.run_repair` picks the episodes and handles the run; this module does one episode.
"""

import json
import logging
import tempfile
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from wts.guards import clean_transcript
from wts.holes import Span, find_holes, speech_between
from wts.repair import (
    SECOND_PASS_SHIFT_MS,
    Proposal,
    clip_span,
    clip_words,
    cut_clip,
    propose,
)
from wts.repair_rule import judge
from wts.repairs import (
    APPLIED,
    Repair,
    RepairsFile,
    carry_decisions,
    load_repairs,
    save_repairs,
    transcript_sha,
)
from wts.storage import MachineProblem
from wts.transcribe import Transcriber, machine_name
from wts.vad import SpeechDetector
from wts.words import Word

log = logging.getLogger("wts")

NEARBY_WORDS = 60  # the rule's "neighbouring sentence" check looks this far each side
Clipper = Callable[[Path, Span, Path], Path]


def repairs_due(transcript_path: Path) -> bool:
    """No repairs file yet, one made from another transcript, or one a failed clip pass left
    incomplete."""
    rf = load_repairs(transcript_path)
    return rf is None or not rf.complete or rf.transcript_sha != transcript_sha(transcript_path)


def _pass(
    transcriber: Transcriber, clipper: Clipper, audio: Path, clip: Span, prompt: str,
    tmp: Path, hole: Span, words: list[Word],
) -> Proposal | None:
    out = clipper(audio, clip, tmp / f"clip-{clip[0]}-{clip[1]}.mp3")
    fresh = transcriber.transcribe(out, prompt)
    return propose(words, hole, clip, clip_words(fresh, clip[0]))


def _filled_span(p: Proposal, hole: Span, clip: Span) -> Span:
    """The stretch whose speech the repair fills: its bounds, the hole and the new words,
    whichever reach furthest, within the clip. `from_ms` alone can be late: Whisper often
    stretches the word before a skip across it."""
    start = min(p.from_ms if p.from_ms >= 0 else hole[0], hole[0], p.after[0].start_ms)
    end = max(min(p.to_ms, clip[1]), hole[1], p.after[-1].end_ms)
    return (max(start, clip[0]), min(end, clip[1]))


def repair_episode(
    row, transcriber: Transcriber, detector: SpeechDetector, prompt: str, *, auto: bool,
    clipper: Clipper = cut_clip, counts: Counter | None = None,
) -> tuple[RepairsFile, bool]:
    """Find this episode's holes, propose repairs, save the file. Returns it and whether the
    set of applied repairs changed (the episode then needs re-chunking).

    A clip pass that fails for any reason but the machine drops that flag only.
    """
    counts = counts if counts is not None else Counter()
    path, audio = Path(row["transcript_path"]), Path(row["audio_path"])
    words, _ = clean_transcript(
        json.loads(path.read_text()), row["audio_duration_s"] or row["duration_s"]
    )
    duration_ms = round(1000 * (row["audio_duration_s"] or row["duration_s"] or 0)) or (
        words[-1].end_ms if words else 0)
    speech = detector.speech(audio)
    flags = find_holes(words, speech)
    counts["flags"] += len(flags)
    repairs: list[Repair] = []
    complete = True
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        for hole in flags:
            clip = clip_span(hole, duration_ms)
            extra = {"step": "repair", "episode": row["stem"]}
            try:
                p = _pass(transcriber, clipper, audio, clip, prompt, tmp, hole, words)
            except MachineProblem:
                raise
            except Exception as exc:  # noqa: BLE001 — one clip must not stop the episode
                # Not "nothing found": the file is saved incomplete, so the next run tries again.
                log.warning(f"clip {clip[0]}–{clip[1]} ms failed: {exc!r}", extra=extra)
                counts["failed"] += 1
                complete = False
                continue
            end = p.index + len(p.before) if p else 0
            if p is None or any(r.index <= end and p.index <= r.index + len(r.before)
                                for r in repairs):
                counts["dropped"] += 1
                continue
            second_clip = clip_span(hole, duration_ms, SECOND_PASS_SHIFT_MS)
            try:
                second = _pass(transcriber, clipper, audio, second_clip, prompt, tmp, hole, words)
            except MachineProblem:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning(f"second pass failed: {exc!r}", extra=extra)
                second = None
            filled = speech_between(speech, _filled_span(p, hole, clip))
            nearby = words[max(0, p.index - NEARBY_WORDS):p.index] + words[end:end + NEARBY_WORDS]
            fails = judge(p, second, filled, nearby)
            status = "auto" if auto and not fails else "proposed"
            counts[status] += 1
            repairs.append(Repair(
                id=f"{hole[0]}-{hole[1]}", hole=hole, clip=clip, index=p.index,
                from_ms=p.from_ms, to_ms=p.to_ms, before=list(p.before), after=list(p.after),
                second_after=list(second.after) if second else None, fails=fails, status=status,
                machine=machine_name(transcriber),
            ))
    old = load_repairs(path)
    if old is not None:
        carry_decisions(old.repairs, repairs)
    rf = RepairsFile(transcript_sha(path), flags, repairs, complete=complete)
    save_repairs(path, rf)
    applied_before = any(r.status in APPLIED for r in old.repairs) if old else False
    return rf, applied_before or any(r.status in APPLIED for r in repairs)
