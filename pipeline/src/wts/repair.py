"""Proposed repairs: what a fresh pass over a short clip has where the transcript has a hole.

Spec 2026-10-26 transcript repair §5.2. The clip runs from `CLIP_PAD_MS` before a hole to
`CLIP_PAD_MS` after it and is transcribed on its own, with the vocabulary prompt but none of the
episode's earlier text: Whisper's skips come from getting stuck partway through an episode, and
a fresh start on a short clip usually doesn't hit the same trap. All times are milliseconds.
"""

import subprocess
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from wts.guards import _has_loop, clean_transcript
from wts.holes import Span
from wts.transcribe import RawTranscript
from wts.words import Word, normalize_text

CLIP_PAD_MS = 10_000
SECOND_PASS_SHIFT_MS = 5_000
MIN_NEW_WORDS = 3
MATCH_MS = 2_000  # words on the two sides can only match when said this close together
NO_RIGHT_EDGE = 2**31


@dataclass(frozen=True)
class Proposal:
    """Replace `before` (the transcript's words from position `index`) by `after`.

    `from_ms`/`to_ms` bound the stretch: the end of the word before it (-1 at the episode's
    start) and the start of the word after it (`NO_RIGHT_EDGE` at the end). The anchors count the
    matching words right next to it on each side, as the rule's first check needs.
    """

    index: int
    from_ms: int
    to_ms: int
    before: tuple[Word, ...]
    after: tuple[Word, ...]
    left_anchor: int
    right_anchor: int


def clip_span(hole: Span, duration_ms: int, shift_ms: int = 0) -> Span:
    return (max(0, hole[0] - CLIP_PAD_MS - shift_ms), min(duration_ms, hole[1] + CLIP_PAD_MS))


def clip_words(fresh: RawTranscript, clip_start_ms: int) -> list[Word]:
    """The clip's words as `wts chunk` would see them (through the guards), in episode time."""
    words, _ = clean_transcript({"segments": [asdict(s) for s in fresh.segments]}, None)
    return [
        Word(w.text, w.start_ms + clip_start_ms, w.end_ms + clip_start_ms, w.prob) for w in words
    ]


def _token(w: Word) -> str:
    return normalize_text(w.text) or w.text.lower()


Op = tuple[str, int, int, int, int]  # difflib-style (tag, i1, i2, j1, j2)


def _align(cur: Sequence[Word], fresh: Sequence[Word]) -> list[Op]:
    """Word alignment where a pair matches only if the texts agree and the words were said
    within `MATCH_MS` of each other. By text alone (difflib), a repeated phrase ("the glue …
    the glue") pairs words seconds apart, and the splice's times run backwards. A longest common
    subsequence over a clip's words (~100 a side) is cheap."""
    a, b = [_token(w) for w in cur], [_token(w) for w in fresh]
    n, m = len(a), len(b)

    def match(i: int, j: int) -> bool:
        return a[i] == b[j] and abs(cur[i].start_ms - fresh[j].start_ms) <= MATCH_MS

    best = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            best[i][j] = (best[i + 1][j + 1] + 1 if match(i, j)
                          else max(best[i + 1][j], best[i][j + 1]))
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if match(i, j) and best[i][j] == best[i + 1][j + 1] + 1:
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif best[i + 1][j] >= best[i][j + 1]:
            i += 1
        else:
            j += 1
    ops: list[Op] = []
    pi = pj = 0
    for i, j in [*pairs, (n, m)]:
        if i > pi or j > pj:
            tag = "replace" if i > pi and j > pj else ("delete" if i > pi else "insert")
            ops.append((tag, pi, i, pj, j))
        if i < n and j < m:
            if ops and ops[-1][0] == "equal":
                ops[-1] = ("equal", ops[-1][1], i + 1, ops[-1][3], j + 1)
            else:
                ops.append(("equal", i, i + 1, j, j + 1))
        pi, pj = i + 1, j + 1
    return ops


def propose(
    words: Sequence[Word], hole: Span, clip: Span, fresh: Sequence[Word]
) -> Proposal | None:
    """The fresh pass's words for the hole, if they add at least `MIN_NEW_WORDS` where the
    transcript has none or far fewer; else None."""
    first = next((k for k, w in enumerate(words) if w.start_ms >= clip[0]), len(words))
    last = next((k for k, w in enumerate(words) if w.start_ms >= clip[1]), len(words))
    cur = list(words[first:last])
    ops = _align(cur, fresh)

    def overlaps(i1: int, i2: int, j1: int, j2: int) -> bool:
        spans = [(cur[i1].start_ms, cur[i2 - 1].end_ms)] if i1 < i2 else []
        spans += [(fresh[j1].start_ms, fresh[j2 - 1].end_ms)] if j1 < j2 else []
        return any(s < hole[1] and e > hole[0] for s, e in spans)

    hit = [op for op in ops if op[0] != "equal" and overlaps(*op[1:])]
    if not hit:
        return None
    i_from, i_to, j_from, j_to = hit[0][1], hit[-1][2], hit[0][3], hit[-1][4]
    before, after = tuple(cur[i_from:i_to]), tuple(fresh[j_from:j_to])
    # Far fewer words replaced than added, unless what's replaced is a loop (holes.loops).
    loop = _has_loop([_token(w) for w in before])
    if len(after) < MIN_NEW_WORDS or (len(before) > max(1, len(after) // 4) and not loop):
        return None

    # Anchors: the matched run right next to the stretch on each side.
    k0, k1 = ops.index(hit[0]), ops.index(hit[-1])
    left = ops[k0 - 1][2] - ops[k0 - 1][1] if k0 > 0 and ops[k0 - 1][0] == "equal" else 0
    right = (ops[k1 + 1][2] - ops[k1 + 1][1]
             if k1 + 1 < len(ops) and ops[k1 + 1][0] == "equal" else 0)
    # The matching word on each side, where the fresh pass writes it differently ("Also," for
    # "also,", "grinder." for "grinder"): the transcript's capital or full stop came from the
    # skip, which made a sentence start or end there. The fresh pass heard the whole sentence,
    # so the repair takes that word in its spelling (spec §5.2).
    if left and cur[i_from - 1].text != fresh[j_from - 1].text:
        i_from, j_from = i_from - 1, j_from - 1
    if right and cur[i_to].text != fresh[j_to].text:
        i_to, j_to = i_to + 1, j_to + 1
    before, after = tuple(cur[i_from:i_to]), tuple(fresh[j_from:j_to])
    index = first + i_from
    end = first + i_to
    # A safety net behind the time-gated matching: never splice words whose times go back.
    if (index > 0 and after[0].start_ms < words[index - 1].start_ms) or (
            end < len(words) and after[-1].start_ms > words[end].start_ms):
        return None
    return Proposal(
        index=index,
        from_ms=words[index - 1].end_ms if index > 0 else -1,
        to_ms=words[end].start_ms if end < len(words) else NO_RIGHT_EDGE,
        before=before,
        after=after,
        left_anchor=left,
        right_anchor=right,
    )


def cut_clip(audio: Path, clip: Span, out: Path) -> Path:
    """The clip as a mono MP3. Re-encoded: an MP3 stream copy can only cut on frame edges.

    `aresample` changes no samples here; it hands the encoder new frames. Without it ffmpeg
    9.0.2's libmp3lame fails about one cut in 80 ("inadequate AVFrame plane padding", ep614
    1136.760-1158.400 s, 2026-10-27).
    """
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", f"{clip[0] / 1000:.3f}", "-to",
         f"{clip[1] / 1000:.3f}", "-i", str(audio), "-ac", "1", "-af", "aresample",
         "-c:a", "libmp3lame", "-b:a", "64k", str(out)],
        check=True, capture_output=True,
    )
    return out
