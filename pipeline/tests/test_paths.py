from pathlib import Path

from wts.config import Config
from wts.paths import resolve_paths


def test_wts_home_overrides_everything(wts_home):
    p = resolve_paths()
    assert p.app_dir == wts_home
    assert p.config_file == wts_home / "config.toml"
    assert p.state_db == wts_home / "state.db"
    assert p.transcripts_dir == wts_home / "data" / "transcripts"
    assert p.embeddings_dir == wts_home / "data" / "embeddings"
    assert p.audio_dir == wts_home / "audio"
    assert p.log_dir == wts_home / "logs"


def test_config_audio_dir_wins(wts_home, tmp_path):
    nas = tmp_path / "nas"
    p = resolve_paths(Config(feed_url=None, audio_dir=nas))
    assert p.audio_dir == nas


def test_platform_defaults_without_override(monkeypatch):
    monkeypatch.delenv("WTS_HOME", raising=False)
    p = resolve_paths(env={})
    assert p.app_dir.name == "wts" and "wts" in p.log_dir.parts  # macOS: ~/Library/Logs/wts
    assert p.app_dir != Path.home()
