"""Whole-word transcript fixes from corrections.yaml (spec §3.3)."""

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import yaml

from wts.words import Word

CORRECTIONS_FILE = Path(__file__).resolve().parents[2] / "corrections.yaml"
_PUNCT = re.compile(r"[^\w']+")
_TRAILING = re.compile(r"[^\w']+$")


@dataclass(frozen=True)
class CorrectionRule:
    match: tuple[str, ...]
    replace: str
    episode: str | None


def _key(text: str) -> str:
    return _PUNCT.sub("", text.lower())


def _match_words(key: str) -> tuple[str, ...]:
    return tuple(k for k in (_key(p) for p in str(key).split()) if k)


def load_corrections(path: Path) -> list[CorrectionRule]:
    if not path.exists():
        return []
    # BaseLoader keeps every key and value as text: `no:` stays "no", `uh:` is "" (delete).
    data = yaml.load(path.read_text(), Loader=yaml.BaseLoader) or {}
    rules = [
        CorrectionRule(_match_words(k), str(v), None) for k, v in (data.get("global") or {}).items()
    ]
    for stem, mapping in (data.get("episodes") or {}).items():
        rules += [CorrectionRule(_match_words(k), str(v), stem) for k, v in (mapping or {}).items()]
    return [r for r in rules if r.match]


def corrections_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def _replace(span: list[Word], replacement: str, previous: list[Word]) -> list[Word]:
    """The replacement as one Word per token (sharing the span's time), keeping punctuation.

    Each Word's text must stay a single token: chunk text and word_times are aligned 1:1.
    """
    trailing_match = _TRAILING.search(span[-1].text)
    trailing = trailing_match.group() if trailing_match else ""
    tokens = replacement.split()
    if not tokens:  # deletion: keep a sentence end by moving it onto the previous word
        if trailing and previous and not _TRAILING.search(previous[-1].text):
            last = previous[-1]
            previous[-1] = Word(last.text + trailing, last.start_ms, last.end_ms, last.prob)
        return []
    start, end = span[0].start_ms, span[-1].end_ms
    step = (end - start + 1) / len(tokens)
    prob = min(w.prob for w in span)
    out = [
        Word(t, start + round(k * step), start + round((k + 1) * step) - 1, prob)
        for k, t in enumerate(tokens)
    ]
    last = out[-1]
    out[-1] = Word(last.text + trailing, last.start_ms, end, prob)
    return out


def apply_corrections(words: list[Word], rules: Sequence[CorrectionRule], stem: str) -> list[Word]:
    def longest_first(rs: list[CorrectionRule]) -> list[CorrectionRule]:
        return sorted(rs, key=lambda r: -len(r.match))

    ordered = longest_first([r for r in rules if r.episode == stem]) + longest_first(
        [r for r in rules if r.episode is None]
    )
    if not ordered:
        return list(words)
    keys = [_key(w.text) for w in words]
    out: list[Word] = []
    i = 0
    while i < len(words):
        for rule in ordered:
            n = len(rule.match)
            if tuple(keys[i : i + n]) == rule.match:
                out.extend(_replace(words[i : i + n], rule.replace, out))
                i += n
                break
        else:
            out.append(words[i])
            i += 1
    return out
