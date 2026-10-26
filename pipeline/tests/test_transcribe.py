import json
import shutil
import subprocess

import pytest
from conftest import FakeTranscriber, reason_of, status_of, stem_of

from wts.steps import run_transcribe
from wts.transcribe import VOCAB_FILE, MlxWhisperTranscriber, build_initial_prompt


def test_prompt_is_capped_and_hashed(tmp_path):
    v = tmp_path / "vocab.txt"
    v.write_text("# brands\n\n" + "\n".join(f"term{i}" for i in range(500)))
    prompt, sha = build_initial_prompt(v)
    assert prompt.startswith("Wood Talk, a woodworking podcast")
    assert len(prompt.split()) <= 150 and len(sha) == 64 and "#" not in prompt


def test_shipped_vocab_builds_a_prompt():
    prompt, _ = build_initial_prompt(VOCAB_FILE)
    assert "SawStop" in prompt and len(prompt.split()) <= 150


def test_transcript_written_atomically_with_meta(conn, make_episode, paths, cfg, audio_file):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    counts = run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber())
    out = paths.transcripts_dir / f"{stem_of(conn, e)}.json"
    data = json.loads(out.read_text())
    assert {"guid", "title", "model", "model_version", "vocab_sha256", "machine",
            "transcribed_at", "duration_s"} <= set(data["meta"])
    assert data["meta"]["model"] == "fake-whisper"
    assert data["segments"][0]["words"][0]["probability"] <= 1.0
    assert status_of(conn, e) == "transcribed" and counts["ok"] == 1
    row = conn.execute("select transcript_path from episodes where id = ?", (e,)).fetchone()
    assert row[0] == str(out)
    assert not list(paths.transcripts_dir.glob("*.tmp"))


def test_newest_episodes_are_transcribed_first(conn, make_episode, paths, cfg):
    paths.audio_dir.mkdir(parents=True, exist_ok=True)
    heard = []

    class RecordingTranscriber(FakeTranscriber):
        def transcribe(self, audio, initial_prompt):
            heard.append(audio.name)
            return super().transcribe(audio, initial_prompt)

    ids = []
    for day in ("2007-04-01", "2026-09-17", "2015-07-10"):
        audio = paths.audio_dir / f"{day}.mp3"
        audio.write_bytes(b"fake audio")
        ids.append(make_episode(audio_path=str(audio), status="downloaded",
                                published_at=f"{day}T00:00:00+00:00"))
    run_transcribe(conn, paths, cfg, ids, transcriber=RecordingTranscriber())
    assert heard == ["2026-09-17.mp3", "2015-07-10.mp3", "2007-04-01.mp3"]


def test_progress_reports_time_speed_and_estimate(conn, make_episode, paths, cfg, audio_file,
                                                  monkeypatch, wts_messages):
    from wts import steps

    clock = iter(range(0, 10_000, 60))  # every reading is 60 s after the last
    monkeypatch.setattr(steps.time, "monotonic", lambda: next(clock))
    ids = [
        make_episode(audio_path=str(audio_file), status="downloaded", duration_s=3600,
                     published_at=f"2026-0{m}-01T00:00:00+00:00")
        for m in (1, 2)
    ]
    run_transcribe(conn, paths, cfg, ids, transcriber=FakeTranscriber())
    assert wts_messages == [
        "transcribed in 1:00 (1:00:00 of audio, 60.0× realtime); 1 of 2, about 1:00 left",
        "transcribed in 1:00 (1:00:00 of audio, 60.0× realtime); 2 of 2",
        "transcribed 2 episodes in 2:00 (2:00:00 of audio, 60.0× realtime)",
    ]


def test_interrupt_leaves_no_transcript_and_status_unchanged(
    conn, make_episode, paths, cfg, audio_file
):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    with pytest.raises(KeyboardInterrupt):
        run_transcribe(
            conn, paths, cfg, [e], transcriber=FakeTranscriber(raise_exc=KeyboardInterrupt())
        )
    assert status_of(conn, e) == "downloaded"
    assert not any(paths.transcripts_dir.glob("*"))


def test_backend_crash_fails_episode(conn, make_episode, paths, cfg, audio_file):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber(raise_exc=MemoryError("oom")))
    assert status_of(conn, e) == "error" and "oom" in reason_of(conn, e)


def test_missing_audio_file_fails_episode(conn, make_episode, paths, cfg):
    paths.audio_dir.mkdir(parents=True)
    e = make_episode(audio_path=str(paths.audio_dir / "gone.mp3"), status="downloaded")
    run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber())
    assert status_of(conn, e) == "error"


def test_audio_folder_vanishing_does_not_burn_retries(
    conn, make_episode, paths, cfg, audio_file, monkeypatch
):
    from conftest import fail_after_first_call, retries_of

    from wts import storage
    from wts.storage import StorageUnavailable

    e = make_episode(audio_path=str(audio_file), status="downloaded")
    audio_file.unlink()  # the share dropped: reading the file fails
    monkeypatch.setattr(storage, "check_audio_dir", fail_after_first_call(StorageUnavailable))
    with pytest.raises(StorageUnavailable):
        run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber())
    assert (status_of(conn, e), retries_of(conn, e)) == ("downloaded", 0)


def test_get_transcriber_picks_remote_or_local(cfg):
    from dataclasses import replace

    from wts.transcribe import get_transcriber
    from wts.transcribe_remote import RemoteTranscriber

    remote = replace(cfg, transcribe_url="https://t.example")
    assert isinstance(get_transcriber(remote), RemoteTranscriber)
    assert isinstance(get_transcriber(remote, local=True), MlxWhisperTranscriber)
    assert isinstance(get_transcriber(cfg), MlxWhisperTranscriber)
    assert isinstance(get_transcriber(), MlxWhisperTranscriber)


def test_machine_comes_from_remote_transcriber(conn, make_episode, paths, cfg, audio_file):
    import platform

    class Walnut(FakeTranscriber):
        machine = "walnut"

    e = make_episode(audio_path=str(audio_file), status="downloaded")
    run_transcribe(conn, paths, cfg, [e], transcriber=Walnut())
    meta = json.loads((paths.transcripts_dir / f"{stem_of(conn, e)}.json").read_text())["meta"]
    assert meta["machine"] == "walnut"

    f = make_episode(audio_path=str(audio_file), status="downloaded")
    run_transcribe(conn, paths, cfg, [f], transcriber=FakeTranscriber())
    meta = json.loads((paths.transcripts_dir / f"{stem_of(conn, f)}.json").read_text())["meta"]
    assert meta["machine"] == platform.node()


def test_unavailable_stops_step_and_keeps_retries(conn, make_episode, paths, cfg, audio_file):
    from conftest import retries_of

    from wts.transcribe_remote import TranscriberUnavailable

    ids = [make_episode(audio_path=str(audio_file), status="downloaded") for _ in range(3)]
    down = FakeTranscriber(raise_exc=TranscriberUnavailable("walnut unreachable (ConnectError)"))
    with pytest.raises(TranscriberUnavailable) as info:
        run_transcribe(conn, paths, cfg, ids, transcriber=down)
    assert str(info.value) == (
        "walnut unreachable (ConnectError); 3 episodes left to transcribe"
    )
    assert [(status_of(conn, e), retries_of(conn, e)) for e in ids] == [("downloaded", 0)] * 3


def test_remote_job_failure_fails_the_episode(conn, make_episode, paths, cfg, audio_file):
    from conftest import retries_of

    from wts.transcribe_remote import RemoteJobFailed

    class FailsFirst(FakeTranscriber):
        def transcribe(self, audio, initial_prompt):
            if self.calls == 0:
                self.calls += 1
                raise RemoteJobFailed("transcribe: error: boom")
            return super().transcribe(audio, initial_prompt)

    newer = make_episode(audio_path=str(audio_file), status="downloaded",
                         published_at="2026-02-01T00:00:00+00:00")
    older = make_episode(audio_path=str(audio_file), status="downloaded",
                         published_at="2026-01-01T00:00:00+00:00")
    counts = run_transcribe(conn, paths, cfg, [newer, older], transcriber=FailsFirst())
    assert (status_of(conn, newer), retries_of(conn, newer)) == ("error", 1)
    assert "boom" in reason_of(conn, newer)
    assert status_of(conn, older) == "transcribed"
    assert counts == {"ok": 1, "error": 1}


def _remote(handler):
    import httpx

    from wts.transcribe_remote import RemoteTranscriber

    return RemoteTranscriber("https://t.example", sleep=lambda s: None,
                             client=httpx.Client(transport=httpx.MockTransport(handler)))


def _done_result():
    return {
        "status": "done", "machine": "walnut",
        "result": {"model": "m", "model_version": "0.4.3", "segments": [
            {"start": 0.0, "end": 1.0, "text": " Hi.", "no_speech_prob": 0.0, "avg_logprob": -0.1,
             "words": [{"start": 0.0, "end": 1.0, "word": " Hi.", "probability": 0.9}]},
        ]},
    }


def test_ctrl_c_during_remote_transcription_keeps_episode(
    conn, make_episode, paths, cfg, audio_file
):
    import httpx
    from conftest import retries_of

    def handler(request):
        if request.method == "POST":
            return httpx.Response(202, json={"id": "j1"})
        raise KeyboardInterrupt

    e = make_episode(audio_path=str(audio_file), status="downloaded")
    with pytest.raises(KeyboardInterrupt):
        run_transcribe(conn, paths, cfg, [e], transcriber=_remote(handler))
    assert (status_of(conn, e), retries_of(conn, e)) == ("downloaded", 0)


def test_remote_path_needs_no_mlx(conn, make_episode, paths, cfg, audio_file, monkeypatch):
    import sys

    import httpx

    monkeypatch.setitem(sys.modules, "mlx_whisper", None)  # import mlx_whisper now fails

    def handler(request):
        if request.method == "POST":
            return httpx.Response(202, json={"id": "j1"})
        return httpx.Response(200, json=_done_result())

    e = make_episode(audio_path=str(audio_file), status="downloaded")
    counts = run_transcribe(conn, paths, cfg, [e], transcriber=_remote(handler))
    assert counts["ok"] == 1 and status_of(conn, e) == "transcribed"


@pytest.mark.mac
def test_mlx_backend_smoke(tmp_path):  # run manually on the Mac: uv run pytest -m mac
    assert shutil.which("ffmpeg")
    f = tmp_path / "tone.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=10", str(f)], check=True
    )
    t = MlxWhisperTranscriber().transcribe(f, "Wood Talk")
    assert t.model.endswith("whisper-large-v3-turbo") and t.model_version
