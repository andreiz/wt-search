"""Where wts keeps its files (spec §3.0)."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_dir, user_log_dir

from wts.config import Config

APP = "wts"


@dataclass(frozen=True)
class Paths:
    home_override: bool
    app_dir: Path
    config_file: Path
    state_db: Path
    data_dir: Path
    transcripts_dir: Path
    embeddings_dir: Path
    audio_dir: Path
    log_dir: Path


def resolve_paths(cfg: Config | None = None, env: Mapping[str, str] = os.environ) -> Paths:
    home = env.get("WTS_HOME")
    if home:
        app_dir = Path(home)
        log_dir = app_dir / "logs"
    else:
        app_dir = Path(user_data_dir(APP, appauthor=False))
        log_dir = Path(user_log_dir(APP, appauthor=False))
    data_dir = app_dir / "data"
    audio_dir = cfg.audio_dir if cfg and cfg.audio_dir else app_dir / "audio"
    return Paths(
        home_override=bool(home),
        app_dir=app_dir,
        config_file=app_dir / "config.toml",
        state_db=app_dir / "state.db",
        data_dir=data_dir,
        transcripts_dir=data_dir / "transcripts",
        embeddings_dir=data_dir / "embeddings",
        audio_dir=audio_dir,
        log_dir=log_dir,
    )
