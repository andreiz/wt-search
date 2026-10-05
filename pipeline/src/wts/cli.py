"""The `wts` command line. Thin: each command delegates to a module."""

import uuid
from dataclasses import dataclass, fields

import click

from wts import __version__
from wts.config import Config, load_config
from wts.paths import Paths, resolve_paths


@dataclass
class Ctx:
    paths: Paths
    cfg: Config

    def conn(self):
        from wts.db import connect

        return connect(self.paths.state_db)

    def logger(self):
        from wts.log import setup_logging

        return setup_logging(self.paths.log_dir, uuid.uuid4().hex[:12])


def _ctx() -> Ctx:
    cfg = load_config(resolve_paths().config_file)
    return Ctx(paths=resolve_paths(cfg), cfg=cfg)


@click.group()
@click.version_option(__version__)
def main() -> None:
    """Wood Talk transcript search pipeline."""


@main.command()
def status() -> None:
    """Episode counts by status, errors, and recent runs."""
    from wts.status import status_report

    click.echo(status_report(_ctx().conn()))


@main.command()
def paths() -> None:
    """Print the resolved file locations."""
    p = _ctx().paths
    for f in fields(p):
        click.echo(f"{f.name}: {getattr(p, f.name)}")


select_option = click.option(
    "--select",
    "selector",
    default="scope",
    show_default=True,
    help="Episodes: scope, all, seed, recent:N, ep:N, year:YYYY, stem:S (comma = union).",
)


@main.group()
def scope() -> None:
    """Manage which episodes are in scope (the default selection)."""


@scope.command("add")
@click.argument("selector")
def scope_add(selector: str) -> None:
    """Mark the selected episodes as in scope."""
    from wts.selection import add_to_scope, resolve_selector

    conn = _ctx().conn()
    n = add_to_scope(conn, resolve_selector(conn, selector))
    click.echo(f"{n} episode(s) added to scope")


@scope.command("list")
def scope_list() -> None:
    """List in-scope episodes."""
    conn = _ctx().conn()
    rows = conn.execute(
        "select stem, status from episodes where in_scope = 1 order by published_at"
    ).fetchall()
    for r in rows:
        click.echo(f"{r['stem']}  {r['status']}")
    click.echo(f"{len(rows)} in scope")


@main.command()
def feed() -> None:
    """Read the RSS feed and add or update episodes."""
    import httpx

    from wts.feed import parse_feed, upsert_episodes
    from wts.log import run_record

    ctx = _ctx()
    if not ctx.cfg.feed_url:
        raise click.UsageError(f"feed_url is not set in {ctx.paths.config_file}")
    log = ctx.logger()
    conn = ctx.conn()
    with run_record(conn, "feed") as run:
        resp = httpx.get(ctx.cfg.feed_url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        result = upsert_episodes(conn, parse_feed(resp.content))
        run.counts.update(added=result.added, updated=result.updated, reset=result.reset)
    log.info(f"feed: {result}", extra={"step": "feed"})
    click.echo(f"added={result.added} updated={result.updated} reset={result.reset}")
