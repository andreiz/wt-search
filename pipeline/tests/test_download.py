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
from wts.storage import StorageUnavailable

EPISODE_ROW = {
    "stem": "2017-03-14_ep312_dado-stacks",
    "audio_url": "https://cdn.example.com/wt/312.mp3?tracking=1",
    "duration_s": 60,
}


@respx.mock
def test_download_resumes_with_range(tmp_path):
    partial = tmp_path / ".partial" / f"{EPISODE_ROW['stem']}.mp3"
    partial.parent.mkdir()
    partial.write_bytes(b"abc")
    route = respx.get(EPISODE_ROW["audio_url"]).mock(
        return_value=httpx.Response(206, content=b"def")
    )
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert route.calls[0].request.headers["Range"] == "bytes=3-"
    assert out == tmp_path / f"{EPISODE_ROW['stem']}.mp3"
    assert out.read_bytes() == b"abcdef" and not partial.exists()


@respx.mock
def test_full_response_to_range_request_restarts(tmp_path):
    partial = tmp_path / ".partial" / f"{EPISODE_ROW['stem']}.mp3"
    partial.parent.mkdir()
    partial.write_bytes(b"stale")
    respx.get(EPISODE_ROW["audio_url"]).mock(return_value=httpx.Response(200, content=b"fresh"))
    out = download_episode(httpx.Client(), EPISODE_ROW, tmp_path, probe=lambda p: 60.0)
    assert out.read_bytes() == b"fresh"


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
    row = conn.execute("select status, audio_path from episodes where id = ?", (e,)).fetchone()
    assert row["status"] == "downloaded" and Path(row["audio_path"]).read_bytes() == b"audio"
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
