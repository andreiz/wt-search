import itertools
import json
from datetime import date, timedelta
from pathlib import Path

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
def paths(wts_home):
    from wts.paths import resolve_paths

    return resolve_paths()


@pytest.fixture
def cfg():
    from wts.config import Config

    return Config()


class FakeTranscriber:
    """Returns a fixed two-segment transcript, or raises `raise_exc`."""

    def __init__(self, raise_exc=None, transcript=None):
        self.raise_exc = raise_exc
        self.transcript = transcript
        self.calls = 0

    def transcribe(self, audio, initial_prompt):
        from wts.transcribe import RawSegment, RawTranscript, RawWord

        self.calls += 1
        assert audio.exists()
        if self.raise_exc:
            raise self.raise_exc
        if self.transcript:
            return self.transcript
        return RawTranscript(
            segments=[
                RawSegment(0.0, 1.0, " Welcome to Wood Talk.", 0.01, -0.2, [
                    RawWord(0.0, 0.4, " Welcome", 0.98),
                    RawWord(0.4, 0.5, " to", 0.99),
                    RawWord(0.5, 0.7, " Wood", 0.95),
                    RawWord(0.7, 1.0, " Talk.", 0.97),
                ]),
                RawSegment(1.0, 2.0, " Glue it up.", 0.02, -0.3, [
                    RawWord(1.0, 1.3, " Glue", 0.9),
                    RawWord(1.3, 1.5, " it", 0.99),
                    RawWord(1.5, 2.0, " up.", 0.4),
                ]),
            ],
            model="fake-whisper",
            model_version="0",
        )


class FakeEmbedder:
    """Deterministic unit vectors from a hash of the text; counts texts embedded."""

    model = "fake-bge"
    dim = 768

    def __init__(self):
        self.calls = 0

    def embed(self, texts):
        import hashlib

        import numpy as np

        self.calls += len(texts)
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = int.from_bytes(hashlib.sha256(t.encode()).digest()[:4], "big")
            v = np.random.default_rng(seed).standard_normal(self.dim).astype(np.float32)
            out[i] = v / np.linalg.norm(v)
        return out


@pytest.fixture
def wts_messages():
    """Messages logged to the `wts` logger at INFO and above, in order."""
    import logging

    messages: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda record: messages.append(record.getMessage())
    logger = logging.getLogger("wts")
    old_level = logger.level
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    yield messages
    logger.removeHandler(handler)
    logger.setLevel(old_level)


@pytest.fixture
def audio_file(paths):
    paths.audio_dir.mkdir(parents=True, exist_ok=True)
    f = paths.audio_dir / "episode.mp3"
    f.write_bytes(b"fake audio")
    return f


REAL_FIXTURES = Path(__file__).parent / "fixtures" / "real"


@pytest.fixture
def real_transcripts():
    """Real Wood Talk transcripts committed at Checkpoint B; skips until they exist."""
    files = sorted(REAL_FIXTURES.glob("*.json")) if REAL_FIXTURES.exists() else []
    if not files:
        pytest.skip("no real transcripts in tests/fixtures/real yet (Checkpoint B)")
    return [json.loads(f.read_text()) for f in files]


def ws(text: str, step_ms: int = 1000):
    """Words from text; word i spans [i*step, i*step + step - 1] ms."""
    from wts.words import Word

    return [
        Word(t, i * step_ms, i * step_ms + step_ms - 1, 0.9) for i, t in enumerate(text.split())
    ]


def seg(text: str, no_speech: float = 0.01, logprob: float = -0.2, word_ms: int = 300):
    """A transcript segment with relative word times; `tx` lays segments end to end."""
    words = [
        {"start": i * word_ms / 1000, "end": (i + 1) * word_ms / 1000, "word": f" {w}",
         "probability": 0.9}
        for i, w in enumerate(text.split())
    ]
    return {"start": 0.0, "end": len(words) * word_ms / 1000, "text": f" {text}",
            "no_speech_prob": no_speech, "avg_logprob": logprob, "words": words, "_rel": True}


def seg_with_word_starts(text: str, starts, start: float, end: float):
    """A segment with absolute, explicit word start times (seconds)."""
    words = [
        {"start": s, "end": s + 0.2, "word": f" {w}", "probability": 0.9}
        for w, s in zip(text.split(), starts, strict=True)
    ]
    return {"start": start, "end": end, "text": f" {text}", "no_speech_prob": 0.01,
            "avg_logprob": -0.2, "words": words}


def tx(*segments, **meta):
    """A transcript JSON (Task 7 shape). Relative segments are laid end to end."""
    offset = 0.0
    out = []
    for s in segments:
        s = dict(s)
        if s.pop("_rel", False):
            s["words"] = [
                {**w, "start": w["start"] + offset, "end": w["end"] + offset} for w in s["words"]
            ]
            s["start"], s["end"] = s["start"] + offset, s["end"] + offset
        offset = max(offset, s["end"])
        out.append(s)
    return {"meta": {"guid": "g", "title": "t", "duration_s": None, **meta}, "segments": out}


def fail_after_first_call(exc):
    calls = {"n": 0}

    def check(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise exc("audio folder went away")

    return check


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
