"""The `wts` command line. Thin: each command delegates to a module."""

from dataclasses import fields

import click

from wts import __version__
from wts.config import load_config
from wts.paths import resolve_paths


def _paths():
    base = resolve_paths()
    return resolve_paths(load_config(base.config_file))


@click.group()
@click.version_option(__version__)
def main() -> None:
    """Wood Talk transcript search pipeline."""


@main.command()
def status() -> None:
    """Episode counts by status, errors, and recent runs."""
    from wts.db import connect
    from wts.status import status_report

    click.echo(status_report(connect(_paths().state_db)))


@main.command()
def paths() -> None:
    """Print the resolved file locations."""
    p = _paths()
    for f in fields(p):
        click.echo(f"{f.name}: {getattr(p, f.name)}")
