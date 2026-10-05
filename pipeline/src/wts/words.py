"""Timed words, sentences, and text normalization shared by cleanup, chunking and boilerplate."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cached_property

from num2words import num2words

_ABBREVIATIONS = {"mr.", "mrs.", "dr.", "st.", "vs.", "no."}
_ORDINAL_DOT = re.compile(r"^\d+\.$")
_NOT_WORDISH = re.compile(r"[^\w\s']+")
_EDGE_APOSTROPHES = re.compile(r"(?<!\w)'|'(?!\w)")
_DIGITS = re.compile(r"\d+")


@dataclass(frozen=True)
class Word:
    text: str
    start_ms: int
    end_ms: int
    prob: float


@dataclass(frozen=True)
class Sentence:
    words: tuple[Word, ...]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def start_ms(self) -> int:
        return self.words[0].start_ms

    @property
    def end_ms(self) -> int:
        return self.words[-1].end_ms

    @cached_property
    def norm(self) -> str:
        return normalize_text(self.text)


def _ends_sentence(text: str) -> bool:
    lower = text.lower()
    if not lower.endswith((".", "?", "!")):
        return False
    return lower not in _ABBREVIATIONS and not _ORDINAL_DOT.match(lower)


def split_sentences(words: Sequence[Word]) -> list[Sentence]:
    sentences: list[Sentence] = []
    current: list[Word] = []
    for w in words:
        current.append(w)
        if _ends_sentence(w.text):
            sentences.append(Sentence(tuple(current)))
            current = []
    if current:
        sentences.append(Sentence(tuple(current)))
    return sentences


def normalize_text(s: str) -> str:
    s = _NOT_WORDISH.sub("", s.lower().replace("_", ""))
    s = _EDGE_APOSTROPHES.sub("", s)
    s = _DIGITS.sub(lambda m: num2words(int(m.group())), s)
    return " ".join(s.split())
