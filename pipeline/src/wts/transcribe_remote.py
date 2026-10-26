"""Transcription on walnut through transcribe-web (spec 2026-10-26 §4.1).

Uploads the MP3, polls for the result and returns the same `RawTranscript` the local MLX
transcriber makes. httpx only: nothing here imports MLX, so the transcribe step runs on a
Linux machine too (the later Forgejo runner).

Two kinds of failure, kept apart on purpose: the server being unreachable is a machine problem
(the run stops and no episode is charged a retry); a job the server ran and failed is the
episode's (it is failed like a local error).
"""

import logging
import time
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import quote

import httpx

from wts.storage import MachineProblem
from wts.transcribe import RawSegment, RawTranscript, RawWord

log = logging.getLogger("wts")

ENGINE = "mlx"
MAX_UPLOAD = 100 * 1024 * 1024  # transcribe-web's cap (spec 2026-10-26 §3.3)


class TranscriberUnavailable(MachineProblem):
    """The transcription server can't be reached or isn't answering: stop, retry next run."""


class RemoteJobFailed(Exception):
    """The server ran the job and it failed, or sent back something that isn't a transcript."""


def installed_mlx_whisper() -> str:
    """The local mlx-whisper version; raises PackageNotFoundError where it isn't installed."""
    return version("mlx-whisper")


class RemoteTranscriber:
    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.Client | None = None,
        poll_s: float = 5.0,
        max_wait_s: float = 7200.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.base_url = base_url.rstrip("/")
        self.host = httpx.URL(self.base_url).host
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, connect=10))
        self.poll_s = poll_s
        self.max_wait_s = max_wait_s
        self.clock = clock
        self.sleep = sleep
        self.machine: str | None = None

    def _unavailable(self, reason: str) -> TranscriberUnavailable:
        return TranscriberUnavailable(f"{self.host} unreachable ({reason})")

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self.client.request(method, f"{self.base_url}{path}", **kwargs)
        except httpx.TransportError as exc:  # connect, timeout, protocol, read/write
            raise self._unavailable(type(exc).__name__) from exc
        if response.status_code >= 500:
            raise self._unavailable(f"HTTP {response.status_code} on {method} {path}")
        return response

    def _answer(self, response: httpx.Response, *keys: str) -> dict:
        """The JSON body with `keys` present; anything else isn't transcribe-web answering."""
        try:
            body = response.json()
            for key in keys:
                body[key]
        except (ValueError, KeyError, TypeError) as exc:
            raise self._unavailable(f"not a transcribe-web answer: HTTP {response.status_code}"
                                    ) from exc
        return body

    def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript:
        # Checked here: the server answers an oversized upload by closing the connection, which
        # would look like an outage and stop every run at this episode.
        if audio.stat().st_size > MAX_UPLOAD:
            raise RemoteJobFailed(f"{audio.name} is over the server's 100 MB upload limit")
        started = self.clock()
        response = self._request(
            "POST",
            "/jobs/upload",
            params={"engine": ENGINE},
            content=audio.read_bytes(),  # an episode is ~35 MB; the server caps uploads at 100 MB
            headers={
                "Content-Type": "audio/mpeg",
                "X-Transcribe-Prompt": quote(initial_prompt, safe=""),
            },
        )
        if response.status_code in (400, 413):  # the server judged this file: the episode's
            raise RemoteJobFailed(f"{self.host} refused the upload: HTTP {response.status_code} "
                                  f"{response.text[:200]}")
        if response.status_code != 202:  # no upload route (an old deploy) or a proxy in the way
            raise self._unavailable(f"HTTP {response.status_code} on upload")
        job = self._answer(response, "id")["id"]
        seen = 0
        while True:
            response = self._request("GET", f"/jobs/{job}")
            if response.status_code == 404:  # restarted (jobs live in memory) or expired
                raise self._unavailable(f"job {job} is gone")
            if response.status_code != 200:
                raise self._unavailable(f"HTTP {response.status_code} on GET /jobs/{job}")
            state = self._answer(response, "status")
            for line in state.get("steps", [])[seen:]:
                log.debug(f"{self.host}: {line}")
            seen = len(state.get("steps", []))
            if state["status"] == "done":
                break
            if state["status"] == "error":
                raise RemoteJobFailed(state.get("error") or "the server's job failed")
            if self.clock() - started >= self.max_wait_s:
                raise self._unavailable(f"no result after {self.max_wait_s / 3600:g} h")
            self.sleep(self.poll_s)
        self.machine = state.get("machine") or self.host.split(".")[0]
        transcript = self._parse(state.get("result"))
        self._check_version(transcript.model_version)
        return transcript

    def _parse(self, result) -> RawTranscript:
        try:
            return RawTranscript(
                segments=[
                    RawSegment(
                        start=float(s["start"]),
                        end=float(s["end"]),
                        text=s["text"],
                        no_speech_prob=float(s["no_speech_prob"]),
                        avg_logprob=float(s["avg_logprob"]),
                        words=[
                            RawWord(float(w["start"]), float(w["end"]), w["word"],
                                    float(w["probability"]))
                            for w in s["words"]
                        ],
                    )
                    for s in result["segments"]
                ],
                model=result["model"],
                model_version=result["model_version"],
            )
        except KeyError as exc:
            raise RemoteJobFailed(f"bad result from {self.host}: missing {exc}") from exc
        except (TypeError, ValueError) as exc:
            raise RemoteJobFailed(f"bad result from {self.host}: {exc}") from exc

    def _check_version(self, remote: str) -> None:
        try:
            local = installed_mlx_whisper()
        except PackageNotFoundError:
            return  # nothing to compare with here (e.g. a Linux machine)
        if remote != local:
            log.warning(f"{self.host} runs mlx-whisper {remote}, this machine {local}: "
                        "transcripts from the two may differ slightly")
