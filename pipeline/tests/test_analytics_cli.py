"""`wts analytics pull` and `wts analytics report` (analytics design §2.4, §3.1). The SQL API is
mocked with respx; the token comes from the environment, as off the Mac."""

from datetime import UTC, datetime

import httpx
import pytest
import respx
from click.testing import CliRunner

from wts.cli import main

ACCOUNT = "acct0123"
SQL_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/analytics_engine/sql"
TOKEN_VAR = "WTS_SECRET_CLOUDFLARE_ANALYTICS_TOKEN"


@pytest.fixture
def home(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(
        f'cloudflare_account_id = "{ACCOUNT}"\nrun_env = "staging"\n')
    monkeypatch.setenv(TOKEN_VAR, "analytics-token-SECRET")
    return wts_home


def _today_rows(request: httpx.Request) -> httpx.Response:
    now = datetime.now(UTC)
    today = now.strftime("%Y-%m-%d")
    ts = now.strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    if f"timestamp >= toDateTime('{today} 00:00:00')" in request.content.decode():
        rows = [{"timestamp": ts, "index1": "search", "blob1": q, "blob2": "exact",
                 "blob3": "relevance", "blob4": "miss", "blob5": "web", "double1": 3,
                 "double2": 40, "double3": 0, "double4": 1, "double5": 200,
                 "_sample_interval": 1} for q in ("hide glue", "drawboring")]
    return httpx.Response(200, json={"meta": [], "data": rows, "rows": len(rows)})


@respx.mock
def test_pull_then_summary(home):
    respx.post(SQL_URL).mock(side_effect=_today_rows)
    result = CliRunner().invoke(main, ["analytics", "pull"])
    assert result.exit_code == 0, result.output
    assert "pulled 2 points" in result.output and "(staging)" in result.output
    assert "Top searches" in result.output and "drawboring" in result.output
    assert "analytics-token-SECRET" not in result.output
    assert (home / "analytics.db").exists()

    again = CliRunner().invoke(main, ["analytics", "report"])
    assert again.exit_code == 0, again.output
    assert "Searches: 2" in again.output


def test_pull_missing_secret(home, monkeypatch):
    monkeypatch.delenv(TOKEN_VAR)
    monkeypatch.setattr("wts.secrets.sys.platform", "linux")
    result = CliRunner().invoke(main, ["analytics", "pull"])
    assert result.exit_code != 0
    assert "cloudflare_analytics_token" in result.output


def test_pull_without_an_environment(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(f'cloudflare_account_id = "{ACCOUNT}"\n')
    monkeypatch.setenv(TOKEN_VAR, "t")
    result = CliRunner().invoke(main, ["analytics", "pull"])
    assert result.exit_code != 0
    assert "--env" in result.output


@respx.mock
def test_pull_reports_a_cloudflare_error_without_a_traceback(home):
    respx.post(SQL_URL).respond(400, json={"success": False, "errors": [
        {"code": 10000, "message": "Authentication error"}]})
    result = CliRunner().invoke(main, ["analytics", "pull"])
    assert result.exit_code != 0
    assert "Authentication error" in result.output
    assert "Traceback" not in result.output


def test_report_before_any_pull(home):
    result = CliRunner().invoke(main, ["analytics", "report"])
    assert result.exit_code == 1
    assert "no analytics pulled for staging yet; run wts analytics pull" in result.output


def test_report_bad_since(home):
    result = CliRunner().invoke(main, ["analytics", "report", "--since", "yesterday"])
    assert result.exit_code == 2
    assert "--since" in result.output


@respx.mock
def test_report_does_not_touch_the_network(home):
    respx.post(SQL_URL).mock(side_effect=_today_rows)
    assert CliRunner().invoke(main, ["analytics", "pull"]).exit_code == 0
    respx.reset()
    blocked = respx.post(SQL_URL).mock(side_effect=AssertionError("report called Cloudflare"))
    result = CliRunner().invoke(main, ["analytics", "report", "--since", "30d", "--all"])
    assert result.exit_code == 0, result.output
    assert not blocked.called
