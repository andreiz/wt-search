"""Non-secret settings from config.toml."""

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import click

ENV_NAMES = ("staging", "production")
_ENV_KEYS = ("d1_database_id", "vectorize_index")


@dataclass(frozen=True)
class CloudflareEnv:
    d1_database_id: str
    vectorize_index: str


@dataclass(frozen=True)
class Config:
    feed_url: str | None = None
    audio_dir: Path | None = None
    min_free_gb: float = 2.0
    cloudflare_account_id: str | None = None
    # [env.<name>] tables as written; env() checks them when an environment is used.
    env_tables: dict[str, dict] = field(default_factory=dict)
    run_env: str | None = None
    backup_dir: Path | None = None
    apple_podcast_id: int = 251471480
    spotify_show_id: str | None = None
    youtube_handle: str = "@WoodTalk"
    ntfy_url: str = "https://ntfy.sh"  # or a self-hosted server; its token is a secret

    @property
    def envs(self) -> dict[str, CloudflareEnv]:
        """The complete [env.*] tables."""
        return {
            name: CloudflareEnv(**{k: t[k] for k in _ENV_KEYS})
            for name, t in self.env_tables.items()
            if all(t.get(k) for k in _ENV_KEYS)
        }

    def env(self, name: str) -> CloudflareEnv:
        """The Cloudflare settings for `name`, or a UsageError naming what to add."""
        _check_env_name(name)
        table = self.env_tables.get(name, {})
        missing = [f"[env.{name}] {k}" for k in _ENV_KEYS if not table.get(k)]
        if not self.cloudflare_account_id:
            missing.insert(0, "cloudflare_account_id")
        if missing:
            raise click.UsageError(f"config.toml is missing: {', '.join(missing)}")
        return self.envs[name]

    def api_url(self, name: str) -> str:
        """The Worker's base URL for `name` (`wts search`), without a trailing slash.

        Optional, unlike the keys in `env()`: publishing doesn't call the Worker, so it is not
        part of CloudflareEnv and a config without it still publishes.
        """
        _check_env_name(name)
        url = self.env_tables.get(name, {}).get("api_url")
        if not isinstance(url, str) or not url:
            raise click.UsageError(f"config.toml is missing: [env.{name}] api_url")
        return url.removesuffix("/")


def _check_env_name(name: str) -> None:
    if name not in ENV_NAMES:
        raise click.UsageError(f"environment must be one of {', '.join(ENV_NAMES)}, "
                               f"not {name!r}")


def _path(value: str | None) -> Path | None:
    return Path(value).expanduser() if value else None


def load_config(path: Path) -> Config:
    if not path.exists():
        return Config()
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise click.ClickException(
            f"{path} is not valid TOML: {exc}. Strings need quotes, e.g. "
            'cloudflare_account_id = "0123abcd…"'
        ) from exc
    defaults = Config()
    return Config(
        feed_url=data.get("feed_url"),
        audio_dir=_path(data.get("audio_dir")),
        min_free_gb=float(data.get("min_free_gb", 2.0)),
        cloudflare_account_id=data.get("cloudflare_account_id"),
        env_tables={k: dict(v) for k, v in data.get("env", {}).items()},
        run_env=data.get("run_env"),
        backup_dir=_path(data.get("backup_dir")),
        apple_podcast_id=int(data.get("apple_podcast_id", defaults.apple_podcast_id)),
        spotify_show_id=data.get("spotify_show_id"),
        youtube_handle=data.get("youtube_handle", defaults.youtube_handle),
        ntfy_url=data.get("ntfy_url", defaults.ntfy_url),
    )
