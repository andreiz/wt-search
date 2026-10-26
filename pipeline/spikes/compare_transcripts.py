"""Check that walnut's transcripts match wick's closely enough (spec 2026-10-26 §5). Mac only.

    cd pipeline
    uv run python spikes/compare_transcripts.py --remote https://transcribe.home.zmievski.org 71 300 613
    uv run python spikes/compare_transcripts.py --local 71
    uv run python spikes/compare_transcripts.py --files wick.json walnut.json

`--remote URL EP [EP...]` uploads each episode's stored MP3 to transcribe-web at URL (the same
call `wts transcribe` makes, with the prompt wick used: the committed vocab.txt matching the
transcript's `vocab_sha256`, since a different prompt alone changes segmentation), compares the result with the
episode's existing transcript JSON and prints one line per episode:

    ep071: words 99.6% same, segments 412 vs 409 (-0.7%), start Δ median 0.02 s p99 0.31 s: OK

`--local EP [EP...]` does the same on this Mac instead (the call `wts transcribe --local` makes),
which measures how much a fresh run differs from the stored one on the same machine. Whisper
retries an unsure window by random sampling, so two runs are not identical; walnut's difference
from wick is only meaningful next to that.

The new JSON goes to a scratch folder (`--out DIR`, default a new temp folder), whose path is
printed. Nothing else is written: state.db is opened read-only and no transcript is touched.
`--files A.json B.json` compares two existing files without transcribing.

Thresholds (spec §5): at least 99% of words the same by alignment, segment count within 2%, word
start times within 0.05 s at the median and 0.5 s at the 99th percentile. Exits 1 if any episode
misses one, and says which. If it does, stop and look before the backlog run.
"""

import argparse
import dataclasses
import difflib
import json
import math
import re
import sqlite3
import statistics
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from wts.transcribe import VOCAB_FILE, build_initial_prompt

MIN_WORD_MATCH = 0.99
MAX_SEGMENT_DRIFT = 0.02
MAX_MEDIAN_DT = 0.05
MAX_P99_DT = 0.5


@dataclass
class Comparison:
    word_match: float  # matched words / the longer word list
    seg_a: int
    seg_b: int
    median_dt: float  # seconds, over the start times of words in matching blocks
    p99_dt: float

    @property
    def seg_drift(self) -> float:
        return (self.seg_b - self.seg_a) / self.seg_a if self.seg_a else float("inf")

    def misses(self) -> list[str]:
        out = []
        if self.word_match < MIN_WORD_MATCH:
            out.append(f"words {self.word_match:.1%} < {MIN_WORD_MATCH:.0%}")
        if abs(self.seg_drift) > MAX_SEGMENT_DRIFT:
            out.append(f"segments {self.seg_drift:+.1%} beyond ±{MAX_SEGMENT_DRIFT:.0%}")
        if self.median_dt > MAX_MEDIAN_DT:
            out.append(f"median Δ {self.median_dt:.2f} s > {MAX_MEDIAN_DT} s")
        if self.p99_dt > MAX_P99_DT:
            out.append(f"p99 Δ {self.p99_dt:.2f} s > {MAX_P99_DT} s")
        return out

    def line(self, label: str) -> str:
        verdict = "OK" if not self.misses() else "FAIL (" + "; ".join(self.misses()) + ")"
        return (f"{label}: words {self.word_match:.1%} same, segments {self.seg_a} vs {self.seg_b} "
                f"({self.seg_drift:+.1%}), start Δ median {self.median_dt:.2f} s "
                f"p99 {self.p99_dt:.2f} s: {verdict}")


def normalise(word: str) -> str:
    return re.sub(r"[^\w]", "", word.strip().lower())


def word_list(segments: list[dict]) -> list[tuple[str, float]]:
    """(normalised word, start) for every word that has something left after normalising."""
    out = []
    for seg in segments:
        for w in seg.get("words") or []:
            token = normalise(w["word"])
            if token:
                out.append((token, float(w["start"])))
    return out


def percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    return sorted_values[max(0, math.ceil(q * len(sorted_values)) - 1)]


def compare(a: list[dict], b: list[dict]) -> Comparison:
    wa, wb = word_list(a), word_list(b)
    matcher = difflib.SequenceMatcher(None, [t for t, _ in wa], [t for t, _ in wb], autojunk=False)
    dts = sorted(
        abs(wa[block.a + i][1] - wb[block.b + i][1])
        for block in matcher.get_matching_blocks()
        for i in range(block.size)
    )
    matched = len(dts)
    longest = max(len(wa), len(wb))
    return Comparison(
        word_match=matched / longest if longest else 1.0,
        seg_a=len(a),
        seg_b=len(b),
        median_dt=statistics.median(dts) if dts else 0.0,
        p99_dt=percentile(dts, 0.99),
    )


def _clock(t: float) -> str:
    m, s = divmod(int(t), 60)
    return f"{m // 60}:{m % 60:02d}:{s:02d}"


def _clip(words: list[str], limit: int = 300) -> str:
    text = " ".join(words) or "(nothing)"
    return text if len(text) <= limit else text[: limit - 1] + "…"


def differences(a: list[dict], b: list[dict], n: int) -> list[str]:
    """The n longest stretches where A and B disagree, in time order, with both texts."""
    wa, wb = word_list(a), word_list(b)
    shown_a = [w["word"].strip() for s in a for w in s.get("words") or [] if normalise(w["word"])]
    shown_b = [w["word"].strip() for s in b for w in s.get("words") or [] if normalise(w["word"])]
    matcher = difflib.SequenceMatcher(None, [t for t, _ in wa], [t for t, _ in wb], autojunk=False)
    ops = [op for op in matcher.get_opcodes() if op[0] != "equal"]
    ops.sort(key=lambda op: max(op[2] - op[1], op[4] - op[3]), reverse=True)
    out = []
    for _, i1, i2, j1, j2 in sorted(ops[:n], key=lambda op: op[1]):
        # Each side's own time: an inserted or replaced stretch can sit seconds apart in the two.
        at_a = wa[min(i1, len(wa) - 1)][1] if wa else 0.0
        at_b = wb[min(j1, len(wb) - 1)][1] if wb else 0.0
        out.append(f"  A {_clock(at_a)} ({i2 - i1} words): {_clip(shown_a[i1:i2])}")
        out.append(f"  B {_clock(at_b)} ({j2 - j1} words): {_clip(shown_b[j1:j2])}")
    return out


def load_segments(path: Path) -> list[dict]:
    return json.loads(path.read_text())["segments"]


def find_transcript(transcripts_dir: Path, number: int) -> Path:
    pattern = f"*_ep{number:03d}_*.json"
    matches = sorted(transcripts_dir.glob(pattern))
    if len(matches) != 1:
        raise SystemExit(f"{len(matches)} transcripts match {pattern!r} in {transcripts_dir}")
    return matches[0]


def audio_for(state_db: Path, number: int) -> Path:
    conn = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "select audio_path from episodes where number = ?", (number,)
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        raise SystemExit(f"episode {number} has no audio_path in {state_db}")
    audio = Path(row[0])
    if not audio.is_file():
        raise SystemExit(f"episode {number}: audio file {audio} is missing")
    return audio


def prompt_for(meta: dict) -> tuple[str, str]:
    """The Whisper prompt wick used: the committed vocab.txt whose sha256 the transcript records.

    vocab.txt changes as corrections are added, and a different prompt alone changes how Whisper
    splits segments, so comparing against today's prompt doesn't isolate the machine. Falls back
    to today's vocab.txt (and says so) when no committed version matches.
    """
    import hashlib
    import subprocess

    def git(*args: str) -> bytes:
        return subprocess.run(["git", *args], capture_output=True, check=True,
                              cwd=VOCAB_FILE.parent).stdout

    want = meta.get("vocab_sha256")
    top = Path(git("rev-parse", "--show-toplevel").decode().strip())
    rel = VOCAB_FILE.relative_to(top)
    for rev in git("log", "--format=%h", "--", str(VOCAB_FILE)).decode().split():
        raw = git("show", f"{rev}:{rel}")
        if hashlib.sha256(raw).hexdigest() == want:
            with tempfile.NamedTemporaryFile("wb", suffix=".txt", delete=False) as f:
                f.write(raw)
            prompt, _ = build_initial_prompt(Path(f.name))
            Path(f.name).unlink()
            return prompt, f"vocab.txt at {rev}"
    prompt, _ = build_initial_prompt(VOCAB_FILE)
    return prompt, "today's vocab.txt (no committed version matches the transcript)"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", metavar="URL", help="transcribe-web base URL")
    parser.add_argument("--local", action="store_true", help="transcribe on this Mac instead")
    parser.add_argument("episodes", nargs="*", type=int,
                        help="episode numbers (with --remote or --local)")
    parser.add_argument("--files", nargs=2, metavar=("A", "B"), help="compare two transcript JSONs")
    parser.add_argument("--out", help="folder for the new JSON (default: a new temp folder)")
    parser.add_argument("--show", type=int, default=0, metavar="N",
                        help="also print the N longest stretches where the two disagree")
    args = parser.parse_args()

    if args.files:
        a, b = (Path(p) for p in args.files)
        seg_a, seg_b = load_segments(a), load_segments(b)
        result = compare(seg_a, seg_b)
        print(result.line(f"{a.name} vs {b.name}"))
        if args.show:
            print("\n".join(differences(seg_a, seg_b, args.show)))
        sys.exit(1 if result.misses() else 0)
    if bool(args.remote) == args.local or not args.episodes:
        parser.error("give --remote URL EP [EP...], --local EP [EP...] or --files A.json B.json")

    from wts.config import load_config
    from wts.paths import resolve_paths

    if args.remote:
        from wts.transcribe_remote import RemoteTranscriber

        transcriber = RemoteTranscriber(args.remote)
        where = "walnut"
    else:
        from wts.transcribe import MlxWhisperTranscriber

        transcriber = MlxWhisperTranscriber()
        where = "local"

    paths = resolve_paths(load_config(resolve_paths().config_file))
    out_dir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix=f"{where}-transcripts-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"new JSON goes to {out_dir}")

    failed = False
    for number in args.episodes:
        label = f"ep{number:03d}"
        wick_path = find_transcript(paths.transcripts_dir, number)
        wick = json.loads(wick_path.read_text())
        prompt, source = prompt_for(wick.get("meta", {}))
        print(f"{label}: prompt from {source}", flush=True)
        raw = transcriber.transcribe(audio_for(paths.state_db, number), prompt)
        segments = [dataclasses.asdict(s) for s in raw.segments]
        (out_dir / wick_path.name).write_text(
            json.dumps({"meta": wick.get("meta", {}) | {"model_version": raw.model_version,
                                                         "model": raw.model},
                        "segments": segments}, ensure_ascii=False)
        )
        result = compare(wick["segments"], segments)
        print(result.line(label), flush=True)
        if args.show:
            print("\n".join(differences(wick["segments"], segments, args.show)), flush=True)
        failed |= bool(result.misses())
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
