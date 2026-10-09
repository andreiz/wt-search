import json
from pathlib import Path

import pytest
from click.testing import CliRunner
from conftest import force_status, seg, status_of, tx

from wts import chunking, steps
from wts.chunking import prepare_episode
from wts.cli import main
from wts.corrections import CORRECTIONS_FILE, CorrectionRule, corrections_sha
from wts.db import kv_set
from wts.state import fail
from wts.steps import run_chunk

AD_BLOCK = [
    "this episode is brought to you by rockler woodworking and hardware",
    "go to rockler dot com to find everything you need for your shop",
    "and use the code wood talk to save ten percent on your order",
    "also thanks to our patrons over at patreon dot com slash wood talk",
    "they make this show possible every single week of the year",
    "if you want the ad free version head over there and sign up",
    "and do not forget to send us your questions by email anytime",
    "now on with the show everyone let us talk some woodworking",
]


def unique_sentences(tag: str, n: int) -> list[str]:
    return [" ".join(f"{tag}q{i}z{j}" for j in range(10)) for i in range(n)]


def write_transcript(conn, paths, episode_id: int, sentences: list[str]) -> None:
    stem = conn.execute("select stem from episodes where id = ?", (episode_id,)).fetchone()[0]
    data = tx(*[seg(s + ".") for s in sentences])
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(data))
    duration = int(data["segments"][-1]["end"]) + 1
    conn.execute(
        "update episodes set transcript_path = ?, duration_s = ?, status = 'transcribed' "
        "where id = ?",
        (str(out), duration, episode_id),
    )
    conn.commit()


@pytest.fixture
def empty_corrections(tmp_path):
    f = tmp_path / "empty.yaml"
    f.write_text("global: {}\nepisodes: {}\n")
    return f


@pytest.fixture
def transcribed_episode(conn, paths, make_episode):
    e = make_episode()
    body = unique_sentences("solo", 20)
    body[3] = "then marc said kremona cut the tenons by hand with a saw"
    write_transcript(conn, paths, e, body)
    return e


@pytest.fixture
def episodes_with_ad(conn, paths, make_episodes):
    ids = make_episodes(5)
    for k, e in enumerate(ids):
        write_transcript(conn, paths, e, AD_BLOCK + unique_sentences(f"ep{k}", 15))
    return ids


def chunk_ids(conn, e):
    return [r[0] for r in conn.execute("select id from chunks where episode_id = ? order by seq", (e,))]


def all_text(conn, e):
    return " ".join(r[0] for r in conn.execute("select text from chunks where episode_id = ?", (e,)))


def boilerplate_chunk_count(conn, e):
    return conn.execute(
        "select count(*) from chunks where episode_id = ? and is_boilerplate = 1", (e,)
    ).fetchone()[0]


def test_chunk_step_stores_chunks_and_flags(conn, transcribed_episode, paths, cfg):
    counts = run_chunk(conn, paths, cfg, [transcribed_episode])
    rows = conn.execute(
        "select * from chunks where episode_id=?", (transcribed_episode,)
    ).fetchall()
    assert rows and status_of(conn, transcribed_episode) == "chunked" and counts["ok"] == 1
    assert all(len(r["text"].split()) == len(r["word_times"].split(",")) for r in rows)
    flags = conn.execute(
        "select flags from episodes where id = ?", (transcribed_episode,)
    ).fetchone()[0]
    assert isinstance(json.loads(flags), list)


def test_chunk_reports_chunks_and_flags(conn, paths, cfg, episodes_with_ad, wts_messages):
    slow = episodes_with_ad[0]  # ~230 words over 10 minutes: wpm_low
    conn.execute("update episodes set audio_duration_s = 600 where id = ?", (slow,))
    conn.commit()
    counts = run_chunk(conn, paths, cfg, episodes_with_ad)
    total, bp = conn.execute(
        "select count(*), sum(is_boilerplate) from chunks"
    ).fetchone()
    assert (counts["chunks"], counts["boilerplate"], counts["flagged"]) == (total, bp, 1)
    assert bp == 0  # nothing detects boilerplate for now
    per_episode = [m for m in wts_messages if m.startswith("chunked: ")]
    assert len(per_episode) == 5
    assert per_episode[0].endswith("; flags: wpm_low")
    stem = conn.execute("select stem from episodes where id = ?", (slow,)).fetchone()[0]
    assert wts_messages[-1] == (
        f"chunked 5 episodes: {total} chunks, {bp} boilerplate ({100 * bp / total:.0f}%); "
        f"flagged: {stem} (wpm_low)"
    )


def test_shipped_corrections_are_applied(conn, transcribed_episode, paths, cfg):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=CORRECTIONS_FILE)
    assert "Cremona" in all_text(conn, transcribed_episode)


def test_no_chunk_is_boilerplate_even_when_five_episodes_share_a_passage(
    conn, paths, cfg, episodes_with_ad
):
    # Detection is off until the full corpus is available; the five copies of the ad stay text.
    run_chunk(conn, paths, cfg, episodes_with_ad)
    assert conn.execute("select count(*) from chunks").fetchone()[0] > 0
    assert conn.execute("select count(*) from chunks where is_boilerplate = 1").fetchone()[0] == 0


@pytest.fixture
def refreshes(monkeypatch):
    """The calls the chunk step makes to refresh_chunks."""
    calls = []
    real = steps.refresh_chunks

    def spy(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr("wts.steps.refresh_chunks", spy)
    return calls


def test_refresh_runs_once_then_only_when_inputs_change(
    conn, paths, cfg, transcribed_episode, refreshes, empty_corrections
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    assert len(refreshes) == 1  # nothing stored yet
    run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    assert len(refreshes) == 1  # idle runs don't refresh


def test_new_episodes_alone_do_not_trigger_a_refresh(
    conn, paths, cfg, make_episodes, refreshes, empty_corrections
):
    first, second = make_episodes(2)
    write_transcript(conn, paths, first, unique_sentences("one", 20))
    run_chunk(conn, paths, cfg, [first], corrections_file=empty_corrections)
    write_transcript(conn, paths, second, unique_sentences("two", 20))
    run_chunk(conn, paths, cfg, [second], corrections_file=empty_corrections)
    assert len(refreshes) == 1


def test_corrections_change_triggers_a_refresh(
    conn, paths, cfg, transcribed_episode, refreshes, empty_corrections, tmp_path
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    cf = tmp_path / "corrections.yaml"
    cf.write_text('global: {"marc": "Mark"}\n')
    run_chunk(conn, paths, cfg, [], corrections_file=cf)
    assert len(refreshes) == 2
    run_chunk(conn, paths, cfg, [], corrections_file=cf)
    assert len(refreshes) == 2


def test_chunker_version_change_triggers_a_refresh(
    conn, paths, cfg, transcribed_episode, refreshes, empty_corrections, monkeypatch
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    monkeypatch.setattr("wts.chunking.CHUNKER_VERSION", chunking.CHUNKER_VERSION + 1)
    run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    assert len(refreshes) == 2
    run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    assert len(refreshes) == 2


def test_stored_bare_corrections_sha_triggers_one_refresh(
    conn, paths, cfg, transcribed_episode, refreshes, empty_corrections
):
    # What an earlier version of the pipeline left in the kv table: the sha alone.
    kv_set(conn, "corrections_sha", corrections_sha(empty_corrections))
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    assert len(refreshes) == 1


def test_first_refresh_clears_boilerplate_flags_left_by_the_old_detector(
    conn, paths, cfg, transcribed_episode, empty_corrections
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    force_status(conn, transcribed_episode, "embedded")
    conn.execute("update chunks set is_boilerplate = 1 where seq = 0")
    kv_set(conn, "corrections_sha", corrections_sha(empty_corrections))
    conn.commit()
    counts = run_chunk(conn, paths, cfg, [], corrections_file=empty_corrections)
    assert counts["refreshed"] == 1
    assert boilerplate_chunk_count(conn, transcribed_episode) == 0
    assert status_of(conn, transcribed_episode) == "chunked"  # requeued for embedding


def test_unchanged_refresh_keeps_ids_and_status(
    conn, paths, cfg, transcribed_episode, monkeypatch
):
    run_chunk(conn, paths, cfg, [transcribed_episode])
    force_status(conn, transcribed_episode, "embedded")
    ids_before = chunk_ids(conn, transcribed_episode)
    monkeypatch.setattr("wts.chunking.CHUNKER_VERSION", chunking.CHUNKER_VERSION + 1)
    run_chunk(conn, paths, cfg, [])  # a refresh that finds the same chunks
    assert chunk_ids(conn, transcribed_episode) == ids_before
    assert status_of(conn, transcribed_episode) == "embedded"


def test_force_rechunk_applies_new_correction(
    conn, paths, cfg, transcribed_episode, tmp_path, empty_corrections
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    assert "Mark" not in all_text(conn, transcribed_episode).split()
    cf = tmp_path / "corrections.yaml"
    cf.write_text('global: {"marc": "Mark"}\n')
    run_chunk(conn, paths, cfg, [transcribed_episode], force=True, corrections_file=cf)
    assert "Mark" in all_text(conn, transcribed_episode).split()
    assert status_of(conn, transcribed_episode) == "chunked"


def test_corrections_edit_alone_triggers_refresh(
    conn, paths, cfg, transcribed_episode, tmp_path, empty_corrections
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    force_status(conn, transcribed_episode, "embedded")
    cf = tmp_path / "corrections.yaml"
    cf.write_text('global: {"marc": "Mark"}\n')
    run_chunk(conn, paths, cfg, [], corrections_file=cf)
    assert "Mark" in all_text(conn, transcribed_episode).split()
    assert status_of(conn, transcribed_episode) == "chunked"  # will be re-embedded


def test_interrupted_refresh_still_sends_episode_back_for_embedding(
    conn, paths, cfg, transcribed_episode, tmp_path, empty_corrections, monkeypatch
):
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=empty_corrections)
    force_status(conn, transcribed_episode, "embedded")
    cf = tmp_path / "corrections.yaml"
    cf.write_text('global: {"marc": "Mark"}\n')

    def killed(*args, **kwargs):
        raise KeyboardInterrupt

    with monkeypatch.context() as m:
        m.setattr("wts.state._now", killed)  # the process dies at the first status change
        with pytest.raises(KeyboardInterrupt):
            run_chunk(conn, paths, cfg, [], corrections_file=cf)
    run_chunk(conn, paths, cfg, [], corrections_file=cf)
    assert "Mark" in all_text(conn, transcribed_episode).split()
    assert status_of(conn, transcribed_episode) == "chunked"  # not left embedded with old vectors


def test_spaced_correction_keeps_word_times_aligned(conn, transcribed_episode, paths, cfg, tmp_path):
    cf = tmp_path / "c.yaml"
    cf.write_text("global:\n  kremona: Matt Cremona\n  um: ''\n")
    run_chunk(conn, paths, cfg, [transcribed_episode], corrections_file=cf)
    for text, times in conn.execute("select text, word_times from chunks"):
        assert len(text.split(" ")) == len(times.split(","))
    assert "Matt Cremona" in all_text(conn, transcribed_episode)


def test_probed_audio_duration_is_used_for_timing_checks(conn, transcribed_episode, paths, cfg):
    # The feed says 10 s, but the downloaded file (with inserted ads) is longer.
    conn.execute(
        "update episodes set duration_s = 10, audio_duration_s = 600 where id = ?",
        (transcribed_episode,),
    )
    conn.commit()
    run_chunk(conn, paths, cfg, [transcribed_episode])
    flags = conn.execute(
        "select flags from episodes where id = ?", (transcribed_episode,)
    ).fetchone()[0]
    assert "bad_word_times" not in json.loads(flags)


def test_unreadable_transcript_during_refresh_fails_only_that_episode(
    conn, paths, cfg, episodes_with_ad, monkeypatch
):
    first, second = episodes_with_ad[:2]
    run_chunk(conn, paths, cfg, [first])
    force_status(conn, first, "embedded")
    path = conn.execute("select transcript_path from episodes where id = ?", (first,)).fetchone()
    Path(path[0]).write_text("{not json")
    monkeypatch.setattr("wts.chunking.CHUNKER_VERSION", chunking.CHUNKER_VERSION + 1)
    counts = run_chunk(conn, paths, cfg, [second])
    assert status_of(conn, second) == "chunked" and counts["ok"] == 1
    assert status_of(conn, first) == "error"


def test_chunk_ids_are_never_reused(conn, paths, cfg, transcribed_episode, tmp_path):
    run_chunk(conn, paths, cfg, [transcribed_episode])
    old_max = max(chunk_ids(conn, transcribed_episode))
    conn.execute("delete from chunks where id = ?", (old_max,))
    conn.commit()
    run_chunk(conn, paths, cfg, [transcribed_episode], force=True)
    assert old_max not in chunk_ids(conn, transcribed_episode)


def test_missing_transcript_fails_episode(conn, paths, cfg, make_episode):
    e = make_episode(status="transcribed", transcript_path=str(paths.transcripts_dir / "nope.json"))
    counts = run_chunk(conn, paths, cfg, [e])
    assert status_of(conn, e) == "error" and counts["error"] == 1


def test_errored_episode_is_retried(conn, paths, cfg, transcribed_episode):
    fail(conn, transcribed_episode, "chunk", "earlier bug")
    run_chunk(conn, paths, cfg, [transcribed_episode])
    assert status_of(conn, transcribed_episode) == "chunked"


def test_prepare_episode_returns_sentences_and_flags(conn, transcribed_episode):
    row = conn.execute("select * from episodes where id = ?", (transcribed_episode,)).fetchone()
    sentences, flags = prepare_episode(row, [])
    assert len(sentences) == 20 and isinstance(flags, list)


def test_prepare_episode_joins_hyphenated_words_after_corrections(conn, paths, make_episode):
    e = make_episode()
    body = unique_sentences("solo", 20)
    body[2] = "we built a rubo -style bench with a split -top"
    write_transcript(conn, paths, e, body)
    row = conn.execute("select * from episodes where id = ?", (e,)).fetchone()
    # Corrections see "rubo" on its own first; joined first, "rubo-style" would not match.
    sentences, _ = prepare_episode(row, [CorrectionRule(("rubo",), "Roubo", None)])
    assert sentences[2].text == "we built a Roubo-style bench with a split-top."


def test_chunk_cli(wts_home):
    r = CliRunner().invoke(main, ["chunk", "--select", "all", "--force"])
    assert r.exit_code == 0, r.output
    assert "chunk: nothing to do (0:00)" in r.output
