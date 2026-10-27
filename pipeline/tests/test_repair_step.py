"""`wts repair` (repair spec §5.5): holes → fresh clip passes → proposed repairs on disk."""

import json
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import seg_with_word_starts, status_of

from wts.repairing import repairs_due
from wts.repairs import load_repairs, save_repairs
from wts.steps import run_chunk, run_repair
from wts.transcribe import RawSegment, RawTranscript, RawWord
from wts.transcribe_remote import RemoteJobFailed, TranscriberUnavailable


class Speech:
    def __init__(self, spans):
        self.spans = spans

    def speech(self, audio):
        return self.spans


def clipper(audio, clip, out: Path) -> Path:
    out.write_text(f"{clip[0]},{clip[1]}")  # the fake transcriber reads the span back
    return out


def said(texts: str, start_s: float, step_s: float = 0.3) -> list[tuple[str, float]]:
    return [(t, start_s + i * step_s) for i, t in enumerate(texts.split())]


class ClipTranscriber:
    """Hears `script` (words at episode times): returns those inside the clip, in clip time."""

    def __init__(self, script, fail_at=(), unavailable=False):
        self.script, self.fail_at, self.unavailable = script, set(fail_at), unavailable
        self.calls = 0

    def transcribe(self, audio, initial_prompt):
        self.calls += 1
        start, end = (int(x) for x in audio.read_text().split(","))
        if self.unavailable:
            raise TranscriberUnavailable("walnut is down")
        if any(start <= t < end for t in self.fail_at):
            raise RemoteJobFailed("job failed")
        words = [
            RawWord(s - start / 1000, s - start / 1000 + 0.25, f" {t}", 0.9)
            for t, s in self.script if start <= s * 1000 < end
        ]
        segs = [RawSegment(words[0].start, words[-1].end, " x", 0.01, -0.2, words)] if words else []
        return RawTranscript(segs, "fake", "0")


LEFT, RIGHT = "one two three four five", "six seven eight nine ten"
NEW = "any sort of serious risk about it"
NEW21 = " ".join(f"n{i}" for i in range(21))


@pytest.fixture
def episode(conn, paths, make_episode, audio_file):
    """Words at 0–1.6 s and 13–14.6 s; the audio between is speech the transcript lacks."""

    def make(segments=None, **row):
        row = {"audio_path": str(audio_file), "duration_s": 60, "status": "transcribed", **row}
        e = make_episode(**row)
        stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
        segments = segments or [
            seg_with_word_starts(LEFT, [0, 0.4, 0.8, 1.2, 1.6], 0, 2),
            seg_with_word_starts(RIGHT, [13, 13.4, 13.8, 14.2, 14.6], 13, 15),
        ]
        paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
        t = paths.transcripts_dir / f"{stem}.json"
        t.write_text(json.dumps({"meta": {}, "segments": segments}))
        conn.execute("update episodes set transcript_path = ? where id = ?", (str(t), e))
        conn.commit()
        return e, t

    return make


def repair_once(conn, paths, cfg, ids, transcriber, speech, **kw):
    return run_repair(conn, paths, cfg, ids, transcriber=transcriber, detector=Speech(speech),
                      clipper=clipper, **kw)


def test_proposes_and_saves(conn, paths, cfg, episode):
    e, t = episode()
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(NEW, 5) + said(RIGHT, 13, 0.4))
    counts = repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    rf = load_repairs(t)
    assert rf.flags == [(5000, 12000)]
    (r,) = rf.repairs
    assert r.status == "proposed"
    assert [w.text for w in r.after] == NEW.split()
    assert 2 in r.fails  # 7 words for 7 s of speech is too slow to be clear-cut
    assert r.second_after is not None
    assert counts["proposed"] == 1 and counts["episodes"] == 1 and tr.calls == 2


def test_auto_when_configured(conn, paths, cfg, episode, tmp_path):
    e, t = episode()
    empty = tmp_path / "empty.yaml"
    empty.write_text("global: {}\nepisodes: {}\n")
    run_chunk(conn, paths, cfg, [e], corrections_file=empty)
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(NEW21, 5) + said(RIGHT, 13, 0.4))
    counts = repair_once(conn, paths, replace(cfg, repair_auto=True), [e], tr, [(5000, 12000)],
                         corrections_file=empty)
    (r,) = load_repairs(t).repairs
    assert (r.status, r.fails) == ("auto", [])
    assert counts["auto"] == 1
    text = " ".join(x[0] for x in conn.execute("select text from chunks where episode_id = ?", (e,)))
    assert "n0 n1 n2" in text


def test_stretched_word_over_a_hole_counts_the_hole_speech(conn, paths, cfg, episode):
    # Whisper stretched "five" from 1.6 s to 13 s over the skipped passage. The repair's
    # stretch then runs from five's (stretched) end, but the speech it fills is the hole's.
    stretched = seg_with_word_starts(LEFT, [0, 0.4, 0.8, 1.2, 1.6], 0, 13)
    stretched["words"][-1]["end"] = 13.0
    e, t = episode([stretched, seg_with_word_starts(RIGHT, [13.2, 13.6, 14.0, 14.4, 14.8], 13.2, 15)])
    new = " ".join(f"n{i}" for i in range(30))
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(new, 3.0, 0.33) + said(RIGHT, 13.2, 0.4))
    repair_once(conn, paths, cfg, [e], tr, [(3000, 13000)])
    (r,) = load_repairs(t).repairs
    assert 2 not in r.fails  # 30 words over ~10 s of speech is an ordinary rate


def test_drops_flag_when_fresh_adds_nothing(conn, paths, cfg, episode):
    e, t = episode()
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(RIGHT, 13, 0.4))
    counts = repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    rf = load_repairs(t)
    assert rf.repairs == [] and rf.flags == [(5000, 12000)]
    assert counts["dropped"] == 1


def test_failed_clip_drops_that_flag_only(conn, paths, cfg, episode):
    e, t = episode([
        seg_with_word_starts(LEFT, [0, 0.4, 0.8, 1.2, 1.6], 0, 2),
        seg_with_word_starts(RIGHT, [13, 13.4, 13.8, 14.2, 14.6], 13, 15),
        seg_with_word_starts("a b c d e", [30, 30.4, 30.8, 31.2, 31.6], 30, 32),
        seg_with_word_starts("f g h i j", [43, 43.4, 43.8, 44.2, 44.6], 43, 45),
    ])
    script = (said(LEFT, 0, 0.4) + said(NEW, 5) + said(RIGHT, 13, 0.4)
              + said("a b c d e", 30, 0.4) + said(NEW, 35) + said("f g h i j", 43, 0.4))
    tr = ClipTranscriber(script, fail_at=[5.0])  # any clip holding 5 s fails
    counts = repair_once(conn, paths, cfg, [e], tr, [(5000, 12000), (35000, 42000)])
    (r,) = load_repairs(t).repairs
    assert r.hole == (35000, 42000)
    assert counts["failed"] == 1 and counts["proposed"] == 1 and counts["error"] == 0
    assert status_of(conn, e) == "transcribed"
    # Not "nothing found": the episode stays due, and the next run tries the flag again,
    # keeping the decision already made on the other repair.
    rf = load_repairs(t)
    rf.repairs[0].status = "accepted"
    save_repairs(t, rf)
    assert repairs_due(t)
    tr.fail_at = set()
    repair_once(conn, paths, cfg, [e], tr, [(5000, 12000), (35000, 42000)])
    got = {r.hole: r.status for r in load_repairs(t).repairs}
    assert got == {(5000, 12000): "proposed", (35000, 42000): "accepted"}
    assert not repairs_due(t)


def test_rechunk_failure_does_not_stop_the_step(conn, paths, cfg, episode, monkeypatch):
    e, _ = episode()
    conn.execute("update episodes set status = 'chunked' where id = ?", (e,))
    conn.commit()

    def broken(*args, **kwargs):
        raise ValueError("chunking blew up")

    monkeypatch.setattr("wts.steps.chunk_episode", broken)
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(NEW21, 5) + said(RIGHT, 13, 0.4))
    counts = repair_once(conn, paths, replace(cfg, repair_auto=True), [e], tr, [(5000, 12000)])
    assert counts["error"] == 1
    assert status_of(conn, e) == "error"


def test_overlapping_proposals_kept_once(conn, paths, cfg, episode):
    e, t = episode([
        seg_with_word_starts(LEFT, [0, 0.4, 0.8, 1.2, 1.6], 0, 2),
        seg_with_word_starts(RIGHT, [25, 25.4, 25.8, 26.2, 26.6], 25, 27),
    ])
    long_new = " ".join(f"m{i}" for i in range(60))
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(long_new, 3, 0.35) + said(RIGHT, 25, 0.4))
    counts = repair_once(conn, paths, cfg, [e], tr, [(3000, 6000), (13000, 16000)])
    assert len(load_repairs(t).repairs) == 1
    assert counts["dropped"] == 1


def test_missing_audio_is_skipped(conn, paths, cfg, episode, tmp_path):
    e, t = episode(audio_path=str(tmp_path / "gone.mp3"))
    tr = ClipTranscriber([])
    counts = repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    assert counts["skipped"] == 1 and load_repairs(t) is None and tr.calls == 0


def test_up_to_date_file_is_left_alone(conn, paths, cfg, episode):
    e, _t = episode()
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(NEW, 5) + said(RIGHT, 13, 0.4))
    repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    counts = repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    assert counts["episodes"] == 0 and tr.calls == 2


def test_unavailable_stops_with_count(conn, paths, cfg, episode):
    e, _ = episode()
    with pytest.raises(TranscriberUnavailable, match="1 episode left to repair"):
        repair_once(conn, paths, cfg, [e], ClipTranscriber([], unavailable=True), [(5000, 12000)])


def test_redo_keeps_decisions(conn, paths, cfg, episode):
    e, t = episode()
    tr = ClipTranscriber(said(LEFT, 0, 0.4) + said(NEW, 5) + said(RIGHT, 13, 0.4))
    repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    rf = load_repairs(t)
    rf.repairs[0].status = "accepted"
    save_repairs(t, rf)
    data = json.loads(t.read_text())
    data["meta"]["transcribed_at"] = "again"  # re-transcribed: the file is now stale
    t.write_text(json.dumps(data))
    repair_once(conn, paths, cfg, [e], tr, [(5000, 12000)])
    assert [r.status for r in load_repairs(t).repairs] == ["accepted"]
