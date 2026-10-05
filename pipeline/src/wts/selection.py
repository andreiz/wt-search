"""Episode selectors (`--select`) and the in-scope set (spec §3.1)."""

import sqlite3
from collections.abc import Iterable

import click


def _ordered_ids(conn: sqlite3.Connection, where: str = "1", args: tuple = ()) -> list[int]:
    return [
        r[0]
        for r in conn.execute(f"select id from episodes where {where} order by published_at", args)
    ]


def seed_ids(conn: sqlite3.Connection, recent: int = 20, sampled: int = 15) -> list[int]:
    ordered = _ordered_ids(conn)
    newest = ordered[-recent:] if recent else []
    rest = ordered[: len(ordered) - len(newest)]
    if len(rest) <= sampled:
        picked = rest
    else:
        n = len(rest)
        picked = [rest[round(i * (n - 1) / (sampled - 1))] for i in range(sampled)]
    chosen = set(newest) | set(picked)
    return [i for i in ordered if i in chosen]


def _term(conn: sqlite3.Connection, term: str) -> list[int]:
    name, _, arg = term.partition(":")
    try:
        if name == "scope" and not arg:
            return _ordered_ids(conn, "in_scope = 1")
        if name == "all" and not arg:
            return _ordered_ids(conn)
        if name == "seed" and not arg:
            return seed_ids(conn)
        if name == "recent":
            n = int(arg)
            return _ordered_ids(conn)[-n:] if n > 0 else []
        if name == "ep":
            return _ordered_ids(conn, "number = ?", (int(arg),))
        if name == "year":
            return _ordered_ids(conn, "substr(published_at, 1, 4) = ?", (f"{int(arg):04d}",))
        if name == "stem" and arg:
            return _ordered_ids(conn, "stem = ?", (arg,))
    except ValueError:
        pass
    raise click.BadParameter(
        f"unknown selector {term!r} (use scope, all, seed, recent:N, ep:N, year:YYYY, stem:S)"
    )


def resolve_selector(conn: sqlite3.Connection, selector: str) -> list[int]:
    chosen: set[int] = set()
    for term in selector.split(","):
        chosen.update(_term(conn, term.strip()))
    return [i for i in _ordered_ids(conn) if i in chosen]


def add_to_scope(conn: sqlite3.Connection, ids: Iterable[int]) -> int:
    ids = list(ids)
    with conn:
        conn.executemany("update episodes set in_scope = 1 where id = ?", [(i,) for i in ids])
    return len(ids)
