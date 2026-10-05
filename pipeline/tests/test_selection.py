from datetime import date

import click
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.selection import add_to_scope, resolve_selector, seed_ids


def _year(conn, episode_id):
    return int(
        conn.execute("select published_at from episodes where id = ?", (episode_id,)).fetchone()[0][:4]
    )


def test_seed_is_20_recent_plus_15_spread(conn, make_episodes):
    ids = make_episodes(200)  # published one week apart, oldest first
    seed = seed_ids(conn)
    assert len(seed) == 35 and len(set(seed)) == 35
    assert set(ids[-20:]) <= set(seed)
    older = sorted(set(seed) - set(ids[-20:]))
    assert older[0] == ids[0] and older[-1] == ids[179]  # spans the whole older range


def test_seed_with_small_feed_returns_all(conn, make_episodes):
    ids = make_episodes(30)
    assert sorted(seed_ids(conn)) == sorted(ids)


def test_union_and_filters(conn, make_episodes):
    ids = make_episodes(10, start=date(2014, 12, 1))
    got = resolve_selector(conn, "recent:2,year:2014")
    assert set(got) == set(ids[-2:]) | {i for i in ids if _year(conn, i) == 2014}
    assert got == sorted(got, key=lambda i: ids.index(i))  # ordered by published_at


def test_ep_and_stem_selectors(conn, make_episode):
    a = make_episode(number=312, stem="2017-03-14_ep312_x")
    make_episode(number=313)
    assert resolve_selector(conn, "ep:312") == [a]
    assert resolve_selector(conn, "stem:2017-03-14_ep312_x") == [a]


def test_scope_default_empty_until_added(conn, make_episodes):
    ids = make_episodes(5)
    assert resolve_selector(conn, "scope") == []
    assert add_to_scope(conn, ids[:2]) == 2
    assert resolve_selector(conn, "scope") == ids[:2]


def test_unknown_selector_rejected(conn):
    with pytest.raises(click.BadParameter):
        resolve_selector(conn, "season:3")


def test_scope_cli_add_and_list(wts_home):
    from wts.db import connect

    c = connect(wts_home / "state.db")
    c.execute(
        "insert into episodes (guid, title, published_at, audio_url, stem, updated_at) "
        "values ('g', 't', '2020-01-01', 'u', '2020-01-01_t', 'x')"
    )
    c.commit()
    assert "1 episode(s) added" in CliRunner().invoke(main, ["scope", "add", "all"]).output
    assert "2020-01-01_t" in CliRunner().invoke(main, ["scope", "list"]).output
