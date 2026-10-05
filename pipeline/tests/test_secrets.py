import subprocess

import pytest
from click.testing import CliRunner

from wts import secrets
from wts.cli import main
from wts.secrets import (
    SECRET_NAMES,
    EnvStore,
    KeychainError,
    KeychainStore,
    MissingSecret,
    get_secret,
    get_store,
)

VALUE = "s3cr3t-value-xyz"


class FakeRun:
    """Stands in for subprocess.run; records argv and returns a fixed result."""

    def __init__(self, returncode=0, stdout=""):
        self.returncode, self.stdout = returncode, stdout
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, "")


def test_env_store_round_trip(monkeypatch):
    monkeypatch.setenv("WTS_SECRET_SPOTIFY_CLIENT_ID", "abc")
    monkeypatch.delenv("WTS_SECRET_YOUTUBE_API_KEY", raising=False)
    store = EnvStore()
    assert store.get("spotify_client_id") == "abc"
    assert store.get("youtube_api_key") is None


def test_env_store_treats_empty_as_missing(monkeypatch):
    monkeypatch.setenv("WTS_SECRET_NTFY_TOPIC", "")
    assert EnvStore().get("ntfy_topic") is None


def test_keychain_found():
    run = FakeRun(stdout=VALUE + "\n")
    assert KeychainStore(run=run).get("youtube_api_key") == VALUE
    argv, kwargs = run.calls[0]
    assert argv == ["security", "find-generic-password", "-s", "wts", "-a", "youtube_api_key",
                    "-w"]
    assert kwargs["capture_output"] is True


def test_keychain_not_found_is_none():
    assert KeychainStore(run=FakeRun(returncode=44)).get("youtube_api_key") is None


def test_keychain_other_failure_raises():
    with pytest.raises(KeychainError) as exc:
        KeychainStore(run=FakeRun(returncode=51, stdout=VALUE)).get("youtube_api_key")
    assert VALUE not in str(exc.value)


def test_get_store_uses_env_outside_the_mac(monkeypatch):
    assert isinstance(get_store({"WTS_HOME": "/x"}, "darwin"), EnvStore)
    assert isinstance(get_store({}, "linux"), EnvStore)
    assert isinstance(get_store({}, "darwin"), KeychainStore)


def test_get_secret_missing_says_how_to_set_it():
    class Empty:
        def get(self, name):
            return None

    with pytest.raises(MissingSecret) as exc:
        get_secret(Empty(), "cloudflare_api_token")
    assert "wts secrets set cloudflare_api_token" in str(exc.value)
    assert exc.value.name == "cloudflare_api_token"


def test_get_secret_rejects_unknown_names():
    with pytest.raises(ValueError):
        get_secret(EnvStore(), "nope")


def test_secrets_set_lets_security_prompt(monkeypatch):
    run = FakeRun()
    monkeypatch.setattr(secrets.subprocess, "run", run)
    monkeypatch.setattr(secrets.sys, "platform", "darwin")
    result = CliRunner().invoke(main, ["secrets", "set", "youtube_api_key"])
    assert result.exit_code == 0, result.output
    argv, kwargs = run.calls[0]
    # -w last with no value: `security` prompts on the terminal, so the value is never in argv.
    assert argv == ["security", "add-generic-password", "-U", "-s", "wts", "-a",
                    "youtube_api_key", "-w"]
    assert "input" not in kwargs and "capture_output" not in kwargs


def test_secrets_set_rejects_unknown_name():
    result = CliRunner().invoke(main, ["secrets", "set", "bogus"])
    assert result.exit_code == 2


def test_secrets_set_outside_the_mac_points_at_env(monkeypatch):
    monkeypatch.setattr(secrets.sys, "platform", "linux")
    result = CliRunner().invoke(main, ["secrets", "set", "youtube_api_key"])
    assert result.exit_code != 0
    assert "WTS_SECRET_YOUTUBE_API_KEY" in result.output


def test_secrets_check_never_prints_values(wts_home, monkeypatch):
    for name in SECRET_NAMES:
        monkeypatch.delenv(f"WTS_SECRET_{name.upper()}", raising=False)
    monkeypatch.setenv("WTS_SECRET_YOUTUBE_API_KEY", VALUE)
    result = CliRunner().invoke(main, ["secrets", "check"])
    assert result.exit_code == 0, result.output
    assert VALUE not in result.output
    lines = dict(line.split() for line in result.output.splitlines())
    assert lines["youtube_api_key"] == "set"
    assert lines["cloudflare_api_token"] == "missing"
    assert set(lines) == set(SECRET_NAMES)
