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
