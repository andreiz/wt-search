"""The `wts` command line. Thin: each command delegates to a module."""

import sys
import uuid
from dataclasses import dataclass, fields

import click

from wts import __version__
from wts.config import ENV_NAMES, Config, load_config
from wts.paths import Paths, resolve_paths
from wts.secrets import SECRET_NAMES


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
    from wts.log import describe, run_record
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
    click.echo(f"{step}: {describe(run.counts)}")


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


@main.command()
@select_option
@click.option("--env", "env", type=click.Choice(ENV_NAMES), required=True,
              help="Cloudflare environment to publish to.")
@click.option("--dry-run", is_flag=True, help="Show what would be sent; call nothing.")
def publish(selector: str, env: str, dry_run: bool) -> None:
    """Send changed episodes to D1 and Vectorize (safe to re-run)."""
    if not dry_run:
        _check_publish_config(_ctx().cfg, env)
    _run_step("publish", selector, env=env, dry_run=dry_run)


def _check_publish_config(cfg: Config, env: str) -> None:
    """Fail before a run starts, naming what to set: config for `env`, and the API token."""
    from wts.secrets import MissingSecret, get_secret, get_store

    cfg.env(env)
    try:
        get_secret(get_store(), "cloudflare_api_token")
    except MissingSecret as exc:
        raise click.ClickException(str(exc)) from exc


@main.command("check-embeddings")
@click.option("--n", "n", type=click.IntRange(min=1), default=5, show_default=True,
              help="How many chunks to compare (one per episode, spread by date).")
def check_embeddings_cmd(n: int) -> None:
    """Compare stored Mac vectors with Workers AI's (CLS pooling); exit 1 on a mismatch.

    Run before the first publish: a pooling or model mismatch makes smart search quietly poor.
    The API token needs the Workers AI Read permission. Needs cloudflare_account_id in
    config.toml, but no [env.*] table: Workers AI is account-wide.
    """
    from wts.cloudflare import CloudflareApi, CloudflareError
    from wts.embedcheck import MIN_COSINE, NothingEmbedded, check_embeddings, chunk_stems
    from wts.net import new_client
    from wts.secrets import KeychainError, MissingSecret, get_secret, get_store

    ctx = _ctx()
    if not ctx.cfg.cloudflare_account_id:
        raise click.UsageError(f"cloudflare_account_id is not set in {ctx.paths.config_file}")
    try:
        token = get_secret(get_store(), "cloudflare_api_token")
    except (MissingSecret, KeychainError) as exc:
        raise click.ClickException(str(exc)) from exc
    ctx.logger()
    conn = ctx.conn()
    try:
        with new_client() as client:
            api = CloudflareApi(client, ctx.cfg.cloudflare_account_id, token)
            results = check_embeddings(conn, ctx.paths, api, n)
    except (NothingEmbedded, CloudflareError) as exc:  # CloudflareError never holds the token
        raise click.ClickException(str(exc)) from exc
    stems = chunk_stems(conn, [chunk_id for chunk_id, _ in results])
    for chunk_id, cosine in results:
        click.echo(f"chunk {chunk_id}  cosine {cosine:.4f}  {stems[chunk_id]}")
    if any(cosine < MIN_COSINE for _, cosine in results):
        click.echo(f"pooling or model mismatch: cosine below {MIN_COSINE}", err=True)
        raise SystemExit(1)
    click.echo("ok")


@main.command("search", context_settings={"ignore_unknown_options": True})
@click.option("--env", "env", type=click.Choice(ENV_NAMES), default=None,
              help="Environment to search [default: run_env in config.toml].")
@click.option("--mode", type=click.Choice(["smart", "exact"]), default="smart", show_default=True,
              help="smart: keywords plus meaning; exact: keywords only.")
@click.option("--sort", type=click.Choice(["relevance", "newest", "oldest"]),
              default="relevance", show_default=True)
@click.option("--page", type=click.IntRange(min=1), default=1, show_default=True)
@click.option("--limit", type=click.IntRange(min=1), default=None,
              help="Show only the first N results of the page (after collapsing).")
@click.option("--json", "as_json", is_flag=True, help="Print the API's response as JSON.")
@click.option("--debug", is_flag=True,
              help="Smart mode: show each result's keyword and meaning ranks, similarity, RRF "
                   "score and folded hits, and the meaning hits that were dropped.")
@click.argument("query", nargs=-1, required=True, type=click.UNPROCESSED)
def search_cmd(env: str | None, mode: str, sort: str, page: int, limit: int | None,
               as_json: bool, debug: bool, query: tuple[str, ...]) -> None:
    """Search a deployed environment through the Worker's API, as the web app does.

    The query syntax is the web app's: "a phrase", -exclude, year:2015, ep:613, include:ads.
    Quote it for the shell, e.g. wts search '"hide glue" -titebond'; words left unquoted are
    joined with spaces, so a leading dash is fine. That also means a mistyped option (--sotr)
    is searched for as words rather than rejected. The URL is `api_url` under [env.<name>]
    in config.toml.
    """
    import json

    from wts.net import new_client
    from wts.search import SearchError, format_results, limit_results
    from wts.search import search as run_search

    ctx = _ctx()
    name = env or ctx.cfg.run_env
    if not name:
        raise click.UsageError(f"no environment: use --env or run_env in {ctx.paths.config_file}")
    api_url = ctx.cfg.api_url(name)
    try:
        with new_client() as client:
            response = run_search(client, api_url, " ".join(query), mode=mode, sort=sort,
                                  page=page, debug=debug)
    except SearchError as exc:  # never holds the query string
        raise click.ClickException(str(exc)) from exc
    if as_json:
        click.echo(json.dumps(limit_results(response, limit), indent=2, ensure_ascii=False))
        return
    color = sys.stdout.isatty()  # click.get_text_stream is deprecated in click 8.5
    click.echo(format_results(response, color=color, limit=limit), color=color)


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


@main.group("secrets")
def secrets_group() -> None:
    """Manage secrets in the macOS Keychain (values are never printed)."""


@secrets_group.command("set")
@click.argument("name", type=click.Choice(SECRET_NAMES))
def secrets_set(name: str) -> None:
    """Store a secret; `security` prompts for the value."""
    from wts.secrets import KeychainError, set_secret

    try:
        code = set_secret(name)
    except KeychainError as exc:
        raise click.ClickException(str(exc)) from exc
    if code != 0:
        raise click.ClickException(f"security exited {code}; {name} not stored")
    click.echo(f"{name} stored")


@secrets_group.command("check")
def secrets_check() -> None:
    """List each secret as set or missing."""
    from wts.secrets import get_store

    store = get_store()
    for name in SECRET_NAMES:
        click.echo(f"{name} {'set' if store.get(name) is not None else 'missing'}")


@main.group()
def notify() -> None:
    """Push notifications (ntfy)."""


@notify.command("test")
def notify_test() -> None:
    """Send one test message to the ntfy topic (on `ntfy_url`, with `ntfy_token` if set)."""
    import platform

    from wts.net import new_client
    from wts.notify import NtfyNotifier
    from wts.secrets import KeychainError, get_store

    ctx = _ctx()
    ctx.logger()
    store = get_store()
    try:
        topic = store.get("ntfy_topic")
        token = store.get("ntfy_token")
    except KeychainError as exc:
        raise click.ClickException(str(exc)) from exc
    if topic is None:
        raise click.ClickException("ntfy_topic is not set; run `wts secrets set ntfy_topic`")
    sent = NtfyNotifier(new_client(), topic, ctx.cfg.ntfy_url, token=token).send(
        "wts: test notification", f"Notifications from {platform.node()} are working.",
        tags=("white_check_mark",),
    )
    if not sent:
        raise click.ClickException("not sent; see the log for the reason")
    click.echo("sent")


@main.command()
@click.option("--force", is_flag=True, help="Allow resetting many episodes whose audio URL moved.")
def feed(force: bool) -> None:
    """Read the RSS feed and add or update episodes."""
    from wts.feed import MassReset
    from wts.log import run_record
    from wts.platforms import platform_summary
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
    click.echo(platform_summary(conn, c))


@main.command("run")
@select_option
@click.option("--env", "env", type=click.Choice(ENV_NAMES), default=None,
              help="Environment to publish to [default: run_env in config.toml; with neither, "
                   "nothing is published].")
def run_cmd(selector: str, env: str | None) -> None:
    """Run feed → download → transcribe → chunk → embed → publish → backup, then notify.

    Steps take the selected episodes. A backup failure is a warning and a notification, not a
    failed run; with no backup_dir in config.toml there is no backup.
    """
    from wts.feed import MassReset
    from wts.log import describe_run
    from wts.steps import run_all
    from wts.storage import MachineProblem

    ctx = _ctx()
    env = env or ctx.cfg.run_env
    if env:
        _check_publish_config(ctx.cfg, env)
    ctx.logger()
    try:
        results = run_all(ctx.conn(), ctx.paths, ctx.cfg, selector, env=env)
    except MachineProblem as exc:
        click.echo(f"Stopped: {exc}", err=True)
        raise SystemExit(3) from exc
    except MassReset as exc:
        raise click.ClickException(f"{exc} (use `wts feed --force`)") from exc
    click.echo(describe_run(results))


@main.command("backup")
def backup_cmd() -> None:
    """Back up the app folder (state, transcripts, chunks, embeddings; not audio) to backup_dir.

    `wts run` does this at the end of every run.
    """
    from wts.backup import BackupFailed, backup
    from wts.log import run_record

    ctx = _ctx()
    if ctx.cfg.backup_dir is None:
        raise click.UsageError(f"backup_dir is not set in {ctx.paths.config_file}")
    ctx.logger()
    with run_record(ctx.conn(), "backup") as run:
        try:
            dest = backup(ctx.paths, ctx.cfg)
        except BackupFailed as exc:
            run.counts["error"] += 1
            raise click.ClickException(str(exc)) from exc
        run.counts["ok"] += 1
    click.echo(f"backed up to {dest}")


@main.command("logs")
@click.option("--run", "run_id", default=None, help="Only this run (the id after the time).")
@click.option("--episode", default=None, help="Only this episode: its stem, or part (ep312).")
@click.option("--level", type=click.Choice(["info", "warning", "error"], case_sensitive=False),
              default=None, help="At least this level (warning includes error).")
@click.option("--since", default=None, help="Only the last 30m, 12h, 7d, …")
@click.option("--json", "as_json", is_flag=True, help="Print the log lines as JSON.")
def logs_cmd(run_id: str | None, episode: str | None, level: str | None, since: str | None,
             as_json: bool) -> None:
    """Show pipeline log lines (kept 30 days), oldest first, filtered."""
    import json

    from wts.logs import format_line, parse_since, read_logs

    if since is not None:
        try:
            parse_since(since)
        except ValueError as exc:
            raise click.BadParameter(str(exc), param_hint="--since") from exc
    found = False
    for line in read_logs(_ctx().paths.log_dir, run=run_id, episode=episode, level=level,
                          since=since):
        found = True
        click.echo(json.dumps(line, ensure_ascii=False) if as_json else format_line(line))
    if not found:
        click.echo("no log lines match", err=True)
