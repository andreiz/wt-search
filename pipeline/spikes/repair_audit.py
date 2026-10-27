"""THROWAWAY: what transcript repair caught and missed, and how the rule matched decisions (spec 2026-10-26 §7 step 4).

    cd pipeline
    uv run python spikes/repair_audit.py [--select scope]

For each selected episode with a current transcript and a previous copy in
`<data>/transcripts-previous/<stem>.json` (`wts transcribe --redo` puts it there), compares the
previous transcript's cleaned words with the current cleaned-and-repaired ones. A hole the
detector missed is a stretch where the previous has at least 8 words and the current has at most
a quarter as many (and no more than 1 if that's larger); each is printed with its time in the
current transcript and the missing text, so you can listen.

Then totals: episodes audited, hours of audio, flags and flags per hour, repairs by status,
missed holes; and, for the repairs you decided (accepted or rejected), per check 1-5 how many
passed and failed it, and how often the rule's verdict (apply when no check fails) matched your
decision. Check 5 (a second pass on the same machine) is called out. Episodes with no repairs
file are listed as "not repaired yet". Read-only: state.db is opened with `mode=ro`.
"""

import argparse
import difflib
import json
import sqlite3
from collections import Counter
from pathlib import Path

from wts.config import load_config
from wts.guards import clean_transcript
from wts.paths import resolve_paths
from wts.repair_rule import clear_cut
from wts.repairs import cleaned_words, load_repairs
from wts.selection import resolve_selector
from wts.words import Word, normalize_text

MIN_MISSING = 8  # words the previous transcript has in a stretch the current lacks
KEEP_FRACTION = 0.25
CLIP = 120
CHECKS = (1, 2, 3, 4, 5)


def mmss(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def keys(words: list[Word]) -> list[str]:
    return [normalize_text(w.text) for w in words]


def missed_holes(previous: list[Word], current: list[Word]) -> list[tuple[int, str]]:
    """(time in ms on the current side, missing text) for each stretch the current lacks."""
    a, b = keys(previous), keys(current)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag not in ("delete", "replace"):
            continue
        had, has = i2 - i1, j2 - j1
        if had >= MIN_MISSING and has <= max(1, KEEP_FRACTION * had):
            if j1 < len(current):
                at = current[j1].start_ms
            elif current:
                at = current[-1].end_ms
            else:
                at = previous[i1].start_ms
            text = " ".join(w.text.strip() for w in previous[i1:i2])
            out.append((at, text if len(text) <= CLIP else text[: CLIP - 1] + "…"))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--select", default="scope", help="episode selector (default: scope)")
    args = parser.parse_args()

    paths = resolve_paths(load_config(resolve_paths().config_file))
    previous_dir = paths.data_dir / "transcripts-previous"
    conn = sqlite3.connect(f"file:{paths.state_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    ids = resolve_selector(conn, args.select)

    audited = 0
    seconds = 0.0
    flags = 0
    status_count: Counter[str] = Counter()
    missed_total = 0
    not_repaired: list[str] = []
    no_previous = 0
    # per check: {"accepted"|"rejected": [passed, failed]}
    per_check = {n: {"accepted": [0, 0], "rejected": [0, 0]} for n in CHECKS}
    matched = decided = 0

    for episode_id in ids:
        row = conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()
        if not row["transcript_path"]:
            continue
        path = Path(row["transcript_path"])
        label = f"ep{row['number']:03d}" if row["number"] is not None else row["stem"]
        previous_path = previous_dir / f"{path.stem}.json"
        if not path.is_file() or not previous_path.is_file():
            no_previous += 1
            continue
        rf = load_repairs(path)
        if rf is None:
            not_repaired.append(label)
            continue
        audited += 1
        seconds += row["audio_duration_s"] or row["duration_s"] or 0
        flags += len(rf.flags)
        for r in rf.repairs:
            status_count[r.status] += 1
            if r.status not in ("accepted", "rejected"):
                continue
            decided += 1
            apply = clear_cut(r.fails)
            matched += (apply and r.status == "accepted") or (not apply and r.status == "rejected")
            for n in CHECKS:
                per_check[n][r.status][1 if n in r.fails else 0] += 1

        previous, _ = clean_transcript(
            json.loads(previous_path.read_text()), row["audio_duration_s"] or row["duration_s"]
        )
        current, _ = cleaned_words(row)
        holes = missed_holes(previous, current)
        missed_total += len(holes)
        for at, text in holes:
            print(f"{label} {mmss(at)}  missed: {text}")

    hours = seconds / 3600
    print()
    print(f"episodes audited: {audited} ({hours:.1f} h of audio)")
    if no_previous:
        print(f"skipped, no previous copy: {no_previous}")
    if not_repaired:
        print(f"not repaired yet: {', '.join(not_repaired)}")
    per_hour = f"{flags / hours:.2f}" if hours else "n/a"
    print(f"flags: {flags} ({per_hour} per hour)")
    print("repairs: " + ", ".join(
        f"{status_count[s]} {s}" for s in ("proposed", "accepted", "rejected", "auto")))
    print(f"holes the detector missed: {missed_total}")

    print()
    print(f"decided repairs: {decided}")
    if decided:
        print("check   accepted: passed failed   rejected: passed failed")
        for n in CHECKS:
            acc, rej = per_check[n]["accepted"], per_check[n]["rejected"]
            print(f"  {n}               {acc[0]:6d} {acc[1]:6d}              {rej[0]:6d} {rej[1]:6d}")
        print(f"the rule's verdict matched the decision: {matched} of {decided}")
        acc, rej = per_check[5]["accepted"], per_check[5]["rejected"]
        print(
            f"check 5 (same-machine second pass): failed by {acc[1]} accepted and {rej[1]} rejected "
            f"repairs; passed by {acc[0]} accepted and {rej[0]} rejected"
        )


if __name__ == "__main__":
    main()
