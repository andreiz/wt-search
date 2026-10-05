"""`wts status`: what state the corpus is in."""

import json
import sqlite3

from wts.log import describe


def status_report(conn: sqlite3.Connection) -> str:
    lines = ["Episodes by status"]
    for row in conn.execute("select status, count(*) n from episodes group by status order by 1"):
        lines.append(f"  {row['status']}: {row['n']}")
    in_scope = conn.execute("select count(*) from episodes where in_scope = 1").fetchone()[0]
    lines.append(f"  (in scope: {in_scope})")

    errors = conn.execute(
        "select stem, error_step, retries, error_reason from episodes "
        "where status = 'error' order by published_at"
    ).fetchall()
    if errors:
        lines.append("Errors (stem | step | retries | reason)")
        for e in errors:
            lines.append(f"  {e['stem']} | {e['error_step']} | {e['retries']} | {e['error_reason']}")

    lines.append("Last runs")
    for r in conn.execute(
        "select command, started_at, finished_at, counts from runs order by started_at desc, "
        "rowid desc limit 10"
    ):
        counts = describe(json.loads(r["counts"])) if r["counts"] else "(running)"
        lines.append(f"  {r['started_at']}  {r['command']}  {counts}")
    return "\n".join(lines)
