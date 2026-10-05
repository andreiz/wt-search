"""Sentence-aligned ~30 s chunks with per-word timings (spec §3.2 `wts chunk`, §4.1)."""

from collections.abc import Sequence
from dataclasses import dataclass

from wts.words import Sentence, Word

TARGET_MS = 30_000
MAX_MS = 45_000
BOILERPLATE_SHARE = 0.6


@dataclass(frozen=True)
class Chunk:
    seq: int
    start_ms: int
    end_ms: int
    text: str
    word_times: str
    is_boilerplate: bool


def encode_word_times(starts_ms: Sequence[int], chunk_start_ms: int) -> str:
    deltas, previous = [], chunk_start_ms
    for s in starts_ms:
        deltas.append(s - previous)
        previous = s
    return ",".join(str(d) for d in deltas)


def decode_word_times(s: str, chunk_start_ms: int) -> list[int]:
    starts, current = [], chunk_start_ms
    for d in s.split(","):
        current += int(d)
        starts.append(current)
    return starts


@dataclass(frozen=True)
class _Unit:
    words: tuple[Word, ...]
    boilerplate: bool


def _span(units: Sequence[_Unit]) -> int:
    return units[-1].words[-1].end_ms - units[0].words[0].start_ms + 1


def _units(sentences: Sequence[Sentence], boilerplate: Sequence[bool], max_ms: int) -> list[_Unit]:
    """Sentences, with any sentence longer than max_ms split at word boundaries."""
    units: list[_Unit] = []
    for sentence, flag in zip(sentences, boilerplate, strict=True):
        piece: list[Word] = []
        for w in sentence.words:
            if piece and w.end_ms - piece[0].start_ms + 1 > max_ms:
                units.append(_Unit(tuple(piece), flag))
                piece = []
            piece.append(w)
        if piece:
            units.append(_Unit(tuple(piece), flag))
    return units


def _chunk(seq: int, units: Sequence[_Unit]) -> Chunk:
    words = [w for u in units for w in u.words]
    if any(not w.text or len(w.text.split()) != 1 for w in words):
        # word_times needs exactly one entry per space-separated token of the chunk text.
        raise ValueError(f"chunk {seq}: words must be single non-empty tokens")
    start = words[0].start_ms
    boiler_words = sum(len(u.words) for u in units if u.boilerplate)
    return Chunk(
        seq=seq,
        start_ms=start,
        end_ms=words[-1].end_ms,
        text=" ".join(w.text for w in words),
        word_times=encode_word_times([w.start_ms for w in words], start),
        is_boilerplate=boiler_words / len(words) >= BOILERPLATE_SHARE,
    )


def build_chunks(
    sentences: Sequence[Sentence],
    boilerplate: Sequence[bool],
    target_ms: int = TARGET_MS,
    max_ms: int = MAX_MS,
) -> list[Chunk]:
    units = _units(sentences, boilerplate, max_ms)
    chunks: list[Chunk] = []
    start = 0
    while start < len(units):
        end = start
        while (
            end + 1 < len(units)
            and _span(units[start : end + 1]) < target_ms
            and _span(units[start : end + 2]) <= max_ms
        ):
            end += 1
        chunks.append(_chunk(len(chunks), units[start : end + 1]))
        if end == len(units) - 1:
            break
        # Overlap by one sentence, unless the next chunk would then hold nothing but that
        # sentence (it's long on its own, or can't share a chunk with the next one).
        overlap_fits = (
            end > start
            and _span(units[end : end + 1]) < target_ms
            and _span(units[end : end + 2]) <= max_ms
        )
        start = end if overlap_fits else end + 1
    return chunks
