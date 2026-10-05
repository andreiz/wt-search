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


def _run_step(step: str, selector: str, **kwargs) -> None:
    """Resolve the selection, run one batch step inside a run record, print counts."""
    from wts import steps
    from wts.log import run_record
    from wts.selection import resolve_selector
    from wts.storage import MachineProblem

    ctx = _ctx()
    ctx.logger()
    conn = ctx.conn()
    ids = resolve_selector(conn, selector)
    try:
        with run_record(conn, step) as run:
            run.counts.update(getattr(steps, f"run_{step}")(conn, ctx.paths, ctx.cfg, ids, **kwargs))
    except MachineProblem as exc:
        click.echo(f"Stopped: {exc}", err=True)
        raise SystemExit(3) from exc
    click.echo(f"{step}: {dict(run.counts) or 'nothing to do'}")


@main.command()
@select_option
@click.option(
    "--refetch-ads",
    is_flag=True,
    help="Re-download selected episodes whose stored copy has inserted ads.",
)
def download(selector: str, refetch_ads: bool) -> None:
    """Download audio; retry once if the copy has inserted ads (normally it won't)."""
    _run_step("download", selector, refetch_ads=refetch_ads)


@main.command()
@select_option
def transcribe(selector: str) -> None:
    """Transcribe downloaded episodes with Whisper (one at a time; Ctrl-C safe)."""
    _run_step("transcribe", selector)


@main.command()
@select_option
@click.option("--force", is_flag=True, help="Re-chunk selected episodes even if already chunked.")
def chunk(selector: str, force: bool) -> None:
    """Clean transcripts, apply corrections, flag boilerplate, and build chunks."""
    _run_step("chunk", selector, force=force)


@main.command()
@select_option
def embed(selector: str) -> None:
    """Embed non-boilerplate chunks with bge-base-en-v1.5."""
    _run_step("embed", selector)


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
@click.option("--force", is_flag=True, help="Allow resetting many episodes whose audio URL moved.")
def feed(force: bool) -> None:
    """Read the RSS feed and add or update episodes."""
    from wts.feed import MassReset
    from wts.log import run_record
    from wts.steps import run_feed

    ctx = _ctx()
    if not ctx.cfg.feed_url:
        raise click.UsageError(f"feed_url is not set in {ctx.paths.config_file}")
    ctx.logger()
    conn = ctx.conn()
    with run_record(conn, "feed") as run:
        try:
            run.counts.update(run_feed(conn, ctx.cfg, force=force))
        except MassReset as exc:
            run.counts["error"] += 1
            raise click.ClickException(str(exc)) from exc
    c = run.counts
    click.echo(f"added={c['added']} updated={c['updated']} reset={c['reset']}")


@main.command("run")
@select_option
def run_cmd(selector: str) -> None:
    """Run feed → download → transcribe → chunk → embed for the selected episodes."""
    from wts.feed import MassReset
    from wts.steps import run_all
    from wts.storage import MachineProblem

    ctx = _ctx()
    ctx.logger()
    try:
        results = run_all(ctx.conn(), ctx.paths, ctx.cfg, selector)
    except MachineProblem as exc:
        click.echo(f"Stopped: {exc}", err=True)
        raise SystemExit(3) from exc
    except MassReset as exc:
        raise click.ClickException(f"{exc} (use `wts feed --force`)") from exc
    for step, counts in results.items():
        click.echo(f"{step}: {dict(counts) or 'nothing to do'}")
