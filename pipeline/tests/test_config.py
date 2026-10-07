from pathlib import Path

import click
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.config import CloudflareEnv, Config, load_config


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


FULL = """
feed_url = "https://example.com/feed"
cloudflare_account_id = "acc123"
run_env = "staging"
backup_dir = "~/backup"
spotify_show_id = "show42"
youtube_handle = "@SomeShow"
apple_podcast_id = 99

[env.staging]
d1_database_id = "d1-staging"
vectorize_index = "wts-chunks-staging"
"""


def test_full_config_parses(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text(FULL)
    c = load_config(f)
    assert c.cloudflare_account_id == "acc123"
    assert c.run_env == "staging"
    assert c.backup_dir == Path("~/backup").expanduser()
    assert c.spotify_show_id == "show42"
    assert c.youtube_handle == "@SomeShow"
    assert c.apple_podcast_id == 99
    assert c.env("staging") == CloudflareEnv(
        d1_database_id="d1-staging", vectorize_index="wts-chunks-staging"
    )


def test_platform_defaults():
    c = Config()
    assert c.apple_podcast_id == 251471480
    assert c.youtube_handle == "@WoodTalk"
    assert c.spotify_show_id is None and c.backup_dir is None and c.run_env is None
    assert c.envs == {}
    assert c.ntfy_url == "https://ntfy.sh"


def test_ntfy_url_for_a_self_hosted_server(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('ntfy_url = "https://ntfy.example.net/"\n')
    assert load_config(f).ntfy_url == "https://ntfy.example.net/"


def test_missing_env_names_what_to_add(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text(FULL)
    with pytest.raises(click.UsageError) as exc:
        load_config(f).env("production")
    msg = str(exc.value)
    assert "[env.production]" in msg and "d1_database_id" in msg and "vectorize_index" in msg


def test_incomplete_env_names_the_missing_key(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('cloudflare_account_id = "a"\n[env.staging]\nd1_database_id = "x"\n')
    with pytest.raises(click.UsageError) as exc:
        load_config(f).env("staging")
    assert "vectorize_index" in str(exc.value) and "d1_database_id" not in str(exc.value)


def test_env_needs_the_account_id(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('[env.staging]\nd1_database_id = "x"\nvectorize_index = "y"\n')
    with pytest.raises(click.UsageError) as exc:
        load_config(f).env("staging")
    assert "cloudflare_account_id" in str(exc.value)


def test_unknown_env_name_is_refused():
    with pytest.raises(click.UsageError) as exc:
        Config(cloudflare_account_id="a").env("prod")
    assert "staging" in str(exc.value) and "production" in str(exc.value)


def test_plan1_config_still_loads(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('feed_url = "https://example.com/feed"\nmin_free_gb = 5\n')
    c = load_config(f)
    assert c.min_free_gb == 5.0 and c.envs == {} and c.cloudflare_account_id is None
