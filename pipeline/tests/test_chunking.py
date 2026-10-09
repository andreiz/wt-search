import json
from pathlib import Path

import pytest
from click.testing import CliRunner
from conftest import force_status, seg, status_of, tx

from wts.chunking import prepare_episode
from wts.cli import main
from wts.corrections import CORRECTIONS_FILE, CorrectionRule
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


def test_chunk_reports_chunks_boilerplate_and_flags(conn, paths, cfg, episodes_with_ad,
                                                     wts_messages):
    slow = episodes_with_ad[0]  # ~230 words over 10 minutes: wpm_low
    conn.execute("update episodes set audio_duration_s = 600 where id = ?", (slow,))
    conn.commit()
    counts = run_chunk(conn, paths, cfg, episodes_with_ad)
    total, bp = conn.execute(
        "select count(*), sum(is_boilerplate) from chunks"
    ).fetchone()
    assert (counts["chunks"], counts["boilerplate"], counts["flagged"]) == (total, bp, 1)
    assert bp > 0
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


def test_fifth_episode_with_ad_flips_earlier_episodes_back_to_chunked(
    conn, paths, cfg, episodes_with_ad
):
    first4, fifth = episodes_with_ad[:4], episodes_with_ad[4]
    run_chunk(conn, paths, cfg, first4)
    assert boilerplate_chunk_count(conn, first4[0]) == 0  # only 4 episodes share the ad so far
    for e in first4:
        force_status(conn, e, "embedded")
    run_chunk(conn, paths, cfg, [fifth])
    assert all(status_of(conn, e) == "chunked" for e in first4)
    assert boilerplate_chunk_count(conn, first4[0]) >= 1
    assert boilerplate_chunk_count(conn, fifth) >= 1


def test_unchanged_refresh_keeps_ids_and_status(conn, paths, cfg, transcribed_episode):
    run_chunk(conn, paths, cfg, [transcribed_episode])
    force_status(conn, transcribed_episode, "embedded")
    ids_before = chunk_ids(conn, transcribed_episode)
    run_chunk(conn, paths, cfg, [])  # nothing new; refresh is a no-op
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
    conn, paths, cfg, episodes_with_ad
):
    first, second = episodes_with_ad[:2]
    run_chunk(conn, paths, cfg, [first])
    force_status(conn, first, "embedded")
    path = conn.execute("select transcript_path from episodes where id = ?", (first,)).fetchone()
    Path(path[0]).write_text("{not json")
    counts = run_chunk(conn, paths, cfg, [second])
    assert status_of(conn, second) == "chunked" and counts["ok"] == 1
    assert status_of(conn, first) == "error"


def test_flag_change_keeps_chunk_ids(conn, paths, cfg, episodes_with_ad):
    first4, fifth = episodes_with_ad[:4], episodes_with_ad[4]
    run_chunk(conn, paths, cfg, first4)
    before = chunk_ids(conn, first4[0])
    run_chunk(conn, paths, cfg, [fifth])  # flips first4's ad chunks to boilerplate
    assert boilerplate_chunk_count(conn, first4[0]) >= 1
    assert chunk_ids(conn, first4[0]) == before


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


@pytest.mark.xfail(
    strict=True,
    reason="Deferred to phase 2 (spec §3.5, §9): Whisper splits the same sponsor read into "
    "different sentences per episode, and the read is interleaved with host talk, so 30 s "
    "chunks stay under the 60% share. Remove this mark when the rework lands.",
)
def test_real_sponsor_reads_flagged(conn, paths, cfg, make_episodes, real_transcripts):
    ids = make_episodes(len(real_transcripts))
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    for e, data in zip(ids, real_transcripts, strict=True):
        out = paths.transcripts_dir / f"real-{e}.json"
        out.write_text(json.dumps(data))
        conn.execute(
            "update episodes set transcript_path = ?, duration_s = ?, status = 'transcribed' "
            "where id = ?",
            (str(out), data["meta"].get("duration_s"), e),
        )
    conn.commit()
    run_chunk(conn, paths, cfg, ids)
    with_bp = sum(1 for e in ids if boilerplate_chunk_count(conn, e) >= 1)
    total_words = bp_words = 0
    for text, bp in conn.execute("select text, is_boilerplate from chunks"):
        total_words += len(text.split())
        bp_words += len(text.split()) if bp else 0
    assert with_bp >= min(5, len(ids))
    assert bp_words < 0.15 * total_words
