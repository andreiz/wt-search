"""THROWAWAY until plan 4's review tool: read raw transcripts and find likely mishearings.

    cd pipeline
    uv run python spikes/transcript_peek.py read 613 [--from 12:00] [--to 15:00]
    uv run python spikes/transcript_peek.py suspects [--top 60]

`read` prints the raw Whisper text with timestamps; words Whisper gave a probability below 0.5
are shown «like this», except short and common words (`--all` marks those too). It also prints an ffplay command to hear the audio from any point.
`suspects` ranks words across every transcript by the share of times Whisper was unsure of them
(at least 2 unsure and 25% of uses), with one example each: the usual source of corrections.yaml
and vocab.txt entries.

Raw means before `wts chunk`: corrections.yaml and the guards are not applied here.
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

LOW = 0.5
# Whisper is often unsure of short words, fillers and sentence starts ("and", "like", "yeah"),
# which don't matter for search. Only longer, less common words are marked unless --all.
COMMON = set("""
about actually also already always anyway because been being could didn does doing done
going gonna good great have here just kind know like literally maybe mean much okay only
really right said same says should so-called some something sort sure take than that thats
their them then there these they thing things think this those though through totally very
want well were what whatever when where which while will with would yeah yes your
""".split())  # noqa: SIM905 — a block of words is easier to edit than a list literal


def clean(word: str) -> str:
    return re.sub(r"[^\w'-]", "", word).lower().replace("'", "")


def worth_marking(word: str) -> bool:
    key = clean(word)
    return len(key) >= 4 and key not in COMMON


def mmss(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def seconds(text: str) -> float:
    parts = [float(p) for p in text.split(":")]
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def find(transcripts_dir: Path, which: str) -> Path:
    if Path(which).is_file():
        return Path(which)
    pattern = f"*_ep{int(which):03d}_*.json" if which.isdigit() else f"*{which}*.json"
    matches = sorted(transcripts_dir.glob(pattern))
    if len(matches) != 1:
        raise SystemExit(f"{len(matches)} transcripts match {pattern!r} in {transcripts_dir}")
    return matches[0]


def read(path: Path, audio_dir: Path | None, start: float, end: float, mark_all: bool) -> None:
    data = json.loads(path.read_text())
    meta = data["meta"]
    print(f"{meta.get('title')}  ({meta.get('published_at', '')[:10]}, {mmss(meta['duration_s'])})")
    if audio_dir is not None:
        audio = audio_dir / f"{path.stem}.mp3"
        print(f"listen: ffplay -nodisp -autoexit -ss <seconds> '{audio}'\n")
    for seg in data["segments"]:
        if seg["end"] < start or seg["start"] > end:
            continue
        words = seg.get("words") or []
        text = "".join(
            f" «{w['word'].strip()}»"
            if w["probability"] < LOW and (mark_all or worth_marking(w["word"]))
            else w["word"]
            for w in words
        ) if words else seg["text"]
        print(f"[{mmss(seg['start'])}] {text.strip()}")


def suspects(transcripts_dir: Path, top: int) -> None:
    low: Counter = Counter()
    total: Counter = Counter()
    example: dict[str, str] = {}
    episodes: defaultdict[str, set] = defaultdict(set)
    for path in sorted(transcripts_dir.glob("*.json")):
        for seg in json.loads(path.read_text())["segments"]:
            for w in seg.get("words") or []:
                if not worth_marking(w["word"]):
                    continue
                key = clean(w["word"])
                total[key] += 1
                if w["probability"] < LOW:
                    low[key] += 1
                    episodes[key].add(path.stem[:16])
                    example.setdefault(key, f"{path.stem[:16]} [{mmss(seg['start'])}] "
                                            f"{seg['text'].strip()[:90]}")
    # Common words ("like", "yeah") are often unsure but almost always right; a word Whisper is
    # unsure of most times it hears it ("marc": 8 of 9) is the interesting kind.
    ranked = sorted(
        (k for k in low if low[k] >= 2 and low[k] / total[k] >= 0.25),
        key=lambda k: (-low[k] / total[k], -low[k]),
    )
    print(f"{'word':18} {'unsure':>6} {'of':>5} {'eps':>4}  example")
    for key in ranked[:top]:
        print(f"{key:18} {low[key]:6} {total[key]:5} {len(episodes[key]):4}  {example[key]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("read")
    r.add_argument("episode", help="episode number, part of a stem, or a transcript path")
    r.add_argument("--from", dest="start", default="0")
    r.add_argument("--to", dest="end", default="99:59:59")
    r.add_argument("--all", dest="mark_all", action="store_true",
                   help="mark every unsure word, including short and common ones")
    s = sub.add_parser("suspects")
    s.add_argument("--top", type=int, default=60)
    s.add_argument("--dir", help="transcript folder (default: wts paths' transcripts_dir)")
    r.add_argument("--dir", help="transcript folder (default: wts paths' transcripts_dir)")
    args = parser.parse_args()

    audio_dir = None
    if args.dir:
        transcripts_dir = Path(args.dir)
    else:
        from wts.config import load_config
        from wts.paths import resolve_paths

        paths = resolve_paths(load_config(resolve_paths().config_file))
        transcripts_dir, audio_dir = paths.transcripts_dir, paths.audio_dir
    if args.cmd == "read":
        read(find(transcripts_dir, args.episode), audio_dir, seconds(args.start), seconds(args.end),
             args.mark_all)
    else:
        suspects(transcripts_dir, args.top)


if __name__ == "__main__":
    main()
