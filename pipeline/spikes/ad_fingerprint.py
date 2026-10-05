"""SPIKE (throwaway): can audio fingerprints find Acast's inserted ads?

Hypothesis: an inserted ad is the *identical recording* stitched into many episodes, while
host-read sponsor spots are recorded fresh each episode. So audio shared between episodes,
but never present in an ad-free copy (file length ≈ feed length), should be exactly the
inserted ads. Self-check: per episode, detected ad seconds ≈ file length − feed length.

Run on the Mac (after `wts download`):
    brew install chromaprint
    cd pipeline && uv run python spikes/ad_fingerprint.py              # across all seed episodes
    uv run python spikes/ad_fingerprint.py --pair AD_FREE.mp3 AD.mp3   # two copies, one episode

Not part of the pipeline; delete once the question is answered.
"""

import json
import sqlite3
import subprocess
from collections import defaultdict

from wts.config import load_config
from wts.paths import resolve_paths

AD_FREE_SLACK_S = 5
MIN_SEGMENT_S = 8.0  # shared audio shorter than this is ignored
MAX_GAP_S = 1.0  # tolerate small gaps in a matching run
MIN_HITS = 20  # exact fingerprint matches needed on one alignment
COMMON_VALUE_LIMIT = 40  # fingerprint values seen more often than this are noise/silence
BER_BITS = 10  # smoothed bit errors (of 32) at or below this count as the same audio
SMOOTH_S = 5.0  # average bit errors over this window


def fingerprint(path: str) -> tuple[float, list[int]]:
    # Acast stitches ads encoded differently from the episode (sample rate/channels change
    # mid-file), which fpcalc can't read. Decode to one uniform WAV with ffmpeg first.
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        subprocess.run(
            ["ffmpeg", "-loglevel", "fatal", "-y", "-i", path, "-ac", "1", "-ar", "22050",
             wav.name],
            check=True,
        )
        out = subprocess.run(
            ["fpcalc", "-raw", "-json", "-length", "0", wav.name],
            capture_output=True, text=True, check=True,
        )
    data = json.loads(out.stdout)
    return float(data["duration"]), data["fingerprint"]


def runs(positions: list[int], max_gap: int, min_len: int) -> list[tuple[int, int]]:
    positions.sort()
    found, start, prev = [], positions[0], positions[0]
    for p in positions[1:]:
        if p - prev > max_gap:
            if prev - start >= min_len:
                found.append((start, prev))
            start = p
        prev = p
    if prev - start >= min_len:
        found.append((start, prev))
    return found


def union(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for s, e in sorted(intervals):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def subtract(a: list[tuple[float, float]], b: list[tuple[float, float]]):
    out = []
    for s, e in a:
        pieces = [(s, e)]
        for bs, be in b:
            pieces = [
                piece
                for ps, pe in pieces
                for piece in ((ps, min(pe, bs)), (max(ps, be), pe))
                if piece[1] - piece[0] > 0.5
            ]
        out += pieces
    return out


def mmss(seconds: float) -> str:
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def compare_pair(ad_free_path: str, ad_path: str) -> list[tuple[float, float]]:
    """Two copies of one episode: where in the ad copy is audio missing from the ad-free one?

    Prints each matching stretch with its offset (ad-copy time − show time); the offset
    steps up by each inserted ad's length. Returns the inserted spans in ad-copy time.
    """
    import numpy as np

    free_duration, free_fp = fingerprint(ad_free_path)
    ad_duration, ad_fp = fingerprint(ad_path)
    step = free_duration / len(free_fp)
    ad = np.array(ad_fp, dtype=np.uint32)
    free = np.array(free_fp, dtype=np.uint32)
    print(f"ad-free {free_duration:.1f}s, ad copy {ad_duration:.1f}s, "
          f"difference {ad_duration - free_duration:.1f}s, item {step:.4f}s\n")

    # Inserted ads can only push the ad copy later: scan every offset from a little below 0
    # to the length difference (+ margin), scoring each position by the bit error count
    # averaged over a ~5 s window. Speech fingerprints rarely match exactly, so no voting.
    table = np.array([i.bit_count() for i in range(1 << 16)], dtype=np.uint8)
    window = max(1, round(SMOOTH_S / step))
    kernel = np.ones(window) / window
    best = np.full(len(ad), 32.0)
    best_offset = np.zeros(len(ad), dtype=np.int64)
    lo_off = -round(5 / step)
    hi_off = round((ad_duration - free_duration + 15) / step)
    for o in range(lo_off, hi_off + 1):
        lo, hi = max(0, o), min(len(ad), len(free) + o)
        if hi - lo < window:
            continue
        xor = ad[lo:hi] ^ free[lo - o : hi - o]
        bits = table[xor & 0xFFFF].astype(np.float64) + table[xor >> 16]
        # Average only over real items: zero-padding at the edges would fake a match there.
        smooth = np.convolve(bits, kernel, mode="same") / np.convolve(
            np.ones_like(bits), kernel, mode="same"
        )
        better = smooth < best[lo:hi]
        best[lo:hi][better] = smooth[better]
        best_offset[lo:hi][better] = o

    pct = np.percentile(best, [5, 25, 50, 75, 95])
    print("best bit-error per position (of 32; same audio ≈ low, unrelated ≈ 14–16):")
    print("  p5 {:.1f}  p25 {:.1f}  median {:.1f}  p75 {:.1f}  p95 {:.1f}".format(*pct))
    is_show = best <= BER_BITS

    print(f"\noffset steps (ad-copy time − show time), where bit error ≤ {BER_BITS}:")
    previous = None
    for i in np.flatnonzero(is_show):
        o = int(best_offset[i])
        if previous is None or abs(o - previous) > round(1 / step):
            print(f"  from {mmss(i * step)}: {o * step:+7.1f}s")
            previous = o
    inserted, start = [], None
    for i, show in enumerate(np.append(is_show, True)):
        if not show and start is None:
            start = i
        elif show and start is not None:
            if inserted and start * step - inserted[-1][1] <= 1.5:
                inserted[-1] = (inserted[-1][0], i * step)  # bridge a brief false match
            else:
                inserted.append((start * step, i * step))
            start = None
    inserted = [(s, e) for s, e in inserted if e - s >= 3]
    print("\ninserted (ad-copy time):", ", ".join(f"{mmss(s)}–{mmss(e)} ({e - s:.0f}s)"
                                               for s, e in inserted) or "none")
    print(f"total inserted: {sum(e - s for s, e in inserted):.0f}s")
    return inserted


def main() -> None:
    import sys

    if len(sys.argv) == 4 and sys.argv[1] == "--pair":
        compare_pair(sys.argv[2], sys.argv[3])
        return
    paths = resolve_paths(load_config(resolve_paths().config_file))
    conn = sqlite3.connect(paths.state_db)
    conn.row_factory = sqlite3.Row
    episodes = conn.execute(
        "select stem, audio_path, audio_duration_s, duration_s from episodes "
        "where in_scope = 1 and audio_path is not null order by published_at"
    ).fetchall()
    print(f"fingerprinting {len(episodes)} episodes …")
    fps, item_s = [], []
    for ep in episodes:
        duration, fp = fingerprint(ep["audio_path"])
        fps.append(fp)
        item_s.append(duration / len(fp))
    step = sum(item_s) / len(item_s)
    ad_free = [
        ep["duration_s"] is not None and ep["audio_duration_s"] <= ep["duration_s"] + AD_FREE_SLACK_S
        for ep in episodes
    ]
    print(f"item = {step:.4f} s; ad-free copies: {sum(ad_free)} of {len(episodes)}")

    index: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for e, fp in enumerate(fps):
        for pos, value in enumerate(fp):
            index[value].append((e, pos))
    votes: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    for hits in index.values():
        if len(hits) > COMMON_VALUE_LIMIT:
            continue
        for i, (a, pa) in enumerate(hits):
            for b, pb in hits[i + 1 :]:
                if a != b:
                    votes[(a, b, pa - pb)].append(pa)

    shared = defaultdict(list)  # episode -> [(start_s, end_s, partner)]
    max_gap, min_len = round(MAX_GAP_S / step), round(MIN_SEGMENT_S / step)
    for (a, b, offset), positions in votes.items():
        if len(positions) < MIN_HITS:
            continue
        for s, e in runs(positions, max_gap, min_len):
            shared[a].append((s * step, e * step, b))
            shared[b].append(((s - offset) * step, (e - offset) * step, a))

    errors = []
    print(f"\n{'episode':58} {'expected':>8} {'found':>6}  segments (inserted-ad candidates)")
    for e, ep in enumerate(episodes):
        show = union([(s, t) for s, t, p in shared[e] if ad_free[p] or ad_free[e]])
        candidates = union([(s, t) for s, t, p in shared[e] if not ad_free[p]])
        ads = subtract(candidates, show) if not ad_free[e] else []
        found = sum(t - s for s, t in ads)
        expected = (ep["audio_duration_s"] or 0) - (ep["duration_s"] or 0)
        if not ad_free[e]:
            errors.append(found - expected)
        segs = ", ".join(f"{mmss(s)}–{mmss(t)}" for s, t in ads[:6])
        print(f"{ep['stem'][:58]:58} {expected:8.0f} {found:6.0f}  {segs}")
    if errors:
        mae = sum(abs(x) for x in errors) / len(errors)
        print(f"\nmean |found − expected| over ad-laden copies: {mae:.0f} s")


if __name__ == "__main__":
    main()
