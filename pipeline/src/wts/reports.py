"""Listener reports in D1 (spec §3.2, §4.4; plan 4, Task 6): list, look up and close them.

Reports are read straight from D1, joined to D1's own chunks and episodes, so they show what the
listener saw even if the Mac has re-chunked since. Listener text is untrusted: `format_reports`
strips control characters (a report must not be able to move the terminal's cursor).
"""

import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

import click
import httpx

from wts.cloudflare import D1, CloudflareApi
from wts.config import Config
from wts.log import clock
from wts.secrets import KeychainError, MissingSecret, SecretStore, get_secret

STATUSES = ("open", "resolved", "rejected")

_SELECT = """
select r.id, r.created_at, r.status, r.chunk_id, r.quoted_text, r.suggested_text, r.note,
       e.number as episode_number, e.title as episode_title, c.start_ms
from reports r
left join chunks c on c.id = r.chunk_id
left join episodes e on e.id = c.episode_id
"""


@dataclass(frozen=True)
class Report:
    id: int
    created_at: str
    status: str
    chunk_id: int | None
    quoted_text: str | None
    suggested_text: str | None
    note: str | None
    episode_number: int | None
    episode_title: str | None
    start_ms: int | None

    @property
    def is_feedback(self) -> bool:
        return self.chunk_id is None


def _report(row: dict) -> Report:
    return Report(**{name: row.get(name) for name in Report.__dataclass_fields__})


def list_reports(d1: D1, status: str | None = "open", limit: int = 200) -> list[Report]:
    """Reports ordered by id; `status=None` lists all."""
    where, params = ("where r.status = ? ", [status]) if status else ("", [])
    rows = d1.query(f"{_SELECT}{where}order by r.id limit ?", [*params, limit])
    return [_report(row) for row in rows]


def get_report(d1: D1, report_id: int) -> Report | None:
    rows = d1.query(f"{_SELECT}where r.id = ?", [report_id])
    return _report(rows[0]) if rows else None


def set_status(d1: D1, report_id: int, status: str) -> bool:
    """Set a report's status; False when there is no such report."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}, not {status!r}")
    rows = d1.query("update reports set status = ? where id = ? returning id",
                    [status, report_id])
    return bool(rows)


def open_d1(cfg: Config, env: str, store: SecretStore, client: httpx.Client) -> D1:
    """A D1 for `env`, after the checks `wts publish` makes: the env's config and the token."""
    target = cfg.env(env)
    try:
        token = get_secret(store, "cloudflare_api_token")
    except (MissingSecret, KeychainError) as exc:
        raise click.ClickException(str(exc)) from exc
    api = CloudflareApi(client, cfg.cloudflare_account_id, token)
    return D1(api, target.d1_database_id)


def _clean(text: str | None) -> str:
    """`text` without control characters (Unicode Cc) other than newline and tab."""
    return "".join(
        ch for ch in text or "" if ch in "\n\t" or unicodedata.category(ch) != "Cc")


def _indent(text: str) -> str:
    return text.replace("\n", "\n    ")


def _one(report: Report, color: bool) -> str:
    head = click.style(f"#{report.id}", bold=True) if color else f"#{report.id}"
    date = report.created_at[:10]
    if report.is_feedback:
        lines = [f"{head}  {date}  feedback"]
    else:
        where = "passage no longer in the index"
        if report.episode_number is not None and report.start_ms is not None:
            where = f"ep {report.episode_number} at {clock(report.start_ms / 1000)}"
        elif report.start_ms is not None:
            where = f"at {clock(report.start_ms / 1000)}"
        lines = [f"{head}  {date}  {where}"]
        quoted = _clean(report.quoted_text)
        suggested = _clean(report.suggested_text)
        if quoted or suggested:
            line = f'  "{_indent(quoted)}"'
            if suggested:
                line += f' → "{_indent(suggested)}"'
            lines.append(line)
    note = _clean(report.note)
    if note:
        lines.append(f"  {_indent(note)}")
    if not report.is_feedback:
        lines.append(f"  wts review --report {report.id}")
    return "\n".join(lines)


def format_reports(reports: Sequence[Report], color: bool) -> str:
    """Transcript reports first, then feedback under its own heading."""
    passages = [r for r in reports if not r.is_feedback]
    feedback = [r for r in reports if r.is_feedback]
    blocks = [_one(r, color) for r in passages]
    if feedback:
        heading = click.style("Feedback", bold=True) if color else "Feedback"
        blocks.append(heading)
        blocks.extend(_one(r, color) for r in feedback)
    return "\n\n".join(blocks)
