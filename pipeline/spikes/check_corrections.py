"""Show every sentence a corrections.yaml change would alter, before you commit it.

    cd pipeline
    uv run python spikes/check_corrections.py                       # working file vs HEAD
    uv run python spikes/check_corrections.py --try "festival tools: Festool tools"
    uv run python spikes/check_corrections.py --before-ref HEAD~3   # vs an older version
    uv run python spikes/check_corrections.py --dir tests/fixtures/real

Runs the same clean-up `wts chunk` does (guards → corrections → sentences) over every transcript,
once with the old rules and once with the new ones, and prints the sentences that differ. A rule
is safe only if every change it makes is a fix. `--try` adds rules without editing the file.
Transcripts default to `wts paths`' transcripts_dir (all episodes on the Mac); the committed
fixtures are only the first 15 minutes of 7 episodes.

Also prints the Whisper prompt's length: vocab.txt feeds a prompt capped at 150 words.
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import yaml

from wts.corrections import CORRECTIONS_FILE, apply_corrections, load_corrections
from wts.guards import clean_transcript
from wts.transcribe import VOCAB_FILE, build_initial_prompt
from wts.words import split_sentences

PROMPT_CAP = 150


def rules_at(ref: str):
    """corrections.yaml as committed at `ref` (no rules if it didn't exist)."""
    repo = CORRECTIONS_FILE.parents[1]
    rel = CORRECTIONS_FILE.relative_to(repo).as_posix()
    shown = subprocess.run(
        ["git", "show", f"{ref}:{rel}"], capture_output=True, text=True, cwd=repo, check=False
    )
    if shown.returncode != 0 and "does not exist" not in shown.stderr:
        raise SystemExit(f"git show {ref}:{rel} failed: {shown.stderr.strip()}")
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as f:
        f.write(shown.stdout if shown.returncode == 0 else "")
        f.flush()
        return load_corrections(Path(f.name))


def tried_rules(specs: list[str]):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as f:
        yaml.safe_dump({"global": dict(s.split(":", 1) for s in specs)}, f)
        f.flush()
        return load_corrections(Path(f.name))


def sentences(data: dict, rules, stem: str) -> dict[int, str]:
    words, _ = clean_transcript(data, data["meta"].get("duration_s"))
    return {s.start_ms: s.text for s in split_sentences(apply_corrections(words, rules, stem))}


def mmss(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-ref", default="HEAD", help="git ref of the old rules")
    parser.add_argument("--try", dest="tries", action="append", default=[],
                        help='extra rule to test, "key: value" (repeatable)')
    parser.add_argument("--dir", help="transcript folder (default: wts paths' transcripts_dir)")
    args = parser.parse_args()

    before = rules_at(args.before_ref)
    after = load_corrections(CORRECTIONS_FILE) + tried_rules([t.strip() for t in args.tries])
    if args.dir:
        transcripts_dir = Path(args.dir)
    else:
        from wts.config import load_config
        from wts.paths import resolve_paths

        transcripts_dir = resolve_paths(load_config(resolve_paths().config_file)).transcripts_dir
    files = sorted(transcripts_dir.glob("*.json"))
    print(f"{len(before)} rules at {args.before_ref} → {len(after)} rules now; "
          f"{len(files)} transcripts in {transcripts_dir}\n")

    changed = 0
    for path in files:
        data = json.loads(path.read_text())
        old, new = sentences(data, before, path.stem), sentences(data, after, path.stem)
        for start in sorted(set(old) | set(new)):
            if old.get(start) != new.get(start):
                changed += 1
                print(f"{path.stem} [{mmss(start)}]")
                print(f"  - {old.get(start, '(none)')}")
                print(f"  + {new.get(start, '(none)')}")
    print(f"\n{changed} sentences change.")

    prompt, _ = build_initial_prompt(VOCAB_FILE)
    n = len(prompt.split())
    print(f"Whisper prompt: {n} of {PROMPT_CAP} words" + ("  ← OVER THE CAP" if n > PROMPT_CAP else ""))


if __name__ == "__main__":
    main()
