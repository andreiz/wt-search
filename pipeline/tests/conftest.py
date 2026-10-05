import itertools
from datetime import date, timedelta

import pytest

from wts.db import connect

_counter = itertools.count(1)


@pytest.fixture
def wts_home(tmp_path, monkeypatch):
    home = tmp_path / "wts-home"
    home.mkdir()
    monkeypatch.setenv("WTS_HOME", str(home))
    return home


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "state.db")
    yield c
    c.close()


def insert_episode(conn, **overrides) -> int:
    n = next(_counter)
    row = {
        "guid": f"guid-{n}",
        "number": n,
        "title": f"Episode {n}",
        "published_at": "2020-01-01T00:00:00+00:00",
        "duration_s": 3600,
        "audio_url": f"https://cdn.example/ep{n}.mp3",
        "page_url": f"https://woodtalkshow.com/ep{n}",
        "stem": f"2020-01-01_ep{n:03d}_episode-{n}",
        "updated_at": "2020-01-01T00:00:00+00:00",
    }
    row.update(overrides)
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    cur = conn.execute(f"insert into episodes ({cols}) values ({marks})", tuple(row.values()))
    conn.commit()
    return cur.lastrowid


@pytest.fixture
def make_episode(conn):
    return lambda **overrides: insert_episode(conn, **overrides)


@pytest.fixture
def make_episodes(conn):
    def make(n: int, start: date = date(2007, 4, 1)) -> list[int]:
        ids = []
        for i in range(n):
            d = start + timedelta(weeks=i)
            k = next(_counter)
            ids.append(
                insert_episode(
                    conn,
                    guid=f"guid-{k}",
                    number=k,
                    published_at=f"{d.isoformat()}T00:00:00+00:00",
                    stem=f"{d.isoformat()}_ep{k:03d}_episode-{k}",
                )
            )
        return ids

    return make


def _col(conn, episode_id: int, col: str):
    return conn.execute(f"select {col} from episodes where id = ?", (episode_id,)).fetchone()[0]


def status_of(conn, episode_id):
    return _col(conn, episode_id, "status")


def retries_of(conn, episode_id):
    return _col(conn, episode_id, "retries")


def reason_of(conn, episode_id):
    return _col(conn, episode_id, "error_reason")


def stem_of(conn, episode_id):
    return _col(conn, episode_id, "stem")


def url_of(conn, episode_id):
    return _col(conn, episode_id, "audio_url")


def force_status(conn, episode_id, status):
    conn.execute("update episodes set status = ? where id = ?", (status, episode_id))
    conn.commit()
