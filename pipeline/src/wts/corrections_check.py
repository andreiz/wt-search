"""What a corrections change would alter, across every transcript (review tool, spec §3.3).

Runs the clean-up `wts chunk` does (guards → corrections → join split words → sentences) with
the old rules and the new ones, and returns the sentences that differ.
"""

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from wts.corrections import CorrectionRule, apply_corrections
from wts.guards import clean_transcript
from wts.words import join_split_words, split_sentences


@dataclass(frozen=True)
class Change:
    stem: str
    start_ms: int
    before: str  # "" when the sentence did not exist before
    after: str  # "" when it no longer exists


def sentences(data: dict, rules: Sequence[CorrectionRule], stem: str) -> dict[int, str]:
    """The episode's sentence texts by start time, as `wts chunk` would see them."""
    words, _ = clean_transcript(data, data["meta"].get("duration_s"))
    # The same order as wts chunk (chunking.prepare_episode), so the preview is the chunk text.
    corrected = join_split_words(apply_corrections(words, rules, stem))
    return {s.start_ms: s.text for s in split_sentences(corrected)}


def rule_changes(
    transcripts_dir: Path, before: Sequence[CorrectionRule], after: Sequence[CorrectionRule]
) -> list[Change]:
    """Every sentence that differs between the two rule sets, ordered by stem then time."""
    changes: list[Change] = []
    for path in sorted(transcripts_dir.glob("*.json"), key=lambda p: p.stem):
        data = json.loads(path.read_text())
        old, new = sentences(data, before, path.stem), sentences(data, after, path.stem)
        for start in sorted(set(old) | set(new)):
            if old.get(start) != new.get(start):
                changes.append(Change(path.stem, start, old.get(start, ""), new.get(start, "")))
    return changes


def changes_digest(changes: Iterable[Change]) -> str:
    """SHA-256 over the changes, so a save can prove it matches what a preview showed."""
    canonical = json.dumps(
        [[c.stem, c.start_ms, c.before, c.after] for c in changes],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
