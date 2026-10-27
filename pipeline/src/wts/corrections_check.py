"""What a corrections change would alter, across every transcript (review tool, spec §3.3).

Runs the clean-up `wts chunk` does (guards → applied repairs → corrections → join split words →
sentences) with the old rules and the new ones, and returns the sentences that differ.
"""

import hashlib
import json
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from wts.corrections import CorrectionRule, _key, apply_corrections
from wts.guards import clean_transcript
from wts.repairs import repairs_path, with_repairs
from wts.words import Word, join_split_words, split_sentences


@dataclass(frozen=True)
class Change:
    stem: str
    start_ms: int
    before: str  # "" when the sentence did not exist before
    after: str  # "" when it no longer exists


def _clean_words(path: Path) -> list[Word]:
    data = json.loads(path.read_text())
    # With accepted repairs, like wts chunk (repairs.cleaned_words): a rule can fix their words.
    return with_repairs(path, clean_transcript(data, data["meta"].get("duration_s"))[0])


def _stamp(path: Path) -> tuple[int, ...]:
    """When the transcript or its repairs file last changed (a repair accepted, undone)."""
    stat = path.stat()
    try:
        rstat = repairs_path(path).stat()
        repairs = (rstat.st_mtime_ns, rstat.st_size)
    except FileNotFoundError:
        repairs = (0, 0)
    return (stat.st_mtime_ns, stat.st_size, *repairs)


def _sentences(words: list[Word], rules: Sequence[CorrectionRule], stem: str) -> dict[int, str]:
    """The episode's sentence texts by start time, as `wts chunk` would see them."""
    # The same order as wts chunk (chunking.prepare_episode), so the preview is the chunk text.
    corrected = join_split_words(apply_corrections(words, rules, stem))
    return {s.start_ms: s.text for s in split_sentences(corrected)}


def _transcript_changes(
    words: list[Word], stem: str, before: Sequence[CorrectionRule], after: Sequence[CorrectionRule]
) -> list[Change]:
    old, new = _sentences(words, before, stem), _sentences(words, after, stem)
    return [
        Change(stem, start, old.get(start, ""), new.get(start, ""))
        for start in sorted(set(old) | set(new))
        if old.get(start) != new.get(start)
    ]


def _transcripts(transcripts_dir: Path) -> list[Path]:
    return sorted(transcripts_dir.glob("*.json"), key=lambda p: p.stem)


def rule_changes(
    transcripts_dir: Path, before: Sequence[CorrectionRule], after: Sequence[CorrectionRule]
) -> list[Change]:
    """Every sentence that differs between the two rule sets, ordered by stem then time."""
    changes: list[Change] = []
    for path in _transcripts(transcripts_dir):
        changes += _transcript_changes(_clean_words(path), path.stem, before, after)
    return changes


_SEP = "\x1f"  # between the keys of a transcript's words; `_key` leaves only word characters


class WordKeys:
    """Each transcript's cleaned words as one string of correction keys, kept between previews.

    Reading and cleaning a transcript is most of a preview's time (about 35 ms each), and a new
    rule can only change a transcript its words occur in. So the review server keeps this, and a
    preview reads in full only the transcripts that can change. An entry is redone when the
    time or size of the transcript or its repairs file changes. Safe to use from several threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[Path, tuple[tuple[int, ...], str]] = {}

    def of(self, path: Path) -> str:
        stamp = _stamp(path)
        with self._lock:
            entry = self._entries.get(path)
        if entry and entry[0] == stamp:
            return entry[1]
        keys = _SEP + _SEP.join(_key(w.text) for w in _clean_words(path)) + _SEP
        with self._lock:
            self._entries[path] = (stamp, keys)
        return keys

    def has(self, path: Path, match: tuple[str, ...]) -> bool:
        """Whether the words of `match` occur, in a row, in the transcript."""
        return _SEP + _SEP.join(match) + _SEP in self.of(path)

    def warm(self, transcripts_dir: Path) -> None:
        """Read every transcript once, so the first preview does not wait for it."""
        for path in _transcripts(transcripts_dir):
            try:
                self.of(path)
            except (OSError, ValueError, KeyError):  # a preview will report it
                continue


def added_rule_changes(
    transcripts_dir: Path, before: Sequence[CorrectionRule], rule: CorrectionRule, keys: WordKeys
) -> list[Change]:
    """`rule_changes(dir, before, [*before, rule])`, reading only the transcripts that can change.

    A rule changes nothing where it never applies, and it applies only where its words occur in
    a row (`apply_corrections` compares the same keys), in its own episode if it has one.
    """
    after = [*before, rule]
    changes: list[Change] = []
    for path in _transcripts(transcripts_dir):
        if rule.episode is not None and rule.episode != path.stem:
            continue
        if keys.has(path, rule.match):
            changes += _transcript_changes(_clean_words(path), path.stem, before, after)
    return changes


def changes_digest(changes: Iterable[Change]) -> str:
    """SHA-256 over the changes, so a save can prove it matches what a preview showed."""
    canonical = json.dumps(
        [[c.stem, c.start_ms, c.before, c.after] for c in changes],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
