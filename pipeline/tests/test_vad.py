import wave

import numpy as np

from wts.vad import SileroDetector


def test_silence_has_no_speech(tmp_path):
    path = tmp_path / "silence.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(np.zeros(16000 * 3, dtype=np.int16).tobytes())
    assert SileroDetector().speech(path) == []
