"""Speech detection over an episode's audio (repair spec §5.1).

Silero VAD runs on CPU. Spans are (start_ms, end_ms) of detected speech.
"""

import subprocess
import warnings
from pathlib import Path
from typing import Any, Protocol

SAMPLE_RATE = 16000


class SpeechDetector(Protocol):
    def speech(self, audio: Path) -> list[tuple[int, int]]: ...


class SileroDetector:
    def __init__(self) -> None:
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            from silero_vad import load_silero_vad

            # torch warns about torch.jit.load; nothing for us to act on.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", FutureWarning)
                self._model = load_silero_vad()
        return self._model

    def speech(self, audio: Path) -> list[tuple[int, int]]:
        import numpy as np
        import torch
        from silero_vad import get_speech_timestamps

        proc = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(audio),
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "f32le",
                "-",
            ],
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip()
            raise RuntimeError(f"ffmpeg could not decode {audio.name}: {err}")
        samples = np.frombuffer(proc.stdout, dtype=np.float32)
        wav = torch.from_numpy(samples.copy())
        found = get_speech_timestamps(
            wav, self._load(), sampling_rate=SAMPLE_RATE, return_seconds=True
        )
        return [(round(s["start"] * 1000), round(s["end"] * 1000)) for s in found]
