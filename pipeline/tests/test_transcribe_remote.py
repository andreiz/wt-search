import logging
from importlib.metadata import PackageNotFoundError
from urllib.parse import unquote

import httpx
import pytest

from wts.storage import MachineProblem
from wts.transcribe import RawSegment, RawTranscript, RawWord
from wts.transcribe_remote import RemoteJobFailed, RemoteTranscriber, TranscriberUnavailable

URL = "https://transcribe.home.zmievski.org"
PROMPT = "Wood Talk, a woodworking podcast. Festool, Spagnuolo — SawStop."
RESULT = {
    "model": "mlx-community/whisper-large-v3-turbo",
    "model_version": "0.4.3",
    "segments": [
        {"start": 0.0, "end": 1.0, "text": " Welcome.", "no_speech_prob": 0.01,
         "avg_logprob": -0.2,
         "words": [{"start": 0.0, "end": 1.0, "word": " Welcome.", "probability": 0.98}]},
        {"start": 1.0, "end": 2.0, "text": " Glue.", "no_speech_prob": 0.02,
         "avg_logprob": -0.3,
         "words": [{"start": 1.0, "end": 2.0, "word": " Glue.", "probability": 0.4}]},
    ],
}


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "ep.mp3"
    path.write_bytes(b"ID3fake-mp3-bytes")
    return path


@pytest.fixture
def installed(monkeypatch):
    monkeypatch.setattr("wts.transcribe_remote.installed_mlx_whisper", lambda: "0.4.3")


def make(handler, clock=None):
    clock = clock or Clock()
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return RemoteTranscriber(URL, client=client, clock=clock, sleep=clock.sleep)


def jobs(*statuses, upload=None):
    """A handler: the upload answers 202 j1 (or `upload`), then each poll the next status."""
    polls = list(statuses)
    seen = {}

    def handler(request):
        if request.method == "POST":
            seen["upload"] = request
            return upload(request) if upload else httpx.Response(202, json={"id": "j1"})
        assert request.url.path == "/jobs/j1"
        item = polls.pop(0) if len(polls) > 1 else polls[0]
        if isinstance(item, Exception):
            raise item
        if isinstance(item, httpx.Response):
            return item
        return httpx.Response(200, json=item)

    handler.seen = seen
    return handler


def test_done_job_maps_to_raw_transcript(audio, installed):
    handler = jobs({"status": "running", "steps": ["transcribing"]},
                   {"status": "done", "result": RESULT, "machine": "walnut"})
    t = make(handler)
    got = t.transcribe(audio, PROMPT)
    assert got == RawTranscript(
        segments=[
            RawSegment(0.0, 1.0, " Welcome.", 0.01, -0.2, [RawWord(0.0, 1.0, " Welcome.", 0.98)]),
            RawSegment(1.0, 2.0, " Glue.", 0.02, -0.3, [RawWord(1.0, 2.0, " Glue.", 0.4)]),
        ],
        model="mlx-community/whisper-large-v3-turbo",
        model_version="0.4.3",
    )
    assert t.machine == "walnut"
    up = handler.seen["upload"]
    assert up.url.path == "/jobs/upload" and up.url.params["engine"] == "mlx"
    assert up.content == audio.read_bytes()
    assert up.headers["content-type"] == "audio/mpeg"
    assert unquote(up.headers["x-transcribe-prompt"]) == PROMPT


def test_machine_falls_back_to_url_host(audio, installed):
    t = make(jobs({"status": "done", "result": RESULT}))
    t.transcribe(audio, PROMPT)
    assert t.machine == "transcribe"


def _unavailable(t, audio):
    with pytest.raises(TranscriberUnavailable) as info:
        t.transcribe(audio, PROMPT)
    assert isinstance(info.value, MachineProblem)
    assert str(info.value).startswith("transcribe.home.zmievski.org unreachable")
    return info.value


def test_connect_error_is_unavailable(audio):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    assert "ConnectError" in str(_unavailable(make(handler), audio))


def test_5xx_is_unavailable(audio):
    _unavailable(make(jobs(upload=lambda r: httpx.Response(503))), audio)
    _unavailable(make(jobs(httpx.Response(502))), audio)


def test_own_job_404_is_unavailable(audio):
    _unavailable(make(jobs(httpx.Response(404, json={"error": "unknown job"}))), audio)


@pytest.mark.parametrize("status", [401, 403, 404, 405])
def test_upload_not_understood_is_unavailable(audio, status):
    # An old transcribe-web without the route, or a proxy in the way: the server, not the episode.
    _unavailable(make(jobs(upload=lambda r: httpx.Response(status, text="nope"))), audio)


def test_upload_rejecting_the_body_is_a_job_failure(audio):
    t = make(jobs(upload=lambda r: httpx.Response(400, json={"error": "upload incomplete"})))
    with pytest.raises(RemoteJobFailed, match="upload incomplete"):
        t.transcribe(audio, PROMPT)


def test_non_json_answers_are_unavailable(audio):
    html = httpx.Response(200, text="<html>Bad gateway</html>")
    _unavailable(make(jobs(upload=lambda r: httpx.Response(202, text="<html>"))), audio)
    _unavailable(make(jobs(html)), audio)
    _unavailable(make(jobs({"nothing": "here"})), audio)


def test_poll_not_200_is_unavailable(audio):
    _unavailable(make(jobs(httpx.Response(401, text="login"))), audio)


def test_audio_over_the_cap_fails_without_uploading(audio):
    from wts.transcribe_remote import MAX_UPLOAD

    audio.write_bytes(b"x" * (MAX_UPLOAD + 1))

    def handler(request):
        raise AssertionError("must not upload")

    with pytest.raises(RemoteJobFailed, match="100 MB"):
        make(handler).transcribe(audio, PROMPT)


def test_transport_error_is_unavailable(audio):
    def drop(request):
        raise httpx.RemoteProtocolError("peer closed", request=request)

    _unavailable(make(jobs(upload=drop)), audio)
    _unavailable(make(jobs(httpx.ReadError("reset"))), audio)


def test_stall_is_unavailable(audio):
    clock = Clock()
    exc = _unavailable(make(jobs({"status": "queued", "steps": []}), clock), audio)
    assert "no result after 2 h" in str(exc)
    assert set(clock.sleeps) == {5.0}
    assert clock.now >= 7200


def test_job_error_is_a_failure(audio):
    t = make(jobs({"status": "error", "error": "transcribe: error: boom"}))
    with pytest.raises(RemoteJobFailed, match="transcribe: error: boom") as info:
        t.transcribe(audio, PROMPT)
    assert not isinstance(info.value, MachineProblem)


def test_malformed_result_is_a_job_failure(audio, installed):
    bad = {"model": "m", "model_version": "0.4.3", "segments": [{"start": 0}]}
    t = make(jobs({"status": "done", "result": bad, "machine": "walnut"}))
    with pytest.raises(RemoteJobFailed, match="missing 'end'"):
        t.transcribe(audio, PROMPT)


def test_version_mismatch_warns(audio, installed, caplog):
    other = {**RESULT, "model_version": "9.9"}
    t = make(jobs({"status": "done", "result": other, "machine": "walnut"}))
    with caplog.at_level(logging.WARNING, logger="wts"):
        got = t.transcribe(audio, PROMPT)
    assert got.model_version == "9.9"
    assert any("9.9" in r.getMessage() and "0.4.3" in r.getMessage() for r in caplog.records)


def test_no_warning_without_local_mlx_whisper(audio, monkeypatch, caplog):
    def missing():
        raise PackageNotFoundError("mlx-whisper")

    monkeypatch.setattr("wts.transcribe_remote.installed_mlx_whisper", missing)
    t = make(jobs({"status": "done", "result": {**RESULT, "model_version": "9.9"}}))
    with caplog.at_level(logging.WARNING, logger="wts"):
        t.transcribe(audio, PROMPT)
    assert not caplog.records
