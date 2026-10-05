import json
import logging
import os

from wts.log import setup_logging


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
