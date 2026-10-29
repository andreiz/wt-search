"""Measure boilerplate detection on the real corpus (boilerplate spec 2026-10-28 §5.1, §6).

    cd pipeline
    uv run python spikes/boilerplate_report.py spans [--min-words M] [--max-gap G] [--list]
    uv run python spikes/boilerplate_report.py grid --min-words 8 10 12 15 20 --max-gap 0 3 8 15
    uv run python spikes/boilerplate_report.py eval [--min-words M] [--max-gap G]
    uv run python spikes/boilerplate_report.py pollution ../eval/reports/<report>.json [...]

Reads state.db read-only and every chunked/embedded/published episode's transcript, cleaned as
`wts chunk` does (guards, repairs, the shipped corrections), and counts shared runs afresh from
the text: it doesn't use the `run_hashes` cache or the stored flags, so it's an independent check.

- spans: totals, and with --list every distinct span text with its episode count, shortest first.
- grid: the totals for each M × G.
- eval: eval/queries.yaml cases whose expected moment is inside a span (its chunk would be
  hidden), and negatives whose named wrong hit is.
- pollution: top-10 hits of an eval report whose stored chunk spans cover by ≥ 25% of its time.
"""

import argparse
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from wts.boilerplate import (
    MAX_GAP_WORDS,
    MIN_SPAN_WORDS,
    Params,
    find_spans,
    run_hashes,
    shared_runs,
    tokens,
)
from wts.chunking import prepare_episode
from wts.corrections import CORRECTIONS_FILE, load_corrections
from wts.evalset.cases import load_cases
from wts.paths import resolve_paths


def open_db() -> sqlite3.Connection:
    db = resolve_paths().state_db
    conn = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_corpus(conn):
    """{episode number: words}, and the shared run hashes."""
    rules = load_corrections(CORRECTIONS_FILE)
    rows = conn.execute(
        "select * from episodes where status in ('chunked', 'embedded', 'published') "
        "and number is not null order by published_at"
    ).fetchall()
    words = {}
    for row in rows:
        sentences, _ = prepare_episode(row, rules)
        words[row["number"]] = [w for s in sentences for w in s.words]
    p = Params()
    shared = shared_runs((run_hashes(tokens(w), p.run_words) for w in words.values()),
                         p.min_episodes)
    return words, shared


def spans_of(words, shared, m, g):
    """{episode: [(start_ms, end_ms, word count, text)]}"""
    p = Params(min_span_words=m, max_gap_words=g)
    out = {}
    for num, ws in words.items():
        out[num] = [
            (ws[s].start_ms, ws[e - 1].end_ms, e - s, " ".join(w.text for w in ws[s:e]))
            for s, e in find_spans(ws, shared, p)
        ]
    return out


def totals(words, spans) -> str:
    n_words = sum(len(w) for w in words.values())
    covered = sum(n for sp in spans.values() for _, _, n, _ in sp)
    n_spans = sum(len(sp) for sp in spans.values())
    eps = sum(1 for sp in spans.values() if sp)
    return (f"{n_spans} spans in {eps}/{len(words)} episodes, {covered} words "
            f"({100 * covered / max(n_words, 1):.2f}% of {n_words})")


def mmss(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def cmd_spans(words, shared, args) -> None:
    spans = spans_of(words, shared, args.min_words[0], args.max_gap[0])
    print(totals(words, spans))
    if not args.list:
        return
    texts: dict[str, set[int]] = defaultdict(set)
    where: dict[str, tuple[int, int]] = {}
    for num, sp in spans.items():
        for start, _, _, text in sp:
            key = text.lower()
            texts[key].add(num)
            where.setdefault(key, (num, start))
    for key in sorted(texts, key=lambda t: (len(t.split()), t)):
        num, start = where[key]
        print(f"{len(key.split()):4d}w {len(texts[key]):3d}eps  ep{num} {mmss(start)}  {key}")


def cmd_grid(words, shared, args) -> None:
    for m in args.min_words:
        for g in args.max_gap:
            print(f"M={m:2d} G={g:2d}: {totals(words, spans_of(words, shared, m, g))}")


def inside(spans, episode: int, at_ms: int) -> str | None:
    """The span's text when the moment is inside one (so its chunk would be hidden)."""
    for start, end, _, text in spans.get(episode, []):
        if start <= at_ms <= end:
            return text
    return None


def cmd_eval(words, shared, args) -> None:
    spans = spans_of(words, shared, args.min_words[0], args.max_gap[0])
    bad = 0
    for case in load_cases():
        for item in case.expect:
            if item.at_s is not None and (t := inside(spans, item.episode, item.at_s * 1000)):
                bad += 1
                print(f"EXPECTED HIDDEN  {case.id}: ep{item.episode} {mmss(item.at_s * 1000)}"
                      f"  {t[:100]}")
        for item in case.expect_absent:
            if item.at_s is not None and inside(spans, item.episode, item.at_s * 1000):
                print(f"negative hidden  {case.id}: ep{item.episode} {mmss(item.at_s * 1000)}")
    print(f"{bad} expected passages inside a span")


def to_ms(at: str) -> int:
    s = 0
    for part in at.split(":"):
        s = s * 60 + int(part)
    return s * 1000


def cmd_pollution(conn, words, shared, args) -> None:
    spans = spans_of(words, shared, args.min_words[0], args.max_gap[0])
    chunks = defaultdict(list)
    for num, st, en in conn.execute(
        "select e.number, c.start_ms, c.end_ms from chunks c join episodes e "
        "on e.id = c.episode_id where e.number is not null"
    ):
        chunks[num].append((st, en))
    report = json.loads(Path(args.report).read_text())
    total = hit = first = 0
    by_mode: Counter = Counter()
    for case in report["cases"]:
        for mode, hits in case["top"].items():
            for rank, h in enumerate(hits[:10]):
                ms, num = to_ms(h["at"]), h["episode"]
                found = [c for c in chunks.get(num, []) if c[0] <= ms <= c[1] + 1000]
                if not found:
                    continue
                st, en = found[0]
                total += 1
                cover = sum(max(0, min(en, b) - max(st, a)) for a, b, _, _ in spans.get(num, []))
                if cover / max(1, en - st) >= 0.25:
                    hit += 1
                    first += rank == 0
                    by_mode[mode] += 1
                    if args.list:
                        print(f"  {case['id']} {mode} #{rank + 1} ep{num} {h['at']}")
    print(f"top-10 hits: {total}; mostly boilerplate: {hit} ({first} at #1); by mode: "
          f"{dict(by_mode)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["spans", "grid", "eval", "pollution"])
    parser.add_argument("report", nargs="?")
    parser.add_argument("--min-words", type=int, nargs="+", default=[MIN_SPAN_WORDS])
    parser.add_argument("--max-gap", type=int, nargs="+", default=[MAX_GAP_WORDS])
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    conn = open_db()
    words, shared = load_corpus(conn)
    if args.command == "spans":
        cmd_spans(words, shared, args)
    elif args.command == "grid":
        cmd_grid(words, shared, args)
    elif args.command == "eval":
        cmd_eval(words, shared, args)
    else:
        if not args.report:
            parser.error("pollution needs an eval report")
        cmd_pollution(conn, words, shared, args)


if __name__ == "__main__":
    main()
