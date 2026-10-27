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
@click.option("--flagged", is_flag=True,
              help="List the episodes the guards flagged, and whether each is reviewed.")
def status(flagged: bool) -> None:
    """Episode counts by status, errors, and recent runs."""
    from wts.status import flagged_report, status_report

    report = flagged_report if flagged else status_report
    click.echo(report(_ctx().conn()))


@main.command()
def paths() -> None:
    """Print the resolved file locations."""
    ctx = _ctx()
    p = ctx.paths
    for f in fields(p):
        click.echo(f"{f.name}: {getattr(p, f.name)}")
    url = ctx.cfg.transcribe_url
    click.echo(f"transcriber: remote {url}" if url else "transcriber: local mlx")


select_option = click.option(
    "--select",
    "selector",
    default="scope",
    show_default=True,
    help="Episodes: scope, all, seed, recent:N, spread:N, ep:N, year:YYYY, stem:S (comma = union).",
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
@click.option("--local", is_flag=True, help="Transcribe on this Mac even if transcribe_url is set.")
@click.option(
    "--redo",
    is_flag=True,
    help="Also re-transcribe selected episodes already transcribed (the old transcript is kept "
    "in transcripts-previous/).",
)
def transcribe(selector: str, local: bool, redo: bool) -> None:
    """Transcribe downloaded episodes with Whisper (one at a time; Ctrl-C safe)."""
    _run_step("transcribe", selector, local=local, redo=redo)


@main.command()
@select_option
@click.option("--local", is_flag=True, help="Transcribe clips on this Mac even if transcribe_url is set.")
def repair(selector: str, local: bool) -> None:
    """Find passages Whisper skipped and propose repairs to review (wts review)."""
    _run_step("repair", selector, local=local)


@main.command()
@select_option
@click.option("--force", is_flag=True, help="Re-chunk selected episodes even if already chunked.")
def chunk(selector: str, force: bool) -> None:
    """Clean transcripts, apply corrections, and build chunks."""
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
@click.option("--mode", type=click.Choice(["smart", "exact", "related"]), default="smart",
              show_default=True,
              help="smart: keywords plus meaning in one list; exact: keywords only; related: "
                   "meaning only, without what exact lists (the site's Related tab).")
@click.option("--sort", type=click.Choice(["relevance", "newest", "oldest"]),
              default="relevance", show_default=True)
@click.option("--page", type=click.IntRange(min=1), default=1, show_default=True)
@click.option("--limit", type=click.IntRange(min=1), default=None,
              help="Show only the first N results of the page (after collapsing).")
@click.option("--json", "as_json", is_flag=True, help="Print the API's response as JSON.")
@click.option("--debug", is_flag=True,
              help="Smart and related modes: show each result's keyword and meaning ranks, similarity, RRF "
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


@main.group("eval")
def eval_group() -> None:
    """The test search set (spec §7.2): eval/queries.yaml and eval/synthetic.yaml."""


@eval_group.command("run")
@click.option("--env", "env", type=click.Choice(ENV_NAMES), default=None,
              help="Environment to score [default: run_env in config.toml].")
@click.option("--update", is_flag=True, help="Also make this report eval/baseline.json.")
@click.option("--only", default=None, metavar="TAG-OR-ID",
              help="Only the cases with this tag or id (not compared with the baseline).")
@click.option("--param", "params", multiple=True, metavar="KEY=VALUE",
              help="Send with every Related request (debug overrides, e.g. floor=0.66, rerank=1).")
def eval_run_cmd(env: str | None, update: bool, only: str | None, params: tuple[str, ...]) -> None:
    """Send every case to the API and score the answers; exit 1 on a drop below the baseline.

    About one request a second (the Worker's limit is 60 a minute per IP); related requests
    count against the daily meaning budget. The report goes to eval/reports/.
    """
    from datetime import UTC, datetime

    from wts.evalset.cases import CaseError, eval_dir, load_cases
    from wts.evalset.run import (
        EvalError,
        build_report,
        format_report,
        load_baseline,
        run_cases,
        write_report,
    )
    from wts.evalset.score import newly_missed, regressions
    from wts.net import new_client

    if only and update:
        raise click.UsageError("--update records a full run; leave out --only")
    if params and update:
        raise click.UsageError("--update records the deployed settings; leave out --param")
    overrides = {}
    for item in params:
        key, eq, value = item.partition("=")
        if not eq or not key:
            raise click.BadParameter("use KEY=VALUE", param_hint="--param")
        overrides[key] = value
    ctx = _ctx()
    name = env or ctx.cfg.run_env
    if not name:
        raise click.UsageError(f"no environment: use --env or run_env in {ctx.paths.config_file}")
    api_url = ctx.cfg.api_url(name)
    directory = eval_dir()
    try:
        cases = load_cases(directory)
    except CaseError as exc:
        raise click.ClickException(str(exc)) from exc
    if only:
        cases = [c for c in cases if only in (c.id, c.tag)]
        if not cases:
            raise click.ClickException(f"no case has the tag or id {only!r}")
    if not cases:
        raise click.ClickException(f"no cases in {directory}")
    try:
        with new_client() as client:
            scored = run_cases(client, api_url, cases,
                               progress=lambda c: click.echo(f"  {c.id}", err=True),
                               params=overrides)
    except EvalError as exc:
        raise click.ClickException(str(exc)) from exc
    report = build_report(name, api_url, scored, now=datetime.now(UTC), params=overrides)
    baseline = None if only else load_baseline(directory)
    regressed = regressions(report["summary"], baseline["summary"]) if baseline else []
    missed = newly_missed([s for _, _, s in scored], baseline["cases"]) if baseline else []
    path = write_report(report, directory, update=update)
    click.echo(format_report(report, regressed=regressed, missed=missed,
                             baseline=baseline is not None or bool(only)))
    click.echo(f"\nReport: {path}" + (" (and eval/baseline.json)" if update else ""))
    if regressed and not update:
        raise SystemExit(1)


@eval_group.command("generate")
@click.option("--model", default=None, help="Ollama model [default: eval_model in config.toml].")
@click.option("--count", type=click.IntRange(min=1), default=100, show_default=True)
@click.option("--seed", type=int, default=1, show_default=True)
@click.option("--ollama-url", default=None,
              help="Ollama server [default: ollama_url in config.toml, else localhost:11434].")
def eval_generate_cmd(model: str | None, count: int, seed: int, ollama_url: str | None) -> None:
    """Write eval/synthetic.yaml: a local model's query for each of COUNT sampled passages.

    Needs an Ollama server: the app (or `ollama serve`) on this Mac, or `ollama_url`. The file is rewritten whole; check the
    diff before committing, and drop a case by regenerating with another seed rather than by
    hand.
    """
    from datetime import UTC, datetime

    from wts.evalset.cases import eval_dir
    from wts.evalset.generate import GenerateError, generate, write_synthetic
    from wts.net import new_client

    ctx = _ctx()
    model = model or ctx.cfg.eval_model
    if not model:
        raise click.UsageError(f"no model: use --model or eval_model in {ctx.paths.config_file}")
    try:
        with new_client() as client:
            cases, skipped = generate(ctx.conn(), client, model, count=count, seed=seed,
                                      url=ollama_url or ctx.cfg.ollama_url)
    except GenerateError as exc:
        raise click.ClickException(str(exc)) from exc
    path = eval_dir() / "synthetic.yaml"
    header = (f"# Written by `wts eval generate --model {model} --count {count} --seed {seed}`"
              f" on {datetime.now(UTC).date().isoformat()}.\n"
              "# Don't edit by hand: regenerate and review the diff.")
    write_synthetic(cases, path, header=header)
    click.echo(f"{len(cases)} cases written to {path}"
               + (f"; {skipped} replies weren't usable as a query" if skipped else ""))


@main.command("links")
@click.argument("episode")
@click.option("--at", "at", default=None,
              help="Start at this time: 12:34, 1:02:03 or seconds (each platform's offset is "
                   "applied).")
def links_cmd(episode: str, at: str | None) -> None:
    """An episode's links (YouTube, Apple, Spotify, show page, notes, audio), as the site builds them.

    EPISODE is a number (71) or a selector (stem:S, recent:3, ep:71,ep:171). YouTube is linked
    only when the video's length is within 3 s of the feed's; otherwise the match is shown
    with the reason.
    """
    from wts.links import episode_links, parse_time, youtube_note
    from wts.log import clock
    from wts.selection import resolve_selector

    at_s = None
    if at is not None:
        try:
            at_s = parse_time(at)
        except ValueError as exc:
            raise click.BadParameter(str(exc), param_hint="--at") from exc
    conn = _ctx().conn()
    ids = resolve_selector(conn, f"ep:{episode}" if episode.isdigit() else episode)
    if not ids:
        raise click.ClickException(f"no episode matches {episode!r}")
    for i, episode_id in enumerate(ids):
        row = conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()
        title = f"#{row['number']} {row['title']}" if row["number"] else row["title"]
        when = f", at {clock(at_s)}" if at_s is not None else ""
        click.echo(("\n" if i else "") + f"{title} ({row['published_at'][:10]}){when}")
        note = youtube_note(row)
        if note:
            click.echo(f"  {'youtube':8} {note}")
        for name, url in episode_links(row, at_s).items():
            click.echo(f"  {name:8} {url}")


@main.command("review")
@click.argument("episode", required=False)
@click.option("--at", "at", default=None,
              help="Start at this time: 12:34, 1:02:03 or seconds. Only with EPISODE.")
@click.option("--next-flagged", "next_flagged_", is_flag=True,
              help="Open the oldest flagged episode that is not marked reviewed yet.")
@click.option("--next-repair", "next_repair_", is_flag=True,
              help="Open the newest episode with an undecided repair, at that repair.")
@click.option("--report", "report_id", type=click.IntRange(min=1), default=None,
              help="Open the passage a listener reported, and let the page close the report.")
@click.option("--env", default=None,
              help="Environment to read the report from [default: run_env in config.toml]. "
                   "Only with --report.")
@click.option("--port", type=int, default=0, show_default=True,
              help="Port on 127.0.0.1 (0: a free one).")
@click.option("--no-open", is_flag=True, help="Print the URL without opening the browser.")
def review_cmd(
    episode: str | None,
    at: str | None,
    next_flagged_: bool,
    next_repair_: bool,
    report_id: int | None,
    env: str | None,
    port: int,
    no_open: bool,
) -> None:
    """Check an episode's transcript by ear in the browser, and fix a word with a rule.

    EPISODE is a number (71) or a selector (stem:S, ep:71), as in `wts links`; give exactly one
    of EPISODE, --next-flagged, --next-repair and --report. The server listens on 127.0.0.1
    only, prints a URL that holds this run's secret token, and stops on Ctrl-C.

    --at on a repair's time (the Repairs line's button) opens that repair, as --next-repair
    does.

    Press `t` on the page to add a test search for the passage to eval/queries.yaml; its
    "Check" searches run_env.

    For tests: WTS_REVIEW_TOKEN sets the token, WTS_CORRECTIONS_FILE the corrections file
    to edit (default pipeline/corrections.yaml) and WTS_EVAL_FILE the case file (default
    eval/queries.yaml).
    """
    import os
    import webbrowser
    from pathlib import Path

    from wts.corrections import CORRECTIONS_FILE
    from wts.links import parse_time
    from wts.review.data import chunk_position, next_flagged, next_repair
    from wts.review.server import ReviewApp, serve
    from wts.selection import resolve_selector

    if [episode is not None, next_flagged_, next_repair_, report_id is not None].count(True) != 1:
        raise click.UsageError(
            "give exactly one of EPISODE, --next-flagged, --next-repair or --report"
        )
    at_ms = None
    if at is not None:
        if episode is None:
            raise click.UsageError(
                "--at goes with EPISODE, not --next-flagged, --next-repair or --report"
            )
        try:
            at_ms = parse_time(at) * 1000
        except ValueError as exc:
            raise click.BadParameter(str(exc), param_hint="--at") from exc
    ctx = _ctx()
    client = None  # the report's D1 uses it; it stays open while the server runs
    d1 = None
    try:
        if report_id is not None:
            from wts.cloudflare import CloudflareError
            from wts.net import new_client
            from wts.reports import format_reports, get_report

            client = new_client()
            try:
                d1 = _reports_d1(env, client)
                report = get_report(d1, report_id)
            except CloudflareError as exc:  # never holds the token
                raise click.ClickException(str(exc)) from exc
            if report is None:
                raise click.ClickException(f"no report #{report_id}")
            shown = format_reports([report], color=False)
            if report.chunk_id is None:
                raise click.ClickException(
                    f"report #{report_id} is feedback with no passage to open\n\n{shown}"
                )
        conn = ctx.conn()
        try:
            if report_id is not None:
                position = chunk_position(conn, report.chunk_id)
                if position is None:
                    raise click.ClickException(
                        f"this Mac no longer has the passage of report #{report_id} "
                        f"(it was re-chunked)\n\n{shown}"
                    )
                episode_id, at_ms = position
                row = conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()
            elif next_repair_:
                found = next_repair(conn)
                if found is None:
                    raise click.ClickException("no undecided repairs left to review")
                row, at_ms = found
            elif episode is None:
                row = next_flagged(conn)
                if row is None:
                    raise click.ClickException("no flagged episodes left to review")
            else:
                ids = resolve_selector(conn, f"ep:{episode}" if episode.isdigit() else episode)
                if not ids:
                    raise click.ClickException(f"no episode matches {episode!r}")
                if len(ids) > 1:
                    stems = ", ".join(
                        conn.execute("select stem from episodes where id = ?", (i,)).fetchone()[0]
                        for i in ids
                    )
                    raise click.ClickException(
                        f"{episode!r} matches more than one episode: {stems}"
                    )
                row = conn.execute("select * from episodes where id = ?", (ids[0],)).fetchone()
            if not row["transcript_path"]:
                raise click.ClickException(
                    f"{row['stem']} has no transcript yet (status: {row['status']})"
                )
            episode_id = row["id"]
        finally:
            conn.close()

        from wts.db import connect

        # The test-search panel checks a search against run_env, as `wts eval run` does.
        searcher = None
        try:
            api_url = ctx.cfg.api_url(ctx.cfg.run_env) if ctx.cfg.run_env else None
        except click.UsageError:
            api_url = None
        if api_url:
            from wts.net import new_client
            from wts.search import search

            if client is None:
                client = new_client()
            search_client = client

            def searcher(q: str, mode: str) -> dict:
                return search(search_client, api_url, q, mode=mode, debug=mode == "related")

        corrections_file = os.environ.get("WTS_CORRECTIONS_FILE")
        eval_file = os.environ.get("WTS_EVAL_FILE")
        app = ReviewApp(
            lambda: connect(ctx.paths.state_db),
            ctx.paths,
            corrections_file=Path(corrections_file) if corrections_file else CORRECTIONS_FILE,
            token=os.environ.get("WTS_REVIEW_TOKEN") or None,
            d1=d1,
            eval_file=Path(eval_file) if eval_file else None,
            searcher=searcher,
        )
        server = serve(app, port)
        try:
            url = app.url(
                server.server_address[1], episode_id, at_ms, report_id=report_id
            )
            click.echo(url)
            if not no_open:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        finally:
            server.server_close()
    finally:
        if client is not None:
            client.close()


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
    click.echo(f"added={c['added']} updated={c['updated']} reset={c['reset']} "
               f"scoped={c['scoped']}")
    click.echo(platform_summary(conn, c))


@main.command("run")
@select_option
@click.option("--env", "env", type=click.Choice(ENV_NAMES), default=None,
              help="Environment to publish to [default: run_env in config.toml; with neither, "
                   "nothing is published].")
@click.option("--local-transcribe", is_flag=True,
              help="Transcribe on this Mac even if transcribe_url is set.")
def run_cmd(selector: str, env: str | None, local_transcribe: bool) -> None:
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
        results = run_all(ctx.conn(), ctx.paths, ctx.cfg, selector, env=env,
                          local_transcribe=local_transcribe)
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


_reports_env_option = click.option(
    "--env", "env", type=click.Choice(ENV_NAMES), default=None,
    help="Environment to read [default: run_env in config.toml].")


def _reports_d1(env: str | None, client):
    """The D1 for `env` (or run_env), with the usual config and token errors."""
    from wts.reports import open_d1
    from wts.secrets import get_store

    ctx = _ctx()
    name = env or ctx.cfg.run_env
    if not name:
        raise click.UsageError(f"no environment: use --env or run_env in {ctx.paths.config_file}")
    return open_d1(ctx.cfg, name, get_store(), client)


@main.group("reports", invoke_without_command=True)
@_reports_env_option
@click.option("--all", "show_all", is_flag=True, help="Include resolved and rejected reports.")
@click.option("--json", "as_json", is_flag=True, help="Print the reports as JSON.")
@click.pass_context
def reports_cmd(ctx: click.Context, env: str | None, show_all: bool, as_json: bool) -> None:
    """List listener reports from D1 (open ones unless --all), or close them.

    wts reports resolve|reject|reopen ID... changes the status of those reports.
    """
    ctx.obj = {"env": env}
    if ctx.invoked_subcommand is not None:
        return
    import json
    from dataclasses import asdict

    from wts.cloudflare import CloudflareError
    from wts.net import new_client
    from wts.reports import format_reports, list_reports

    try:
        with new_client() as client:
            reports = list_reports(_reports_d1(env, client), status=None if show_all else "open")
    except CloudflareError as exc:  # never holds the token
        raise click.ClickException(str(exc)) from exc
    if as_json:
        click.echo(json.dumps([asdict(r) for r in reports], indent=2, ensure_ascii=False))
    elif not reports:
        click.echo("no reports" if show_all else "no open reports")
    else:
        color = sys.stdout.isatty()
        click.echo(format_reports(reports, color=color), color=color)


def _reports_close(ctx: click.Context, env: str | None, ids: tuple[int, ...], status: str) -> None:
    from wts.cloudflare import CloudflareError
    from wts.net import new_client
    from wts.reports import set_status

    missing = False
    try:
        with new_client() as client:
            d1 = _reports_d1(env or ctx.obj["env"], client)
            for report_id in ids:
                if set_status(d1, report_id, status):
                    click.echo(f"#{report_id} {status}")
                else:
                    click.echo(f"#{report_id} not found")
                    missing = True
    except CloudflareError as exc:  # never holds the token
        raise click.ClickException(str(exc)) from exc
    if missing:
        raise SystemExit(1)


def _reports_status_command(name: str, status: str, verb: str) -> None:
    @reports_cmd.command(name, help=f"Mark reports {verb}; exit 1 if any ID is not found.")
    @_reports_env_option
    @click.argument("ids", nargs=-1, required=True, type=click.IntRange(min=1))
    @click.pass_context
    def _command(ctx: click.Context, env: str | None, ids: tuple[int, ...]) -> None:
        _reports_close(ctx, env, ids, status)


_reports_status_command("resolve", "resolved", "resolved")
_reports_status_command("reject", "rejected", "rejected")
_reports_status_command("reopen", "open", "open again")
