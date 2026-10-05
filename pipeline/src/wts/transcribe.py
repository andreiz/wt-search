"""Whisper transcription (spec §3.2 `wts transcribe`). Stores raw output; cleanup is in `wts chunk`."""

import hashlib
import json
import platform
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

PIPELINE_DIR = Path(__file__).resolve().parents[2]
VOCAB_FILE = PIPELINE_DIR / "vocab.txt"
MAX_PROMPT_WORDS = 150
PROMPT_PREFIX = (
    "Wood Talk, a woodworking podcast with Marc Spagnuolo, Shannon Rogers and Matt Cremona."
)


@dataclass(frozen=True)
class RawWord:
    start: float
    end: float
    word: str
    probability: float


@dataclass(frozen=True)
class RawSegment:
    start: float
    end: float
    text: str
    no_speech_prob: float
    avg_logprob: float
    words: list[RawWord]


@dataclass(frozen=True)
class RawTranscript:
    segments: list[RawSegment]
    model: str
    model_version: str


class Transcriber(Protocol):
    def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript: ...


class MlxWhisperTranscriber:
    def __init__(self, repo: str = "mlx-community/whisper-large-v3-turbo"):
        self.repo = repo

    def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript:
        from importlib.metadata import version

        import mlx_whisper

        result = mlx_whisper.transcribe(
            str(audio),
            path_or_hf_repo=self.repo,
            word_timestamps=True,
            initial_prompt=initial_prompt,
        )
        segments = [
            RawSegment(
                start=float(s["start"]),
                end=float(s["end"]),
                text=s["text"],
                no_speech_prob=float(s.get("no_speech_prob", 0.0)),
                avg_logprob=float(s.get("avg_logprob", 0.0)),
                words=[
                    RawWord(float(w["start"]), float(w["end"]), w["word"], float(w["probability"]))
                    for w in s.get("words", [])
                ],
            )
            for s in result["segments"]
        ]
        return RawTranscript(segments, model=self.repo, model_version=version("mlx-whisper"))


def get_transcriber() -> Transcriber:
    return MlxWhisperTranscriber()


def build_initial_prompt(vocab_file: Path) -> tuple[str, str]:
    raw = vocab_file.read_bytes()
    terms = [
        line.strip()
        for line in raw.decode().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    words = PROMPT_PREFIX.split()
    kept: list[str] = []
    for term in terms:
        if len(words) + len(" ".join(kept + [term]).split()) > MAX_PROMPT_WORDS:
            break
        kept.append(term)
    prompt = f"{PROMPT_PREFIX} {', '.join(kept)}." if kept else PROMPT_PREFIX
    return prompt, hashlib.sha256(raw).hexdigest()


def transcribe_episode(
    row, transcriber: Transcriber, out_dir: Path, vocab_file: Path, tmp_dir: Path | None = None
) -> Path:
    prompt, vocab_sha = build_initial_prompt(vocab_file)
    source = Path(row["audio_path"])
    with tempfile.TemporaryDirectory(dir=tmp_dir) as tmp:
        local = Path(tmp) / source.name
        shutil.copyfile(source, local)  # a network hiccup can't break a long GPU run
        result = transcriber.transcribe(local, prompt)
    data = {
        "meta": {
            "guid": row["guid"],
            "title": row["title"],
            "number": row["number"],
            "published_at": row["published_at"],
            "duration_s": row["duration_s"],
            "model": result.model,
            "model_version": result.model_version,
            "vocab_sha256": vocab_sha,
            "machine": platform.node(),
            "transcribed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        },
        "segments": [asdict(s) for s in result.segments],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"{row['stem']}.json"
    tmp_file = final.with_name(final.name + ".tmp")
    try:
        tmp_file.write_text(json.dumps(data))
        tmp_file.replace(final)
    finally:
        tmp_file.unlink(missing_ok=True)
    return final
