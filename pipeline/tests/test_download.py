import json
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
import respx
from click.testing import CliRunner
from conftest import fail_after_first_call, reason_of, retries_of, status_of, url_of

from wts import storage
from wts.cli import main
from wts.download import ProbeError, download_episode, probe_duration_s
from wts.steps import run_download
from wts.storage import MachineProblem, StorageUnavailable

EPISODE_ROW = {
    "stem": "2017-03-14_ep312_dado-stacks",
    "audio_url": "https://cdn.example.com/wt/312.mp3?tracking=1",
    "duration_s": 60,
}


def _partial(tmp_path, content: bytes, url=None, validator='"v1"'):
    partial = tmp_path / ".partial" / f"{EPISODE_ROW['stem']}.mp3"
    partial.parent.mkdir(exist_ok=True)
    partial.write_bytes(content)
    meta = {"url": url or "https://cdn.example.com/wt/312.mp3", "validator": validator}
    partial.with_name(partial.name + ".json").write_text(json.dumps(meta))
    return partial


@respx.mock
def test_download_resumes_with_range_and_if_range(tmp_path):
    partial = _partial(tmp_path, b"abc")
    route = respx.get(EPISODE_ROW["audio_url"]).mock(
        return_value=httpx.Response(206, content=b"def")
    )
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    headers = route.calls[0].request.headers
    assert headers["Range"] == "bytes=3-" and headers["If-Range"] == '"v1"'
    assert out.path == tmp_path / f"{EPISODE_ROW['stem']}.mp3" and out.duration_s == 60.0
    assert out.path.read_bytes() == b"abcdef" and not partial.exists()
    assert not list((tmp_path / ".partial").iterdir())


@respx.mock
def test_full_response_to_range_request_restarts(tmp_path):
    _partial(tmp_path, b"stale")
    respx.get(EPISODE_ROW["audio_url"]).mock(return_value=httpx.Response(200, content=b"fresh"))
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert out.path.read_bytes() == b"fresh"


@respx.mock
def test_partial_without_validator_restarts_from_zero(tmp_path):
    _partial(tmp_path, b"old", validator=None)
    route = respx.get(EPISODE_ROW["audio_url"]).mock(
        return_value=httpx.Response(200, content=b"whole")
    )
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert "Range" not in route.calls[0].request.headers and out.path.read_bytes() == b"whole"


@respx.mock
def test_partial_from_a_different_url_is_not_spliced(tmp_path):
    _partial(tmp_path, b"old", url="https://other.example/old.mp3")
    route = respx.get(EPISODE_ROW["audio_url"]).mock(
        return_value=httpx.Response(200, content=b"new")
    )
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert "Range" not in route.calls[0].request.headers and out.path.read_bytes() == b"new"


@respx.mock
def test_416_means_partial_is_already_complete(tmp_path):
    _partial(tmp_path, b"complete")
    respx.get(EPISODE_ROW["audio_url"]).mock(return_value=httpx.Response(416))
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert out.path.read_bytes() == b"complete"


@respx.mock
def test_validator_is_saved_for_later_resume(tmp_path):
    respx.get(EPISODE_ROW["audio_url"]).mock(
        return_value=httpx.Response(200, content=b"abc", headers={"ETag": '"v9"'})
    )

    def interrupted_probe(p):
        meta = json.loads(p.with_name(p.name + ".json").read_text())
        assert meta == {"url": "https://cdn.example.com/wt/312.mp3", "validator": '"v9"'}
        return 60.0

    download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=interrupted_probe)


def test_missing_ffprobe_is_a_machine_problem(conn, make_episode, paths, cfg, monkeypatch):
    e = make_episode()
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(MachineProblem, match="ffprobe"):
        run_download(conn, paths, cfg, [e])
    assert status_of(conn, e) == "new" and retries_of(conn, e) == 0


@respx.mock
def test_abort_stops_queued_downloads_and_keeps_finished(conn, make_episodes, paths, cfg,
                                                         monkeypatch):
    first, second, third = make_episodes(3)
    respx.get(url_of(conn, first)).mock(return_value=httpx.Response(200, content=b"ok"))
    respx.get(url_of(conn, second)).mock(side_effect=OSError("Host is down"))
    third_route = respx.get(url_of(conn, third)).mock(return_value=httpx.Response(200))
    monkeypatch.setattr(storage, "check_audio_dir", fail_after_first_call(StorageUnavailable))
    with pytest.raises(StorageUnavailable):
        run_download(conn, paths, cfg, [first, second, third], probe=lambda p: 3600.0, workers=1)
    assert status_of(conn, first) == "downloaded"
    assert (status_of(conn, second), retries_of(conn, second)) == ("new", 0)
    assert status_of(conn, third) == "new" and third_route.call_count == 0


@respx.mock
def test_probe_mismatch_raises_and_discards_partial(tmp_path):
    respx.get(EPISODE_ROW["audio_url"]).mock(return_value=httpx.Response(200, content=b"x"))
    with pytest.raises(ProbeError, match="duration"):
        download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 50.0)
    assert not any((tmp_path / ".partial").iterdir())
    assert not (tmp_path / f"{EPISODE_ROW['stem']}.mp3").exists()


def test_storage_failure_leaves_episodes_untouched(conn, make_episode, paths, cfg):
    e = make_episode()
    with pytest.raises(StorageUnavailable):
        run_download(conn, replace(paths, audio_dir=Path("/nonexistent/x")), cfg, [e])
    assert status_of(conn, e) == "new" and retries_of(conn, e) == 0


@respx.mock
def test_successful_download_advances(conn, make_episode, paths, cfg):
    e = make_episode(duration_s=60)
    respx.get(url_of(conn, e)).mock(return_value=httpx.Response(200, content=b"audio"))
    counts = run_download(conn, paths, cfg, [e], probe=lambda p: 60.5)
    row = conn.execute(
        "select status, audio_path, audio_duration_s from episodes where id = ?", (e,)
    ).fetchone()
    assert row["status"] == "downloaded" and Path(row["audio_path"]).read_bytes() == b"audio"
    assert row["audio_duration_s"] == 60.5
    assert counts["ok"] == 1


@respx.mock
def test_duration_mismatch_fails_episode(conn, make_episode, paths, cfg):
    e = make_episode(duration_s=3600)
    respx.get(url_of(conn, e)).mock(return_value=httpx.Response(200, content=b"x"))
    counts = run_download(conn, paths, cfg, [e], probe=lambda p: 3000.0)  # 16.7% off
    assert status_of(conn, e) == "error" and "duration" in reason_of(conn, e)
    assert counts["error"] == 1


@respx.mock
def test_http_error_fails_episode(conn, make_episode, paths, cfg):
    e = make_episode()
    respx.get(url_of(conn, e)).mock(return_value=httpx.Response(404))
    run_download(conn, paths, cfg, [e], probe=lambda p: 3600.0)
    assert status_of(conn, e) == "error" and "404" in reason_of(conn, e)


@respx.mock
def test_mount_vanishes_mid_download_keeps_status(conn, make_episode, paths, cfg, monkeypatch):
    e = make_episode()
    respx.get(url_of(conn, e)).mock(side_effect=OSError("Host is down"))
    monkeypatch.setattr(storage, "check_audio_dir", fail_after_first_call(StorageUnavailable))
    with pytest.raises(StorageUnavailable):
        run_download(conn, paths, cfg, [e])
    assert status_of(conn, e) == "new" and retries_of(conn, e) == 0


def test_download_cli_exits_3_when_audio_dir_missing(wts_home):
    (wts_home / "config.toml").write_text('audio_dir = "/nonexistent/Volumes/media/wts/audio"\n')
    r = CliRunner().invoke(main, ["download", "--select", "all"])
    assert r.exit_code == 3 and "audio" in r.output.lower()


@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="needs ffprobe")
def test_probe_real_file(tmp_path):
    f = tmp_path / "tone.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=2", str(f)], check=True
    )
    assert abs(probe_duration_s(f) - 2.0) < 0.1


@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="needs ffprobe")
def test_probe_garbage_raises(tmp_path):
    f = tmp_path / "bad.mp3"
    f.write_bytes(b"not audio at all")
    with pytest.raises(ProbeError):
        probe_duration_s(f)
