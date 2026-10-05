import json
import logging
import os

from wts.log import clock, describe, describe_run, setup_logging


def test_clock_formats_minutes_and_hours():
    assert [clock(s) for s in (0, 59.6, 60, 3599, 3600, 5532)] == [
        "0:00", "1:00", "1:00", "59:59", "1:00:00", "1:32:12"
    ]


def test_describe_counts_with_time():
    assert describe({"ok": 35, "chunks": 4120, "seconds": 48}) == "ok=35 chunks=4120 in 0:48"
    assert describe({"seconds": 1}) == "nothing to do (0:01)"
    assert describe({"ok": 3, "error": 0, "refreshed": 0}) == "ok=3"
    assert describe({}) == "nothing to do"


def test_describe_run_lists_steps_and_total():
    results = {"download": {"seconds": 2}, "transcribe": {"ok": 28, "seconds": 5530}}
    assert describe_run(results) == (
        "download: nothing to do (0:02)\n"
        "transcribe: ok=28 in 1:32:10\n"
        "total 1:32:12"
    )


def _last_line(tmp_path):
    return json.loads(next(tmp_path.glob("wts-*.log")).read_text().splitlines()[-1])


def test_log_line_is_json_with_fixed_keys(tmp_path):
    log = setup_logging(tmp_path, "run-1", console=False)
    log.info(
        "downloaded",
        extra={"episode": "2017-03-14_ep312_x", "step": "download", "duration_ms": 12},
    )
    line = _last_line(tmp_path)
    assert set(line) == {"ts", "run_id", "episode", "step", "duration_ms", "level", "msg", "error"}
    assert (line["run_id"], line["step"], line["level"]) == ("run-1", "download", "INFO")
    assert line["error"] is None


def test_exception_is_logged_in_error_field(tmp_path):
    log = setup_logging(tmp_path, "run-2", console=False)
    try:
        raise ValueError("bad audio")
    except ValueError:
        log.exception("download failed", extra={"step": "download"})
    assert "bad audio" in _last_line(tmp_path)["error"]


def test_old_logs_are_pruned(tmp_path):
    old = tmp_path / "wts-2000-01-01.log"
    old.write_text("{}\n")
    os.utime(old, (0, 0))
    setup_logging(tmp_path, "r", console=False)
    assert not old.exists()


def test_setup_twice_does_not_duplicate_lines(tmp_path):
    setup_logging(tmp_path, "a", console=False)
    log = setup_logging(tmp_path, "b", console=False)
    log.info("once")
    lines = next(tmp_path.glob("wts-*.log")).read_text().splitlines()
    assert sum(1 for x in lines if '"once"' in x) == 1
    logging.getLogger("wts").handlers.clear()
