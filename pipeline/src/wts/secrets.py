"""Secrets (spec §3.6): the macOS Keychain on the Mac, environment variables elsewhere.

Values are never written to config, logs, argv or exception messages.
"""

import os
import subprocess
import sys
from collections.abc import Callable, Mapping
from typing import Protocol

SERVICE = "wts"
SECRET_NAMES = (
    "cloudflare_api_token",
    "spotify_client_id",
    "spotify_client_secret",
    "youtube_api_key",
    "ntfy_topic",
)
_NOT_FOUND = 44  # `security find-generic-password` exit code for a missing item


class SecretStore(Protocol):
    def get(self, name: str) -> str | None: ...


class MissingSecret(Exception):
    def __init__(self, name: str):
        super().__init__(f"secret {name!r} is not set; run `wts secrets set {name}`")
        self.name = name


class KeychainError(Exception):
    pass


def env_var(name: str) -> str:
    return f"WTS_SECRET_{name.upper()}"


class EnvStore:
    """Reads WTS_SECRET_<NAME>, for tests and non-Mac runs."""

    def __init__(self, env: Mapping[str, str] = os.environ):
        self._env = env

    def get(self, name: str) -> str | None:
        return self._env.get(env_var(name)) or None


class KeychainStore:
    """Generic passwords in the login keychain: service `wts`, account = secret name."""

    def __init__(self, run: Callable[..., subprocess.CompletedProcess] = subprocess.run):
        self._run = run

    def get(self, name: str) -> str | None:
        result = self._run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"],
            capture_output=True,
            text=True,
        )
        if result.returncode == _NOT_FOUND:
            return None
        if result.returncode != 0:
            # No output in the message: stdout could hold the value.
            raise KeychainError(f"reading {name!r} from the Keychain failed "
                                f"(security exit {result.returncode})")
        return result.stdout.rstrip("\n") or None


def get_store(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> SecretStore:
    if env.get("WTS_HOME") or platform != "darwin":
        return EnvStore(env)
    return KeychainStore()


def get_secret(store: SecretStore, name: str) -> str:
    if name not in SECRET_NAMES:
        raise ValueError(f"unknown secret {name!r}")
    value = store.get(name)
    if value is None:
        raise MissingSecret(name)
    return value


def set_secret(name: str) -> int:
    """Store a secret in the Keychain; `security` prompts for the value on the terminal."""
    if sys.platform != "darwin":
        raise KeychainError(f"no Keychain here; set {env_var(name)} in the environment instead")
    # `-w` last with no value makes `security` prompt, so the value never appears in argv.
    argv = ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w"]
    return subprocess.run(argv, check=False).returncode
