"""Finding Whisper's skipped passages: speech the transcript has no words for.

Spec 2026-10-26 transcript repair §5.1. Whisper sometimes writes a short phrase, loses its place
and carries on seconds later; the words in between never reach search. Such a hole shows up as
time where the audio has speech (from a voice-activity detector) but no word covers it.

A word counts as covering at most `WORD_COVER_MS` plus `PAD_MS` after it: Whisper often hides a
skip by stretching one word across it. All times are milliseconds.
"""

from collections.abc import Sequence

from wts.words import Word

Span = tuple[int, int]  # (start_ms, end_ms), start < end

WORD_COVER_MS = 1000
PAD_MS = 300
MIN_HOLE_MS = 1500
JOIN_MS = 5000
_PIECE_JOIN_MS = 500  # speech pieces this close are one stretch before the length test


def uncovered(words: Sequence[Word]) -> list[Span]:
    """Stretches between the first and last word that no word covers."""
    out: list[Span] = []
    reach: int | None = None
    for w in words:
        end = min(w.end_ms, w.start_ms + WORD_COVER_MS) + PAD_MS
        if reach is not None and w.start_ms > reach:
            out.append((reach, w.start_ms))
        reach = end if reach is None else max(reach, end)
    return out


def _intersect(a: Sequence[Span], b: Sequence[Span]) -> list[Span]:
    out: list[Span] = []
    i = j = 0
    while i < len(a) and j < len(b):
        start, end = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if start < end:
            out.append((start, end))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def _join(spans: Sequence[Span], gap_ms: int) -> list[Span]:
    out: list[list[int]] = []
    for start, end in spans:
        if out and start - out[-1][1] <= gap_ms:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(s, e) for s, e in out]


def find_holes(
    words: Sequence[Word],
    speech: Sequence[Span],
    min_ms: int = MIN_HOLE_MS,
    join_ms: int = JOIN_MS,
) -> list[Span]:
    """Speech no word covers, in stretches of at least `min_ms`; those within `join_ms` of each
    other are one flag (one place to look at)."""
    pieces = _join(_intersect(uncovered(words), sorted(speech)), _PIECE_JOIN_MS)
    return _join([p for p in pieces if p[1] - p[0] >= min_ms], join_ms)


def speech_between(speech: Sequence[Span], span: Span) -> int:
    """Milliseconds of speech inside `span`."""
    return sum(max(0, min(e, span[1]) - max(s, span[0])) for s, e in speech)
