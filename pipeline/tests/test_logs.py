"""`wts logs` (plan 2, Task 16; spec §8.1, §8.4): read and filter the JSON-lines logs."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.log import setup_logging
from wts.logs import format_line, parse_since, read_logs

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
EP = "2017-03-14_ep312_hide-glue"


def line(ago: timedelta, run="run-a", level="INFO", msg="ok", **fields) -> dict:
    return {
        "ts": (NOW - ago).isoformat(timespec="milliseconds"), "run_id": run, "level": level,
        "msg": msg, "error": None, "episode": None, "step": None, "duration_ms": None, **fields,
    }


LINES = {
    "wts-2026-10-01.log": [
        line(timedelta(days=7, hours=1), msg="a week ago", step="feed"),
    ],
    "wts-2026-10-08.log": [
        line(timedelta(hours=13), level="WARNING", msg="ads", step="download", episode=EP),
        line(timedelta(hours=2), run="run-b", msg="chunked", step="chunk", episode=EP),
        line(timedelta(hours=1), run="run-b", level="ERROR", msg="embedding failed",
             step="embed", episode="2026-09-15_ep615_x",
             error="Traceback (most recent call last):\n  ...\nValueError: bad vector"),
        line(timedelta(minutes=10), run="run-b", level="CRITICAL", msg="stopped"),
    ],
}


@pytest.fixture
def log_dir(tmp_path):
    d = tmp_path / "logs"
    d.mkdir()
    for name, lines in LINES.items():
        (d / name).write_text("".join(json.dumps(x) + "\n" for x in lines))
    return d


def msgs(lines) -> list[str]:
    return [x["msg"] for x in lines]


def test_reads_every_file_in_date_order(log_dir):
    assert msgs(read_logs(log_dir)) == [
        "a week ago", "ads", "chunked", "embedding failed", "stopped"
    ]


def test_malformed_lines_are_skipped(log_dir):
    good = json.dumps(line(timedelta(minutes=1), msg="good"))
    (log_dir / "wts-2026-10-09.log").write_text(
        "\n".join(["not json", "[1, 2]", "{}", '{"msg": "no ts or level"}',
                   '{"ts": "2026-10-08T11:59', "",
                   json.dumps(line(timedelta(0), msg="bad ts") | {"ts": "yesterday"}),
                   good]) + "\n"
    )
    assert msgs(read_logs(log_dir))[-2:] == ["bad ts", "good"]
    # A time that doesn't parse can't be after the cutoff.
    assert msgs(read_logs(log_dir, since="1d", now=NOW))[-1] == "good"
    assert "bad ts" not in msgs(read_logs(log_dir, since="1d", now=NOW))


def test_no_log_dir_reads_nothing(tmp_path):
    assert list(read_logs(tmp_path / "missing")) == []


def test_filter_by_run(log_dir):
    assert msgs(read_logs(log_dir, run="run-b")) == ["chunked", "embedding failed", "stopped"]


def test_filter_by_episode_stem_or_part_of_it(log_dir):
    assert msgs(read_logs(log_dir, episode=EP)) == ["ads", "chunked"]
    assert msgs(read_logs(log_dir, episode="ep615")) == ["embedding failed"]


@pytest.mark.parametrize(
    ("level", "expected"),
    [("info", 5), ("warning", 3), ("WARNING", 3), ("error", 2), ("critical", 1)],
)
def test_level_is_a_minimum(log_dir, level, expected):
    assert len(list(read_logs(log_dir, level=level))) == expected


def test_unknown_level_is_rejected(log_dir):
    with pytest.raises(ValueError, match="loud"):
        list(read_logs(log_dir, level="loud"))


@pytest.mark.parametrize(
    ("since", "expected"),
    [("30m", ["stopped"]), ("12h", ["chunked", "embedding failed", "stopped"]),
     ("1d", ["ads", "chunked", "embedding failed", "stopped"]),
     ("7d", ["ads", "chunked", "embedding failed", "stopped"]),
     ("8d", ["a week ago", "ads", "chunked", "embedding failed", "stopped"])],
)
def test_filter_by_since(log_dir, since, expected):
    assert msgs(read_logs(log_dir, since=since, now=NOW)) == expected


def test_filters_combine(log_dir):
    assert msgs(read_logs(log_dir, run="run-b", episode="ep312", level="info",
                          since="12h", now=NOW)) == ["chunked"]


@pytest.mark.parametrize(("text", "expected"), [
    ("30m", timedelta(minutes=30)), ("12h", timedelta(hours=12)), ("7d", timedelta(days=7)),
    (" 2D ", timedelta(days=2)),
])
def test_parse_since(text, expected):
    assert parse_since(text) == expected


@pytest.mark.parametrize("text", ["", "7", "d", "7w", "-1d", "1.5h", "0d", "7 d"])
def test_parse_since_rejects(text):
    with pytest.raises(ValueError, match="30m, 12h or 7d"):
        parse_since(text)


def test_format_line_mirrors_the_console():
    lines = LINES["wts-2026-10-08.log"]
    assert format_line(lines[0], tz=UTC) == f"2026-10-07 23:00:00 run-a [warning download {EP}] ads"
    assert format_line(lines[2], tz=UTC) == (
        "2026-10-08 11:00:00 run-b [error embed 2026-09-15_ep615_x] embedding failed: "
        "ValueError: bad vector"
    )
    assert format_line(lines[3], tz=UTC) == "2026-10-08 11:50:00 run-b [critical] stopped"


# --- CLI ------------------------------------------------------------------------------------


@pytest.fixture
def logged(paths):
    """Lines written by the real logger now, so `--since` sees them."""
    log = setup_logging(paths.log_dir, "run-cli", console=False)
    log.info("chunked", extra={"step": "chunk", "episode": EP})
    log.warning("backup failed: not reachable", extra={"step": "backup"})
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    return paths


def test_cli_prints_readable_lines(logged):
    result = CliRunner().invoke(main, ["logs", "--since", "1h", "--level", "warning"])
    assert result.exit_code == 0, result.output
    (out,) = result.output.splitlines()
    assert out.endswith("run-cli [warning backup] backup failed: not reachable")


def test_cli_json_prints_the_lines_as_json(logged):
    result = CliRunner().invoke(main, ["logs", "--json", "--episode", "ep312", "--run", "run-cli"])
    assert result.exit_code == 0, result.output
    (out,) = result.output.splitlines()
    assert json.loads(out)["msg"] == "chunked"


def test_cli_says_when_nothing_matches(logged):
    result = CliRunner().invoke(main, ["logs", "--run", "nope"])
    assert result.exit_code == 0
    assert "no log lines match" in result.output


def test_cli_rejects_a_bad_since(logged):
    result = CliRunner().invoke(main, ["logs", "--since", "2w"])
    assert result.exit_code == 2
    assert "30m, 12h or 7d" in result.output
