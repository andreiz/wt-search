"""SPIKE (throwaway): find the pre-roll length of an ad-laden copy by locating the show's sting.

Finding (2026-10-05): every episode from 2014 on opens with the same ~2 s sting at show time
0:00 (identical 2020–2026; a close variant 2014–2017; none 2007–2013). Acast puts pre-roll ads
before it, so where the sting sits in an ad-laden copy is the pre-roll length.

Templates are the first STING_S seconds of ad-free copies (file length ≈ feed length); pass a
few from different eras and the best match wins. Search covers 0 … (extra + margin) seconds,
where extra = file length − feed length (the total of inserted ads).

Run on the Mac (after `wts download`):
    brew install chromaprint
    cd pipeline && uv run python spikes/preroll_finder.py                 # ad-laden seed eps
    uv run python spikes/preroll_finder.py --files AD.mp3:EXTRA_S ...     # ad-hoc files
Templates default to the seed's ad-free copies; override with --stings A.mp3 B.mp3 ...

Result (spikes/preroll_finder_results.txt): pre-roll exact (±0.4 s) on all 34 ad copies from
2014–2026, but 20 of 41 copies also carry mid-rolls, so the pre-roll alone isn't the timeline.

Not part of the pipeline; delete once the question is answered.
"""

import argparse
import json
import sqlite3
import subprocess
import tempfile

import numpy as np

STING_S = 2.0  # length of the shared opening
MATCH_BITS = 6.0  # mean bit error (of 32) at or below this is the sting; unrelated ≈ 13–16
MARGIN_S = 5.0
AD_FREE_SLACK_S = 5
# Chromaprint item: 4096-sample frames at 11025 Hz, 2/3 overlap. (fpcalc's duration/items is
# far off on short clips, so don't derive it.)
ITEM_S = 4096 / 3 / 11025
TABLE = np.array([i.bit_count() for i in range(1 << 16)], dtype=np.uint8)


def fingerprint(path: str, length: float | None = None) -> np.ndarray:
    """Chromaprint items of the first `length` seconds (one per ITEM_S)."""
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        cmd = ["ffmpeg", "-loglevel", "fatal", "-y", "-i", path]
        if length:
            cmd += ["-t", f"{length:.1f}"]
        # Decode first: Acast-stitched files can change format mid-file, which fpcalc rejects.
        subprocess.run(cmd + ["-ac", "1", "-ar", "22050", wav.name], check=True)
        out = subprocess.run(["fpcalc", "-raw", "-json", "-length", "0", wav.name],
                             capture_output=True, text=True, check=True)
    return np.array(json.loads(out.stdout)["fingerprint"], dtype=np.uint32)


def bit_errors(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    x = a ^ b
    return TABLE[x & 0xFFFF].astype(np.float64) + TABLE[x >> 16]


def find_sting(path: str, stings: list[np.ndarray], search_s: float):
    """(pre-roll seconds, mean bit error there, best bit error > 3 s away) or None."""
    step = ITEM_S
    n = round(STING_S / step)
    head = fingerprint(path, search_s + STING_S + 5)
    scores = np.full(max(0, len(head) - n + 1), 32.0)
    for sting in stings:
        for o in range(len(scores)):
            scores[o] = min(scores[o], bit_errors(sting[:n], head[o : o + n]).mean())
    if not len(scores):
        return None
    hits = np.flatnonzero(scores <= MATCH_BITS)
    # Earliest match: an ad can't contain the sting, but the show may repeat it later on.
    o = int(hits[0]) if len(hits) else int(scores.argmin())
    o = o + int(scores[o : o + round(1 / step)].argmin())  # settle on the local minimum
    far = np.abs(np.arange(len(scores)) - o) > round(3 / step)
    runner_up = float(scores[far].min()) if far.any() else 32.0
    return o * step, float(scores[o]), runner_up


def mmss(seconds: float) -> str:
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stings", nargs="*", help="ad-free copies to take the sting from")
    parser.add_argument("--files", nargs="*", help="AD.mp3:EXTRA_S pairs to search")
    args = parser.parse_args()

    if args.files is None or args.stings is None:
        from wts.config import load_config
        from wts.paths import resolve_paths

        paths = resolve_paths(load_config(resolve_paths().config_file))
        conn = sqlite3.connect(paths.state_db)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "select stem, audio_path, audio_duration_s, duration_s from episodes "
            "where in_scope = 1 and audio_path is not null and duration_s is not null "
            "order by published_at desc"
        ).fetchall()
        extra = {r["audio_path"]: r["audio_duration_s"] - r["duration_s"] for r in rows}
        if args.stings is None:
            args.stings = [p for p, x in extra.items() if x <= AD_FREE_SLACK_S]
        if args.files is None:
            args.files = [f"{p}:{x}" for p, x in extra.items() if x > AD_FREE_SLACK_S]

    # Each item spans ~2 s of audio, so take more than the sting (only the first items are used).
    stings = [fingerprint(path, STING_S + 5) for path in args.stings]
    print(f"{len(stings)} sting templates, {len(args.files)} ad-laden copies\n")
    print(f"{'file':60} {'extra':>6} {'pre-roll':>8} {'bits':>5} {'next':>5}  rest (post/mid)")
    for spec in args.files:
        path, extra_s = spec.rsplit(":", 1)
        extra_s = float(extra_s)
        found = find_sting(path, stings, extra_s + MARGIN_S)
        name = path.rsplit("/", 1)[-1][:60]
        if found is None:
            print(f"{name:60} {extra_s:6.1f}  (file too short)")
            continue
        pre, bits, runner_up = found
        flag = "" if bits <= MATCH_BITS else "  NO STING"
        print(f"{name:60} {extra_s:6.1f} {pre:8.1f} {bits:5.1f} {runner_up:5.1f}  "
              f"{extra_s - pre:6.1f}{flag}")


if __name__ == "__main__":
    main()
