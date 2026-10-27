from datetime import date
from itertools import pairwise

import click
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.selection import add_to_scope, resolve_selector, scope_stems, seed_ids, set_scope


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


def test_spread_is_even_and_skips_scope(conn, make_episodes):
    ids = make_episodes(100)
    add_to_scope(conn, ids[-20:])
    got = resolve_selector(conn, "spread:10")
    assert len(got) == 10
    assert not set(got) & set(ids[-20:])
    assert got[0] == ids[4] and got[-1] == ids[76]  # 80 candidates: indexes 4, 12, ..., 76
    positions = [ids.index(i) for i in got]
    assert {b - a for a, b in pairwise(positions)} == {8}


def test_spread_more_than_candidates_takes_all(conn, make_episodes):
    ids = make_episodes(5)
    add_to_scope(conn, ids[:2])
    assert resolve_selector(conn, "spread:9") == ids[2:]


@pytest.mark.parametrize("term", ["spread:0", "spread:x", "spread:"])
def test_spread_rejects_bad_n(conn, term):
    with pytest.raises(click.BadParameter):
        resolve_selector(conn, term)


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


def _stems(conn, ids):
    return [conn.execute("select stem from episodes where id = ?", (i,)).fetchone()[0] for i in ids]


def test_set_scope_makes_the_scope_exactly_the_list(conn, make_episodes):
    ids = make_episodes(6)
    add_to_scope(conn, ids[:3])
    assert set_scope(conn, _stems(conn, [ids[2], ids[4]])) == (1, 2)  # (added, removed)
    assert resolve_selector(conn, "scope") == [ids[2], ids[4]]
    assert scope_stems(conn) == _stems(conn, [ids[2], ids[4]])


def test_set_scope_with_an_unknown_stem_changes_nothing(conn, make_episodes):
    ids = make_episodes(3)
    add_to_scope(conn, ids[:1])
    with pytest.raises(click.ClickException, match="2001-01-01_ep999_gone"):
        set_scope(conn, [*_stems(conn, ids[1:2]), "2001-01-01_ep999_gone"])
    assert resolve_selector(conn, "scope") == ids[:1]


def test_scope_cli_save_then_restore(wts_home, tmp_path):
    from wts.db import connect

    c = connect(wts_home / "state.db")
    for k in (1, 2, 3):
        c.execute(
            "insert into episodes (guid, title, published_at, audio_url, stem, updated_at) "
            f"values ('g{k}', 't', '2020-01-0{k}', 'u', '2020-01-0{k}_t', 'x')"
        )
    c.execute("update episodes set in_scope = 1 where guid in ('g1', 'g3')")
    c.commit()
    saved = tmp_path / "scope.txt"
    run = CliRunner().invoke
    assert run(main, ["scope", "save", str(saved)]).exit_code == 0
    assert [ln for ln in saved.read_text().splitlines() if not ln.startswith("#")] == [
        "2020-01-01_t", "2020-01-03_t"]

    assert run(main, ["scope", "add", "all"]).exit_code == 0
    # Blank lines, comments and the `scope list` status column are fine in the file.
    saved.write_text(saved.read_text() + "\n# later\n2020-01-03_t  published\n")
    r = run(main, ["scope", "restore", str(saved)])
    assert r.exit_code == 0, r.output
    assert "2 in scope (0 added, 1 removed)" in r.output
    in_scope = c.execute("select guid from episodes where in_scope = 1 order by guid").fetchall()
    assert [g for (g,) in in_scope] == ["g1", "g3"]
