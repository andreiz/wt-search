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
# ".com", and the ".m." of "a.m.": a dot and a letter is never the start of a word.
_DOT_TAIL = re.compile(r"^\.[^\W\d_]")
# A clock time Whisper wrote as "four 30": the hour as a word, the minutes as two digits.
_HOURS = {w: i for i, w in enumerate(
    ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
     "twelve"], start=1)}
_MINUTES = re.compile(r"^([0-5]\d)([,.?!]*)$")
_AM_PM = re.compile(r"^(?:[AaPp]\.[Mm]\.?|[AP]M)[,.?!]*$")
_CLOCK = re.compile(r"^\d{1,2}:\d\d$")
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
    return bool(_HYPHEN_TAIL.match(text) or _DOT_TAIL.match(text)
                or (_NUMBER_TAIL.match(text) and _ENDS_IN_DIGIT.search(prev)))


def join_split_words(words: Sequence[Word]) -> list[Word]:
    """Rejoin words that Whisper's word timings split in two (spec §3.3).

    "split-top" comes out as "split" and "-top", so chunk text read "split -top"; numbers
    likewise ("22" ".5", "45" ",000", "10" "%"). Joined to the word before it, keeping one word
    per timing (the first half's start): a word that starts with `-` and a letter or digit,
    one that starts with `.` and a letter ("woodcraft" ".com", "a" ".m."), and, after a word ending in a digit, one that starts with `.` or `,` and a digit, or `%`.
    A dash or comma on its own is punctuation and stays; nothing is joined across a sentence
    end.
    """
    return [joined for joined, _ in joined_words(words)]


def joined_words(words: Sequence[Word]) -> list[tuple[Word, list[Word]]]:
    """`join_split_words`, with the words each result was joined from (one, for most).

    The review page needs the parts: a correction is matched before the join, so a rule for
    "three-eighths" must name its two words, "three" and "-eighths".
    """
    out: list[tuple[Word, list[Word]]] = []
    for w in words:
        prev = out[-1][0] if out else None
        if prev and _is_tail(prev.text, w.text):
            joined = Word(prev.text + w.text, prev.start_ms, max(prev.end_ms, w.end_ms),
                          min(prev.prob, w.prob))
            out[-1] = (joined, [*out[-1][1], w])
        else:
            out.append((w, [w]))
    return _join_clock_times(out)


def _join_clock_times(
    words: list[tuple[Word, list[Word]]],
) -> list[tuple[Word, list[Word]]]:
    """Make "four 30" one word, "4:30", where the words around it say it is a clock time.

    Only then: "the DW seven 35" is a planer and "starts at four 49" a price (both real). The
    signs are a.m./p.m. after it ("nine 30 a.m."), "from" before and "to" after ("from four 30
    to 9 PM"), or "to" before with a clock time before that ("from five 30 to six 30").
    """
    out: list[tuple[Word, list[Word]]] = []
    i = 0
    while i < len(words):
        w, parts = words[i]
        hour = _HOURS.get(w.text.lower())
        minutes = _MINUTES.match(words[i + 1][0].text) if hour and i + 1 < len(words) else None
        if minutes:
            before = out[-1][0].text.lower() if out else ""
            after = words[i + 2][0].text if i + 2 < len(words) else ""
            is_time = bool(
                (not minutes.group(2) and _AM_PM.match(after))
                or (before == "from" and not minutes.group(2) and after.lower() == "to")
                or (before == "to" and len(out) > 1 and _CLOCK.match(out[-2][0].text))
            )
            if is_time:
                m, m_parts = words[i + 1]
                joined = Word(f"{hour}:{minutes.group(1)}{minutes.group(2)}", w.start_ms,
                              max(w.end_ms, m.end_ms), min(w.prob, m.prob))
                out.append((joined, [*parts, *m_parts]))
                i += 2
                continue
        out.append((w, parts))
        i += 1
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
