"""`wts reports` (plan 4, Task 6): listing and closing listener reports in D1, with the Cloudflare
REST API mocked by respx."""

import json
from dataclasses import asdict

import httpx
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.cloudflare import D1, CloudflareApi
from wts.net import new_client
from wts.reports import (
    Report,
    format_reports,
    get_report,
    list_reports,
    new_since,
    open_d1,
    set_status,
)

ACCOUNT = "acc123"
DB = "5f3c1a2e-0000-4000-8000-d1d1d1d1d1d1"
TOKEN = "cf-token-SECRET-abcdef0123456789"
URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query"

CONFIG = f"""
cloudflare_account_id = "{ACCOUNT}"
run_env = "staging"

[env.staging]
d1_database_id = "{DB}"
vectorize_index = "wts-chunks-staging"
"""


def row(id_: int = 1, **overrides) -> dict:
    base = {
        "id": id_, "created_at": "2026-10-05 09:30:00", "status": "open", "chunk_id": 10,
        "quoted_text": "mark said", "suggested_text": "Marc said", "note": None,
        "episode_number": 71, "episode_title": "Hide Glue", "start_ms": 754_000,
    }
    return {**base, **overrides}


def envelope(*results: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "result": [
        {"success": True, "results": r} for r in results]})


@pytest.fixture
def route(respx_mock):
    return respx_mock.post(URL)


@pytest.fixture
def d1(route):
    return D1(CloudflareApi(new_client(), ACCOUNT, TOKEN), DB)


def sent(route, n: int = -1) -> dict:
    return json.loads(route.calls[n].request.content)


# --- the module --------------------------------------------------------------------------------


def test_list_reports_asks_for_open_ones_joined_and_ordered(route, d1):
    route.mock(return_value=envelope([row(1), row(2, chunk_id=None, episode_number=None)]))
    reports = list_reports(d1)
    assert [r.id for r in reports] == [1, 2]
    assert reports[0] == Report(
        id=1, created_at="2026-10-05 09:30:00", status="open", chunk_id=10,
        quoted_text="mark said", suggested_text="Marc said", note=None, episode_number=71,
        episode_title="Hide Glue", start_ms=754_000)
    assert reports[1].is_feedback and not reports[0].is_feedback
    body = sent(route)
    assert body["params"] == ["open", 200]
    sql = " ".join(body["sql"].split())
    assert "left join chunks c on c.id = r.chunk_id" in sql
    assert "left join episodes e on e.id = c.episode_id" in sql
    assert "where r.status = ?" in sql and sql.endswith("order by r.id limit ?")


def test_list_reports_with_no_status_lists_all(route, d1):
    route.mock(return_value=envelope([row(1, status="resolved")]))
    assert [r.status for r in list_reports(d1, status=None, limit=5)] == ["resolved"]
    body = sent(route)
    assert body["params"] == [5]
    assert "where" not in body["sql"]


def test_new_since_asks_for_open_reports_after_an_id(route, d1):
    route.mock(return_value=envelope([row(8), row(9, chunk_id=None)]))
    assert [r.id for r in new_since(d1, 7)] == [8, 9]
    body = sent(route)
    assert body["params"] == [7]
    sql = " ".join(body["sql"].split())
    assert "left join chunks c on c.id = r.chunk_id" in sql
    assert "where r.status = 'open' and r.id > ?" in sql
    assert sql.endswith("order by r.id limit 50")


def test_get_report(route, d1):
    route.mock(return_value=envelope([row(7)]))
    assert get_report(d1, 7).id == 7
    assert sent(route)["params"] == [7]
    route.mock(return_value=envelope([]))
    assert get_report(d1, 8) is None


def test_set_status_updates_with_returning(route, d1):
    route.mock(return_value=envelope([{"id": 3}]))
    assert set_status(d1, 3, "resolved") is True
    body = sent(route)
    assert body["sql"] == "update reports set status = ? where id = ? returning id"
    assert body["params"] == ["resolved", 3]
    route.mock(return_value=envelope([]))
    assert set_status(d1, 4, "rejected") is False


def test_set_status_refuses_an_unknown_status(route, d1):
    with pytest.raises(ValueError):
        set_status(d1, 3, "deleted")
    assert route.call_count == 0


def report(**overrides) -> Report:
    return Report(**{k: v for k, v in row().items()} | overrides)


def test_format_shows_where_what_and_how_to_open():
    out = format_reports([report(id=3, note="the host's name")], color=False)
    assert out.splitlines()[0] == "#3  2026-10-05  ep 71 at 12:34"
    assert '"mark said" → "Marc said"' in out
    assert "the host's name" in out
    assert out.splitlines()[-1] == "  wts review --report 3"


def test_format_without_a_suggestion_has_no_arrow():
    out = format_reports([report(suggested_text=None)], color=False)
    assert '"mark said"' in out and "→" not in out


def test_format_a_gone_chunk():
    out = format_reports(
        [report(episode_number=None, episode_title=None, start_ms=None)], color=False)
    assert "passage no longer in the index" in out
    assert "wts review --report 1" in out


def test_format_lists_feedback_apart_after_the_passages():
    out = format_reports([
        report(id=1, chunk_id=None, quoted_text=None, suggested_text=None, note="love it",
               episode_number=None, episode_title=None, start_ms=None),
        report(id=2)], color=False)
    assert out.index("#2") < out.index("Feedback") < out.index("#1")
    assert "#1  2026-10-05  feedback\n  love it" in out
    assert "wts review --report 1" not in out


def test_format_strips_control_characters_but_keeps_newline_and_tab():
    evil = "ok\x1b[2J\x1b]0;pwned\x07\rhidden\x00\x7f\u0085 fine\nline two\tx"
    out = format_reports([report(note=evil, quoted_text=evil, suggested_text=evil)], color=False)
    assert "\x1b" not in out and "\r" not in out and "\x07" not in out
    assert "\x00" not in out and "\x7f" not in out and "\u0085" not in out
    assert "ok[2J]0;pwnedhidden fine" in out
    assert "line two\tx" in out


def test_format_color_bolds_the_id():
    assert "\x1b[1m#1\x1b[0m" in format_reports([report()], color=True)


# --- open_d1 -----------------------------------------------------------------------------------


def test_open_d1_needs_the_env_table_and_the_token(wts_home):
    from wts.config import Config
    from wts.secrets import EnvStore

    store = EnvStore({"WTS_SECRET_CLOUDFLARE_API_TOKEN": TOKEN})
    with new_client() as client, pytest.raises(Exception, match=r"\[env.staging\]"):
        open_d1(Config(cloudflare_account_id=ACCOUNT), "staging", store, client)


# --- the command -------------------------------------------------------------------------------


@pytest.fixture
def cli(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(CONFIG)
    monkeypatch.setenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", TOKEN)


def invoke(*args: str):
    return CliRunner().invoke(main, ["reports", *args])


def test_cli_lists_open_reports_by_default(cli, route):
    route.mock(return_value=envelope([row(1), row(2, chunk_id=None, note="hi")]))
    result = invoke()
    assert result.exit_code == 0, result.output
    assert "#1  2026-10-05  ep 71 at 12:34" in result.output
    assert "Feedback" in result.output and "#2  2026-10-05  feedback" in result.output
    assert sent(route)["params"] == ["open", 200]
    assert TOKEN not in result.output


def test_cli_all_lists_every_status(cli, route):
    route.mock(return_value=envelope([row(1, status="resolved")]))
    assert invoke("--all").exit_code == 0
    assert sent(route)["params"] == [200]


def test_cli_says_when_nothing_is_open(cli, route):
    route.mock(return_value=envelope([]))
    result = invoke()
    assert result.exit_code == 0
    assert result.output.strip() == "no open reports"


def test_cli_json_has_every_field(cli, route):
    route.mock(return_value=envelope([row(1, note="a\x1bb"), row(2, chunk_id=None)]))
    result = invoke("--json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data == [asdict(r) for r in [
        report(note="a\x1bb"), report(id=2, chunk_id=None)]]
    assert set(data[0]) == set(Report.__dataclass_fields__)


def test_cli_removes_an_escape_sequence_from_a_note(cli, route):
    route.mock(return_value=envelope([row(1, note="\x1b[2Jgotcha")]))
    result = invoke()
    assert "\x1b" not in result.output and "gotcha" in result.output


def test_cli_resolve_sends_an_update_per_id_and_names_the_missing(cli, route):
    route.mock(side_effect=[envelope([{"id": 3}]), envelope([])])
    result = invoke("resolve", "3", "4")
    assert result.exit_code == 1
    assert result.output.splitlines() == ["#3 resolved", "#4 not found"]
    assert route.call_count == 2
    assert [sent(route, i)["params"] for i in (0, 1)] == [["resolved", 3], ["resolved", 4]]


def test_cli_reject_and_reopen(cli, route):
    route.mock(return_value=envelope([{"id": 5}]))
    result = invoke("reject", "5")
    assert result.exit_code == 0 and result.output.strip() == "#5 rejected"
    assert sent(route)["params"] == ["rejected", 5]
    result = invoke("reopen", "5")
    assert result.exit_code == 0 and result.output.strip() == "#5 open"
    assert sent(route)["params"] == ["open", 5]


def test_cli_takes_env_after_the_subcommand_too(cli, route):
    route.mock(return_value=envelope([{"id": 5}]))
    assert invoke("resolve", "5", "--env", "staging").exit_code == 0


def test_cli_a_missing_token_is_the_usual_error(cli, route, monkeypatch):
    monkeypatch.delenv("WTS_SECRET_CLOUDFLARE_API_TOKEN")
    result = invoke()
    assert result.exit_code != 0
    assert "cloudflare_api_token" in result.output
    assert route.call_count == 0


def test_cli_a_missing_env_table_is_the_usual_error(cli, route, wts_home):
    result = invoke("--env", "production")
    assert result.exit_code != 0
    assert "[env.production] d1_database_id" in result.output


def test_cli_without_any_env_asks_for_one(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(f'cloudflare_account_id = "{ACCOUNT}"\n')
    result = invoke()
    assert result.exit_code != 0
    assert "--env" in result.output


def test_cli_shows_a_cloudflare_error_without_the_token(cli, route):
    route.mock(return_value=httpx.Response(
        403, json={"success": False, "errors": [{"code": 10000, "message": f"bad {TOKEN}"}]}))
    result = invoke()
    assert result.exit_code == 1
    assert "10000" in result.output and TOKEN not in result.output
