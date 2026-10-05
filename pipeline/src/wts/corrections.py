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
    data = yaml.safe_load(path.read_text()) or {}
    rules = [
        CorrectionRule(_match_words(k), str(v), None) for k, v in (data.get("global") or {}).items()
    ]
    for stem, mapping in (data.get("episodes") or {}).items():
        rules += [CorrectionRule(_match_words(k), str(v), stem) for k, v in (mapping or {}).items()]
    return [r for r in rules if r.match]


def corrections_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


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
                span = words[i : i + n]
                trailing = _TRAILING.search(span[-1].text)
                out.append(
                    Word(
                        rule.replace + (trailing.group() if trailing else ""),
                        span[0].start_ms,
                        span[-1].end_ms,
                        min(w.prob for w in span),
                    )
                )
                i += n
                break
        else:
            out.append(words[i])
            i += 1
    return out
