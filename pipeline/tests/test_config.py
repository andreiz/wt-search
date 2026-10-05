from pathlib import Path

from click.testing import CliRunner

from wts.cli import main
from wts.config import Config, load_config


def test_load_config(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('feed_url = "https://example.com/feed"\naudio_dir = "/Volumes/media/wts/audio"\n')
    c = load_config(f)
    assert c.feed_url == "https://example.com/feed"
    assert c.audio_dir == Path("/Volumes/media/wts/audio")
    assert c.min_free_gb == 2.0


def test_missing_config_gives_defaults(tmp_path):
    assert load_config(tmp_path / "nope.toml") == Config(feed_url=None, audio_dir=None)


def test_paths_command_prints_locations(wts_home):
    out = CliRunner().invoke(main, ["paths"]).output
    assert str(wts_home / "state.db") in out
