import json
import logging
import platform
import sqlite3
from collections import Counter
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from click.testing import CliRunner
from conftest import FakeEmbedder, FakeTranscriber, status_of

from wts import notify
from wts.cli import main
from wts.feed import parse_feed, upsert_episodes
from wts.notify import NtfyNotifier, NullNotifier, get_notifier, notify_run
from wts.paths import resolve_paths
from wts.secrets import EnvStore, KeychainError
from wts.selection import add_to_scope, resolve_selector
from wts.state import MAX_RETRIES, fail
from wts.steps import run_all

NTFY = "https://ntfy.sh/"
TOPIC = "wts-secret-topic-7f3a91"
FEED_URL = "https://feed.example/rss"
FEED = (Path(__file__).parent / "fixtures" / "feed.xml").read_bytes()


def iso(delta: timedelta = timedelta(0)) -> str:
    return (datetime.now(UTC) + delta).isoformat(timespec="seconds")


class FakeNotifier:
    def __init__(self):
        self.sent: list[dict] = []

    def send(self, title, body, *, priority="default", tags=()) -> bool:
        self.sent.append({"title": title, "body": body, "priority": priority, "tags": tags})
        return True


@pytest.fixture
def notifier():
    return FakeNotifier()


@pytest.fixture
def ntfy():
    with respx.mock(assert_all_called=False) as mock:
        yield mock.post(NTFY).mock(return_value=httpx.Response(200, json={"id": "x"}))


def sent_json(route) -> list[dict]:
    return [json.loads(call.request.content) for call in route.calls]


# --- NtfyNotifier ---------------------------------------------------------------------------


def test_ntfy_posts_json_with_topic_in_the_body_not_the_url(ntfy):
    with httpx.Client() as client:
        ok = NtfyNotifier(client, TOPIC).send(
            "wts: hello", "body text", priority="high", tags=("warning", "tada")
        )
    assert ok is True
    request = ntfy.calls.last.request
    assert str(request.url) == NTFY and TOPIC not in str(request.url)
    assert json.loads(request.content) == {
        "topic": TOPIC, "title": "wts: hello", "message": "body text", "priority": 4,
        "tags": ["warning", "tada"],
    }


@pytest.mark.parametrize(
    ("name", "number"), [("min", 1), ("low", 2), ("default", 3), ("high", 4), ("urgent", 5)]
)
def test_ntfy_priority_names_map_to_numbers(ntfy, name, number):
    with httpx.Client() as client:
        NtfyNotifier(client, TOPIC).send("t", "b", priority=name)
    assert sent_json(ntfy)[0]["priority"] == number


def test_ntfy_rejects_an_unknown_priority_name(ntfy):
    with httpx.Client() as client, pytest.raises(ValueError, match="priority"):
        NtfyNotifier(client, TOPIC).send("t", "b", priority="shouting")
    assert not ntfy.called


def test_ntfy_keeps_non_ascii_titles_intact(ntfy):
    title = "wts: published #312 “The Mortise — and Tenon” café"
    with httpx.Client() as client:
        NtfyNotifier(client, TOPIC).send(title, "Grüße — “body”")
    raw = ntfy.calls.last.request.content
    assert "“".encode() in raw or b"\\u201c" in raw  # utf-8 or JSON escapes, both fine
    assert sent_json(ntfy)[0]["title"] == title
    assert sent_json(ntfy)[0]["message"] == "Grüße — “body”"


def test_ntfy_posts_to_a_self_hosted_base_url():
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("https://ntfy.example.net/").mock(return_value=httpx.Response(200))
        with httpx.Client() as client:
            NtfyNotifier(client, TOPIC, base_url="https://ntfy.example.net/").send("t", "b")
    assert route.called


def test_ntfy_sends_an_access_token_for_a_protected_server(wts_messages):
    token = "tk_secret0123456789abcdef"
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("https://ntfy.example.net/").mock(return_value=httpx.Response(403))
        with httpx.Client() as client:
            ok = NtfyNotifier(client, TOPIC, base_url="https://ntfy.example.net",
                              token=token).send("t", "b")
    assert route.calls[0].request.headers["Authorization"] == f"Bearer {token}"
    assert ok is False and token not in "\n".join(wts_messages)


def test_ntfy_sends_no_authorization_without_a_token():
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(NTFY).mock(return_value=httpx.Response(200))
        with httpx.Client() as client:
            NtfyNotifier(client, TOPIC).send("t", "b")
    assert "Authorization" not in route.calls[0].request.headers


def test_ntfy_http_error_is_logged_without_raising_or_leaking(wts_messages):
    with respx.mock() as mock:
        mock.post(NTFY).mock(return_value=httpx.Response(500, text=f"oops {TOPIC}"))
        with httpx.Client() as client:
            ok = NtfyNotifier(client, TOPIC).send("t", "b")
    assert ok is False
    assert any("500" in m for m in wts_messages)
    assert TOPIC not in "\n".join(wts_messages)


def test_ntfy_connect_error_is_logged_by_class_name_only(wts_messages):
    with respx.mock() as mock:
        mock.post(NTFY).mock(side_effect=httpx.ConnectError(f"cannot reach {NTFY}{TOPIC}"))
        with httpx.Client() as client:
            ok = NtfyNotifier(client, TOPIC).send("t", "b")
    assert ok is False
    assert any("ConnectError" in m for m in wts_messages)
    assert TOPIC not in "\n".join(wts_messages)


def test_ntfy_failure_never_puts_the_topic_in_exc_info(caplog):
    with respx.mock() as mock:
        mock.post(NTFY).mock(side_effect=httpx.ReadTimeout(f"timed out {TOPIC}"))
        with caplog.at_level(logging.INFO, logger="wts"), httpx.Client() as client:
            NtfyNotifier(client, TOPIC).send("t", "b")
    assert TOPIC not in caplog.text
    assert all(r.exc_info is None for r in caplog.records)


# --- NullNotifier and get_notifier ----------------------------------------------------------


def test_null_notifier_logs_the_message(wts_messages):
    assert NullNotifier().send("wts: hi", "the body", priority="high") is False
    assert wts_messages == ["notification (not sent): wts: hi: the body"]


def test_get_notifier_without_a_topic_is_null_with_one_warning(wts_messages):
    with httpx.Client() as client:
        result = get_notifier(client, EnvStore({}))
    assert isinstance(result, NullNotifier)
    warnings = [m for m in wts_messages if "notifications are off" in m]
    assert len(warnings) == 1 and "ntfy_topic" in warnings[0]


def test_get_notifier_with_a_topic_is_ntfy(wts_messages):
    with httpx.Client() as client:
        result = get_notifier(client, EnvStore({"WTS_SECRET_NTFY_TOPIC": TOPIC}))
    assert isinstance(result, NtfyNotifier)
    assert wts_messages == []


def test_get_notifier_uses_the_configured_server_and_token():
    store = EnvStore({"WTS_SECRET_NTFY_TOPIC": TOPIC, "WTS_SECRET_NTFY_TOKEN": "tk_abc"})
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("https://ntfy.example.net/").mock(return_value=httpx.Response(200))
        with httpx.Client() as client:
            get_notifier(client, store, "https://ntfy.example.net").send("t", "b")
    assert route.calls[0].request.headers["Authorization"] == "Bearer tk_abc"
    assert json.loads(route.calls[0].request.content)["topic"] == TOPIC


def test_get_notifier_survives_an_unreadable_keychain(wts_messages):
    class Broken:
        def get(self, name):
            raise KeychainError("reading 'ntfy_topic' from the Keychain failed (security exit 1)")

    with httpx.Client() as client:
        result = get_notifier(client, Broken())
    assert isinstance(result, NullNotifier)
    assert any("notifications are off" in m and "Keychain" in m for m in wts_messages)


# --- notify_run -----------------------------------------------------------------------------


def make_chunks(conn, episode_id: int, n: int) -> None:
    with conn:
        conn.executemany(
            "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times) "
            "values (?, ?, 0, 1000, 'text', '')",
            [(episode_id, i) for i in range(n)],
        )


def publish(conn, episode_id: int, *, env="staging", at: str | None = None) -> None:
    with conn:
        conn.execute(
            "insert into publications (episode_id, env, digest, published_at) "
            "values (?, ?, 'd', ?)",
            (episode_id, env, at or iso()),
        )


def age(conn, episode_id: int, days: int) -> None:
    with conn:
        conn.execute("update episodes set updated_at = ? where id = ?",
                     (iso(-timedelta(days=days)), episode_id))


@pytest.fixture
def fresh(make_episode):
    """A recent episode, so the feed doesn't look quiet."""
    return make_episode(published_at=iso(-timedelta(days=2)), title="Fresh")


def test_nothing_to_report_sends_nothing(conn, notifier, fresh):
    started = iso(-timedelta(seconds=5))
    assert notify_run(notifier, conn, {"feed": Counter(added=0)}, started) is False
    assert notifier.sent == []


def test_published_episodes_make_one_default_priority_summary(conn, notifier, fresh,
                                                              make_episode):
    started = iso(-timedelta(seconds=5))
    a = make_episode(number=311, title="The “mortise” one",
                     published_at=iso(-timedelta(days=9)))
    b = make_episode(number=312, title="Hand planes", published_at=iso(-timedelta(days=2)))
    make_chunks(conn, a, 3)
    make_chunks(conn, b, 1)
    publish(conn, a)
    publish(conn, b)
    assert notify_run(notifier, conn, {}, started) is True
    (msg,) = notifier.sent
    assert msg["title"] == "wts: published 2 episodes"
    assert msg["priority"] == "default"
    assert "#311 The “mortise” one (3 chunks)" in msg["body"]
    assert "#312 Hand planes (1 chunk)" in msg["body"]
    assert msg["body"].index("#311") < msg["body"].index("#312")  # oldest first


def test_one_episode_title_is_singular(conn, notifier, fresh, make_episode):
    started = iso(-timedelta(seconds=5))
    publish(conn, fresh)
    notify_run(notifier, conn, {}, started)
    assert notifier.sent[0]["title"] == "wts: published 1 episode"


def test_episode_published_to_two_environments_is_listed_once(conn, notifier, fresh):
    started = iso(-timedelta(seconds=5))
    make_chunks(conn, fresh, 2)
    publish(conn, fresh, env="staging")
    publish(conn, fresh, env="production")
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["title"] == "wts: published 1 episode"
    assert msg["body"].count("Fresh") == 1


def test_publications_before_the_run_started_are_not_reported(conn, notifier, fresh):
    publish(conn, fresh, at=iso(-timedelta(hours=3)))
    notify_run(notifier, conn, {}, iso(-timedelta(hours=1)))
    assert notifier.sent == []


def test_errors_from_this_run_are_high_priority_with_step_and_reason(conn, notifier, fresh):
    started = iso(-timedelta(seconds=5))
    fail(conn, fresh, "transcribe", "RuntimeError('boom')\nTraceback line two")
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["title"] == "wts: 1 episode in error"
    assert msg["priority"] == "high"
    assert "Fresh" in msg["body"] and "transcribe" in msg["body"]
    assert "RuntimeError('boom')" in msg["body"]
    assert "Traceback line two" not in msg["body"]  # first line only


def test_long_error_reasons_are_truncated(conn, notifier, fresh):
    started = iso(-timedelta(seconds=5))
    fail(conn, fresh, "embed", "x" * 1000)
    notify_run(notifier, conn, {}, started)
    assert "x" * 200 not in notifier.sent[0]["body"]


def test_errors_from_earlier_runs_with_retries_left_are_not_repeated(conn, notifier, fresh):
    fail(conn, fresh, "embed", "old trouble")
    age(conn, fresh, 2)
    notify_run(notifier, conn, {}, iso(-timedelta(seconds=5)))
    assert notifier.sent == []


def test_episodes_out_of_retries_are_not_repeated_every_run(conn, notifier, fresh):
    # Reported in the run that used the last retry (below); after that `wts status` lists
    # them. A daily scheduled run must not raise the same high-priority alert every day.
    for _ in range(MAX_RETRIES):
        fail(conn, fresh, "download", "HTTP 404")
    age(conn, fresh, 2)  # failed for the last time on an earlier run
    notify_run(notifier, conn, {}, iso(-timedelta(seconds=5)))
    assert notifier.sent == []


def test_error_this_run_that_is_also_out_of_retries_is_listed_once(conn, notifier, fresh):
    started = iso(-timedelta(seconds=5))
    for _ in range(MAX_RETRIES):
        fail(conn, fresh, "chunk", "bad")
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["title"] == "wts: 1 episode in error"
    assert msg["body"].count("Fresh") == 1
    assert "out of retries" in msg["body"].lower() and "wts status" in msg["body"]


def test_published_and_failed_share_one_message_with_error_priority(conn, notifier, fresh,
                                                                    make_episode):
    started = iso(-timedelta(seconds=5))
    other = make_episode(title="Other", published_at=iso(-timedelta(days=3)))
    publish(conn, fresh)
    fail(conn, other, "publish", "HTTP 500")
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["priority"] == "high"
    assert "Fresh" in msg["body"] and "Other" in msg["body"]
    assert "Published" in msg["body"]


def test_quiet_feed_warns_after_45_days(conn, notifier, make_episode):
    make_episode(published_at=iso(-timedelta(days=50)))
    make_episode(published_at=iso(-timedelta(days=65)))
    notify_run(notifier, conn, {"feed": Counter(added=0)}, iso(-timedelta(seconds=5)))
    (msg,) = notifier.sent
    assert msg["title"] == "wts: no new episode in 45 days"
    assert msg["priority"] == "default"
    assert "50 days" in msg["body"]


def test_a_normal_break_is_not_a_quiet_feed(conn, notifier, make_episode):
    # 2026 had a 36-day break between episodes, 2025 one of 68: 45 days is past a normal one.
    make_episode(published_at=iso(-timedelta(days=40)))
    make_episode(published_at=iso(-timedelta(days=200)))
    notify_run(notifier, conn, {"feed": Counter()}, iso(-timedelta(seconds=5)))
    assert notifier.sent == []


def quiet_run(conn, notifier, days_later=0):
    now = datetime.now(UTC) + timedelta(days=days_later)
    started = (now - timedelta(seconds=5)).isoformat(timespec="seconds")
    notify_run(notifier, conn, {"feed": Counter()}, started, now=now)


def test_quiet_feed_alerts_once_then_weekly(conn, notifier, make_episode):
    make_episode(published_at=iso(-timedelta(days=50)))
    quiet_run(conn, notifier)
    quiet_run(conn, notifier, days_later=1)  # daily runs don't repeat it
    quiet_run(conn, notifier, days_later=6)
    assert len(notifier.sent) == 1
    quiet_run(conn, notifier, days_later=7)
    assert len(notifier.sent) == 2 and "57 days" in notifier.sent[1]["body"]


def test_a_new_quiet_spell_alerts_at_once(conn, notifier, make_episode):
    e = make_episode(published_at=iso(-timedelta(days=50)))
    quiet_run(conn, notifier)
    with conn:  # an episode arrives; the next run sees a fresh feed and forgets the spell
        conn.execute("update episodes set published_at = ? where id = ?", (iso(), e))
    quiet_run(conn, notifier, days_later=1)
    with conn:
        conn.execute("update episodes set published_at = ? where id = ?",
                     (iso(-timedelta(days=60)), e))
    quiet_run(conn, notifier, days_later=2)
    assert len(notifier.sent) == 2


def test_a_quiet_feed_alert_that_fails_to_send_is_retried_next_run(conn, make_episode):
    class Down(FakeNotifier):
        def send(self, *args, **kwargs) -> bool:
            super().send(*args, **kwargs)
            return False

    make_episode(published_at=iso(-timedelta(days=50)))
    down = Down()
    quiet_run(conn, down)
    notifier = FakeNotifier()
    quiet_run(conn, notifier, days_later=1)
    assert len(notifier.sent) == 1


def test_no_episodes_at_all_is_not_a_quiet_feed(conn, notifier):
    notify_run(notifier, conn, {}, iso(-timedelta(seconds=5)))
    assert notifier.sent == []


def test_quiet_feed_check_is_skipped_when_the_feed_failed(conn, notifier, make_episode):
    make_episode(published_at=iso(-timedelta(days=90)))
    notify_run(notifier, conn, {"feed": Counter(error=1)}, iso(-timedelta(seconds=5)))
    assert notifier.sent == []


def test_quiet_feed_alongside_errors_is_one_high_priority_message(conn, notifier, make_episode):
    started = iso(-timedelta(seconds=5))
    old = make_episode(published_at=iso(-timedelta(days=60)), title="Old")
    fail(conn, old, "embed", "boom")
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["priority"] == "high" and "45 days" in msg["body"] and "Old" in msg["body"]


def test_long_lists_are_capped(conn, notifier, fresh, make_episode):
    started = iso(-timedelta(seconds=5))
    for i in range(30):
        e = make_episode(number=1000 + i, title=f"Episode number {i} " + "word " * 10,
                         published_at=iso(-timedelta(days=2)))
        publish(conn, e)
    notify_run(notifier, conn, {}, started)
    (msg,) = notifier.sent
    assert msg["title"] == "wts: published 30 episodes"
    assert "and 20 more" in msg["body"]
    assert len(msg["body"].encode()) < 4000  # ntfy's message limit is 4096 bytes


# --- wts run --------------------------------------------------------------------------------


@pytest.fixture
def topic(monkeypatch):
    monkeypatch.setenv("WTS_SECRET_NTFY_TOPIC", TOPIC)


@pytest.fixture
def web(tmp_path):
    """Feed and audio mocked; ntfy accepts everything. Yields the mock router's routes."""
    with respx.mock(assert_all_called=False) as mock:
        feed = mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=FEED))
        audio = mock.get(url__regex=r"https://cdn\.example\.com/.*").mock(
            return_value=httpx.Response(200, content=b"audio")
        )
        ntfy = mock.post(NTFY).mock(return_value=httpx.Response(200))

        def probe(path):  # the feed's own duration, so the 2% check passes
            with sqlite3.connect(tmp_path / "state.db") as db:
                row = db.execute("select duration_s from episodes where stem = ?", (path.stem,))
                return float(row.fetchone()[0])

        yield SimpleNamespace(feed=feed, audio=audio, ntfy=ntfy, probe=probe, router=mock)


@pytest.fixture
def quiet_feed(monkeypatch):
    """Any feed counts as quiet. Run-level tests re-read the fixture feed, whose newest item is
    from 2026-09-15: whether that is 'quiet' must not depend on today's date."""
    monkeypatch.setattr(notify, "QUIET_FEED_DAYS", 0)


QUIET_TITLE = "wts: no new episode in 0 days"


def go(conn, paths, cfg, web, **kwargs):
    return run_all(
        conn, paths, replace(cfg, feed_url=FEED_URL), "scope",
        transcriber=kwargs.pop("transcriber", FakeTranscriber()), embedder=FakeEmbedder(),
        probe=web.probe, **kwargs,
    )


def scope(conn, selector="recent:2"):
    upsert_episodes(conn, parse_feed(FEED))
    add_to_scope(conn, resolve_selector(conn, selector))
    return resolve_selector(conn, "scope")


def test_run_with_errors_sends_one_high_priority_message(conn, paths, cfg, web, topic):
    ids = scope(conn, "recent:1")
    go(conn, paths, cfg, web, transcriber=FakeTranscriber(raise_exc=RuntimeError("boom")))
    assert status_of(conn, ids[0]) == "error"
    (msg,) = sent_json(web.ntfy)
    assert msg["topic"] == TOPIC and msg["priority"] == 4
    assert msg["title"] == "wts: 1 episode in error"
    assert "transcribe" in msg["message"] and "boom" in msg["message"]


def test_run_on_a_quiet_feed_sends_one_message(conn, paths, cfg, web, topic, quiet_feed):
    scope(conn, "recent:1")
    go(conn, paths, cfg, web)
    (msg,) = sent_json(web.ntfy)
    assert msg["title"] == QUIET_TITLE
    assert msg["priority"] == 3


def test_run_with_nothing_to_report_sends_nothing(conn, paths, cfg, web, topic, make_episode):
    ids = scope(conn, "recent:1")
    with conn:  # pretend the newest item is recent
        conn.execute("update episodes set published_at = ? where id = ?", (iso(), ids[0]))
    web.feed.mock(return_value=httpx.Response(200, content=b"<rss><channel/></rss>"))
    go(conn, paths, cfg, web)
    assert not web.ntfy.called


def test_machine_problem_from_a_step_notifies_then_reraises(conn, paths, cfg, web, topic,
                                                           wts_messages):
    from wts.storage import StorageUnavailable

    scope(conn)
    missing = Path("/nonexistent-mount/wts/audio")
    with pytest.raises(StorageUnavailable):
        run_all(
            conn, resolve_paths(replace(cfg, audio_dir=missing)),
            replace(cfg, feed_url=FEED_URL, audio_dir=missing), "scope",
            transcriber=FakeTranscriber(), embedder=FakeEmbedder(), probe=web.probe,
        )
    (msg,) = sent_json(web.ntfy)
    assert msg["priority"] == 4 and msg["title"] == "wts: run stopped"
    assert "/nonexistent-mount/wts/audio" in msg["message"]
    assert TOPIC not in "\n".join(wts_messages)


@pytest.mark.parametrize(
    "feed_response",
    [httpx.Response(500, text="down"), httpx.ConnectError("no route to host")],
    ids=["http-500", "connect-error"],
)
def test_feed_failure_notifies_and_the_backlog_still_processes(
    conn, paths, cfg, web, topic, feed_response, wts_messages
):
    ids = scope(conn)  # already in the database, as after an earlier feed fetch
    if isinstance(feed_response, Exception):
        web.feed.mock(side_effect=feed_response)
    else:
        web.feed.mock(return_value=feed_response)
    results = go(conn, paths, cfg, web)
    assert results["feed"]["error"] == 1
    assert [status_of(conn, e) for e in ids] == ["embedded"] * len(ids)  # later steps ran
    assert results["embed"]["ok"] == len(ids)
    (msg,) = sent_json(web.ntfy)  # one message: no quiet-feed warning on top
    assert msg["title"] == "wts: feed fetch failed" and msg["priority"] == 4
    assert "feed.example/rss" in msg["message"]
    assert any("feed" in m and "failed" in m for m in wts_messages)
    recorded = conn.execute("select errors from runs where command = 'feed'").fetchone()[0]
    assert recorded == 1


def test_mass_reset_still_stops_the_run(conn, paths, cfg, web, topic):
    from wts.feed import MassReset

    scope(conn)
    with conn:
        conn.execute("update episodes set status = 'transcribed'")
    moved = FEED.replace(b"cdn.example.com", b"pdst.fm/e/cdn.example.com")
    web.feed.mock(return_value=httpx.Response(200, content=moved))
    with pytest.raises(MassReset):
        go(conn, paths, cfg, web)
    assert not web.ntfy.called


def test_run_without_a_topic_logs_one_warning_and_sends_nothing(conn, paths, cfg, web,
                                                                monkeypatch, wts_messages,
                                                                quiet_feed):
    monkeypatch.delenv("WTS_SECRET_NTFY_TOPIC", raising=False)
    scope(conn, "recent:1")
    go(conn, paths, cfg, web)
    assert not web.ntfy.called
    assert len([m for m in wts_messages if "notifications are off" in m]) == 1
    assert any(m.startswith("notification (not sent): wts: no new episode") for m in wts_messages)


@pytest.mark.parametrize(
    "ntfy_failure",
    [httpx.Response(500, text="nope"), httpx.ConnectError(f"cannot reach {NTFY}{TOPIC}")],
    ids=["http-500", "connect-error"],
)
def test_ntfy_failure_does_not_fail_the_run_or_leak_the_topic(
    conn, paths, cfg, web, topic, wts_messages, ntfy_failure, quiet_feed
):
    ids = scope(conn, "recent:1")
    if isinstance(ntfy_failure, Exception):
        web.ntfy.mock(side_effect=ntfy_failure)
    else:
        web.ntfy.mock(return_value=ntfy_failure)
    results = go(conn, paths, cfg, web)
    assert status_of(conn, ids[0]) == "embedded" and results["embed"]["ok"] == 1
    assert web.ntfy.call_count == 1
    assert any("could not send notification" in m for m in wts_messages)
    assert TOPIC not in "\n".join(wts_messages)


def test_topic_never_appears_in_logs_on_success_paths(conn, paths, cfg, web, topic, wts_messages):
    scope(conn, "recent:1")
    go(conn, paths, cfg, web, transcriber=FakeTranscriber(raise_exc=RuntimeError("boom")))
    assert web.ntfy.called
    assert TOPIC not in "\n".join(wts_messages)


def test_run_takes_an_injected_notifier(conn, paths, cfg, web, notifier, quiet_feed):
    scope(conn, "recent:1")
    go(conn, paths, cfg, web, notifier=notifier)
    assert [m["title"] for m in notifier.sent] == [QUIET_TITLE]
    assert not web.ntfy.called


# --- wts notify test ------------------------------------------------------------------------


def invoke(wts_home, *args, **env):
    return CliRunner(env={"WTS_HOME": str(wts_home), **env}).invoke(main, ["notify", *args])


def test_notify_test_sends_one_message_naming_the_machine(wts_home, ntfy):
    r = invoke(wts_home, "test", WTS_SECRET_NTFY_TOPIC=TOPIC)
    assert r.exit_code == 0 and "sent" in r.output
    (msg,) = sent_json(ntfy)
    assert msg["topic"] == TOPIC
    assert msg["title"] == "wts: test notification"
    assert platform.node() in msg["message"]
    assert TOPIC not in r.output


def test_notify_test_without_a_topic_exits_1_naming_the_fix(wts_home, ntfy, monkeypatch):
    monkeypatch.delenv("WTS_SECRET_NTFY_TOPIC", raising=False)
    r = invoke(wts_home, "test")
    assert r.exit_code == 1
    assert "ntfy_topic" in r.output and "wts secrets set ntfy_topic" in r.output
    assert not ntfy.called


def test_notify_test_uses_the_configured_server_and_token(wts_home):
    (wts_home / "config.toml").write_text('ntfy_url = "https://ntfy.example.net"\n')
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("https://ntfy.example.net/").mock(return_value=httpx.Response(200))
        r = invoke(wts_home, "test", WTS_SECRET_NTFY_TOPIC=TOPIC, WTS_SECRET_NTFY_TOKEN="tk_x")
    assert r.exit_code == 0, r.output
    assert route.calls[0].request.headers["Authorization"] == "Bearer tk_x"


def test_run_uses_the_configured_server(conn, paths, cfg, web, topic, quiet_feed):
    scope(conn, "recent:1")
    own = web.router.post("https://ntfy.example.net/").mock(return_value=httpx.Response(200))
    go(conn, paths, replace(cfg, ntfy_url="https://ntfy.example.net"), web)
    assert own.called and not web.ntfy.called  # not ntfy.sh


def test_notify_test_reports_a_failed_send_without_the_topic(wts_home, ntfy):
    ntfy.mock(return_value=httpx.Response(500))
    r = invoke(wts_home, "test", WTS_SECRET_NTFY_TOPIC=TOPIC)
    assert r.exit_code == 1 and "not sent" in r.output
    assert TOPIC not in r.output
