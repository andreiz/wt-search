"""Timed words, sentences, and text normalization shared by cleanup and chunking."""

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
# A second half that Whisper's word timings split off: "-top", ".5", ",000", "%".
_HYPHEN_TAIL = re.compile(r"^-\w")
_NUMBER_TAIL = re.compile(r"^(?:[.,]\d|%)")
_ENDS_IN_DIGIT = re.compile(r"\d$")


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


def _is_tail(prev: str, text: str) -> bool:
    if _ends_sentence(prev):
        return False
    return bool(_HYPHEN_TAIL.match(text)
                or (_NUMBER_TAIL.match(text) and _ENDS_IN_DIGIT.search(prev)))


def join_split_words(words: Sequence[Word]) -> list[Word]:
    """Rejoin words that Whisper's word timings split in two (spec §3.3).

    "split-top" comes out as "split" and "-top", so chunk text read "split -top"; numbers
    likewise ("22" ".5", "45" ",000", "10" "%"). Joined to the word before it, keeping one word
    per timing (the first half's start): a word that starts with `-` and a letter or digit,
    and, after a word ending in a digit, one that starts with `.` or `,` and a digit, or `%`.
    A dash or comma on its own is punctuation and stays; nothing is joined across a sentence
    end.
    """
    out: list[Word] = []
    for w in words:
        prev = out[-1] if out else None
        if prev and _is_tail(prev.text, w.text):
            out[-1] = Word(prev.text + w.text, prev.start_ms, max(prev.end_ms, w.end_ms),
                           min(prev.prob, w.prob))
        else:
            out.append(w)
    return out


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
