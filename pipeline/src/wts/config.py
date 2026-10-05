"""Non-secret settings from config.toml."""

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    feed_url: str | None = None
    audio_dir: Path | None = None
    min_free_gb: float = 2.0


def load_config(path: Path) -> Config:
    if not path.exists():
        return Config()
    data = tomllib.loads(path.read_text())
    audio_dir = data.get("audio_dir")
    return Config(
        feed_url=data.get("feed_url"),
        audio_dir=Path(audio_dir).expanduser() if audio_dir else None,
        min_free_gb=float(data.get("min_free_gb", 2.0)),
    )
