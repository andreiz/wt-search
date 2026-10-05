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


@pytest.mark.mac
def test_mlx_backend_smoke(tmp_path):  # run manually on the Mac: uv run pytest -m mac
    assert shutil.which("ffmpeg")
    f = tmp_path / "tone.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=10", str(f)], check=True
    )
    t = MlxWhisperTranscriber().transcribe(f, "Wood Talk")
    assert t.model.endswith("whisper-large-v3-turbo") and t.model_version
