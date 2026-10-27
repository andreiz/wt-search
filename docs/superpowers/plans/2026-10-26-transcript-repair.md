# Transcript Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find stretches where someone speaks but the transcript has no words, re-transcribe
just that clip, and let the maintainer accept or reject each proposed repair on the review page;
accepted repairs reach search through `wts chunk`.

**Architecture:** Pure hole-finding (`wts.holes`) over the guards' cleaned words and Silero VAD
speech spans (`wts.vad`); proposals made by aligning a fresh clip transcription with the
transcript (`wts.repair`), judged by the five-check rule (`wts.repair_rule`), stored beside the
transcript in `<stem>.repairs.json` (`wts.repairs`), applied in one shared function that both
`wts chunk` and the review page call. A new `wts repair` step runs between transcribe and chunk,
beside the status machine (like corrections). The review page gets a repairs list and a
side-by-side panel above the transcript.

**Tech Stack:** Python 3.13, click, httpx, `silero-vad` (CPU), ffmpeg; the review page's
standard-library server and vanilla JS; Playwright for the page test.

**Spec:** `docs/superpowers/specs/2026-10-26-transcript-repair-design.md`

## Global Constraints

- Whisper's raw transcript JSON is never edited; repairs live in `<stem>.repairs.json` beside it.
- No change to transcribe-web: clips go through `RemoteTranscriber.transcribe(path, prompt)`.
- Tests run on Linux with ML faked (`FakeTranscriber`, fake speech detector); VAD and Whisper
  stay behind seams.
- Hole: speech no word covers, a word covering `min(end, start + 1.0 s) + 0.3 s`; at least
  **1.5 s**; flags within **5 s** are one flag; only between the first and last word.
- Clip: **10 s** before the flag to **10 s** after (clamped to the audio); second pass starts
  **5 s** earlier, on the same transcriber.
- Prompt: today's vocabulary prompt (`build_initial_prompt(VOCAB_FILE)`), no earlier episode text.
- Rule checks (numbered as in the spec): 1 ≥ 5 matching words each side; 2 new words per second
  of uncovered speech in [1.5, 4.5]; 3 share of new words with probability ≥ 0.5 at least
  **0.8** (ruling: the spec leaves the share to the builder); 4 no loop, no repeat of a
  neighbouring sentence, no stock phrase; 5 second pass's new words essentially the same
  (normalised-token similarity ≥ **0.9**).
- `repair_auto` in config.toml, default **false**. Repair statuses: `proposed`, `accepted`,
  `rejected`, `auto`.
- Undecided repairs never hold an episode back.
- Commits straight to `main`, messages end with the session's two attribution lines; never push.

## Review Focus

1. A hole at the very start or end of an episode (no word on one side): the clip clamps to the
   audio, the proposal has 0 anchors on that side, the rule asks (fails 1), and applying it
   still works. Pinned in Task 3 and Task 5.
2. Two flags whose proposals overlap (one clip covers both): one repair, not two that splice the
   same words twice. Pinned in Task 6.
3. A transcript replaced after a decision: applying a repair whose `before` words no longer match
   skips it (and logs) instead of splicing into the wrong place. Pinned in Task 5.
4. A clip transcription that fails (`RemoteJobFailed`) or returns nothing: that flag is dropped,
   the episode's other flags still get repairs, the episode is not failed. Pinned in Task 6.
5. An episode whose audio file is gone: skipped with a warning and counted, no crash, no repairs
   file written. Pinned in Task 6.

---

### Task 1: Hole finding (`wts.holes`)

**Files:**
- Create: `pipeline/src/wts/holes.py`
- Test: `pipeline/tests/test_holes.py`

**Interfaces:**
- Consumes: `wts.words.Word` (`text, start_ms, end_ms, prob`).
- Produces:
  - `Span = tuple[int, int]` (ms, start < end)
  - `WORD_COVER_MS = 1000`, `PAD_MS = 300`, `MIN_HOLE_MS = 1500`, `JOIN_MS = 5000`
  - `uncovered(words: Sequence[Word]) -> list[Span]`
  - `find_holes(words: Sequence[Word], speech: Sequence[Span], min_ms: int = MIN_HOLE_MS, join_ms: int = JOIN_MS) -> list[Span]`
  - `speech_between(speech: Sequence[Span], span: Span) -> int` (ms of speech inside `span`)

- [ ] **Step 1: Write the failing tests**

```python
from wts.holes import find_holes, speech_between, uncovered
from wts.words import Word

def w(text, start_s, end_s):
    return Word(text, round(start_s * 1000), round(end_s * 1000), 0.9)

def test_uncovered_caps_a_stretched_word():
    # "away" stretches 8 s over a skipped passage; it covers only 1.0 s + 0.3 s.
    words = [w("throw", 0, 0.3), w("away", 0.4, 8.4), w("that", 8.5, 8.8)]
    assert uncovered(words) == [(1700, 8500)]

def test_hole_needs_speech_and_length():
    words = [w("a", 0, 0.2), w("b", 10, 10.2)]          # uncovered 500..10000
    assert find_holes(words, speech=[(2000, 3000)]) == []  # only 1.0 s of speech
    assert find_holes(words, speech=[(2000, 3600)]) == [(2000, 3600)]

def test_flags_within_5_s_join():
    words = [w("a", 0, 0.2), w("b", 30, 30.2)]
    speech = [(1000, 3000), (6000, 8000), (20000, 22000)]
    assert find_holes(words, speech) == [(1000, 8000), (20000, 22000)]

def test_nothing_before_first_or_after_last_word():
    words = [w("a", 10, 10.2), w("b", 11, 11.2)]
    assert find_holes(words, speech=[(0, 9000), (12000, 20000)]) == []

def test_speech_between():
    assert speech_between([(0, 1000), (2000, 5000)], (500, 3000)) == 1500
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_holes.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.holes'`

- [ ] **Step 3: Implement the four names in `pipeline/src/wts/holes.py`**

Same algorithm as the spike (`uncovered`, interval intersection with speech, joining flags whose
gap is ≤ `join_ms`, then dropping those shorter than `min_ms` after joining). Module docstring
cites spec 2026-10-26 transcript repair §5.1.

- [ ] **Step 4: Run them to see them pass**

Run: `cd pipeline && uv run pytest tests/test_holes.py -q && uv run ruff check .`
Expected: 5 passed; ruff clean.

- [ ] **Step 5: Commit**

`git add pipeline/src/wts/holes.py pipeline/tests/test_holes.py` and commit
"pipeline: holes.py finds speech the transcript has no words for (repair spec §5.1)".

---

### Task 2: Speech detection seam (`wts.vad`) and the dependency

**Files:**
- Create: `pipeline/src/wts/vad.py`
- Modify: `pipeline/pyproject.toml` (dependencies), `pipeline/uv.lock`
- Test: `pipeline/tests/test_vad.py`

**Interfaces:**
- Produces:
  - `class SpeechDetector(Protocol): def speech(self, audio: Path) -> list[Span]: ...`
  - `class SileroDetector` implementing it: decodes with ffmpeg to 16 kHz mono float32, runs
    `silero_vad.get_speech_timestamps(..., sampling_rate=16000, return_seconds=True)`, returns
    ms spans. Model loaded once per instance, lazily; `silero_vad`/`torch` imported inside
    methods so importing `wts.vad` stays cheap.

- [ ] **Step 1: Add the dependency**

Run: `cd pipeline && uv add silero-vad`
Ruling (ledger it): `silero-vad` brings CPU `torch` into the core dependencies, not the `mac`
extra, because repair must also run on the later Linux runner; the spec's "torch is already one"
was true only of the `mac` extra.

- [ ] **Step 2: Write the failing test**

```python
import wave
import numpy as np
from wts.vad import SileroDetector

def test_silence_has_no_speech(tmp_path):
    path = tmp_path / "silence.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
        f.writeframes(np.zeros(16000 * 3, dtype=np.int16).tobytes())
    assert SileroDetector().speech(path) == []
```

(Needs ffmpeg on PATH, as `wts download`'s probe already does.)

- [ ] **Step 3: Run it to see it fail** — `uv run pytest tests/test_vad.py -q`; Expected: ImportError.
- [ ] **Step 4: Implement `pipeline/src/wts/vad.py`**; silence torch's `FutureWarning` from
  `torch.jit.load` around model loading only.
- [ ] **Step 5: Run it to see it pass** — Expected: 1 passed; then the full suite
  `uv run pytest -q` still passes.
- [ ] **Step 6: Commit** "pipeline: SileroDetector finds speech in an episode's audio (repair spec §5.1)".

---

### Task 3: Proposals from a fresh clip pass (`wts.repair`)

**Files:**
- Create: `pipeline/src/wts/repair.py`
- Test: `pipeline/tests/test_repair.py`

**Interfaces:**
- Consumes: `Span`, `Word`, `RawTranscript` (`wts.transcribe`), `clean_transcript` (`wts.guards`).
- Produces:
  - `CLIP_PAD_MS = 10_000`, `SECOND_PASS_SHIFT_MS = 5_000`, `MIN_NEW_WORDS = 3`
  - `clip_span(hole: Span, duration_ms: int, shift_ms: int = 0) -> Span` — `(max(0, hole[0] - CLIP_PAD_MS - shift_ms), min(duration_ms, hole[1] + CLIP_PAD_MS))`
  - `clip_words(fresh: RawTranscript, clip_start_ms: int) -> list[Word]` — the fresh segments
    through `clean_transcript` (as dicts, duration `None`), every time shifted by `clip_start_ms`
  - `@dataclass(frozen=True) class Proposal: from_ms: int; to_ms: int; before: tuple[Word, ...]; after: tuple[Word, ...]; left_anchor: int; right_anchor: int`
    — the repair replaces every transcript word with `from_ms < start_ms < to_ms` by `after`;
    `from_ms` is the left anchor word's `end_ms` (or `-1`), `to_ms` the right anchor word's
    `start_ms` (or `2**31`); `left_anchor`/`right_anchor` count consecutive matching words.
  - `propose(words: Sequence[Word], hole: Span, clip: Span, fresh: Sequence[Word]) -> Proposal | None`
  - `cut_clip(audio: Path, clip: Span, out: Path) -> Path` — `ffmpeg -v error -ss S -to E -i audio -ac 1 -c:a libmp3lame -b:a 64k out` (re-encoded: MP3 stream copy cuts on frame edges only)

`propose` aligns the transcript's words inside `clip` with `fresh` by normalised token
(`wts.words.normalize_text` per word; `difflib.SequenceMatcher(autojunk=False)`), takes the
non-equal stretch that overlaps `hole` (widened to its matching neighbours), and returns a
Proposal only if `len(after) >= MIN_NEW_WORDS` and `len(before) <= max(1, len(after) // 4)`.

- [ ] **Step 1: Write the failing tests** (build `Word` lists with a helper; times in s)

```python
def test_fills_a_hole_between_anchors():
    # transcript: "one two three four five <8 s gap> six seven eight nine ten"
    # fresh: same, plus "any sort of serious risk about it" in the gap
    p = propose(transcript, hole=(5000, 13000), clip=(0, 20000), fresh=fresh)
    assert [x.text for x in p.after] == ["any", "sort", "of", "serious", "risk", "about", "it"]
    assert p.before == ()
    assert (p.left_anchor, p.right_anchor) == (5, 5)
    assert p.from_ms == transcript[4].end_ms and p.to_ms == transcript[5].start_ms

def test_replaces_a_short_heading_over_a_skip():
    # transcript has "Tom's Tips. Tom's Tips." where fresh has 20 words: proposal replaces both
    ...
    assert [x.text for x in p.before] == ["Tom's", "Tips.", "Tom's", "Tips."]
    assert len(p.after) == 20

def test_no_proposal_when_fresh_adds_little():
    assert propose(transcript, hole, clip, fresh_with_two_extra_words) is None

def test_hole_at_episode_start_has_no_left_anchor():
    p = propose(words_starting_at_9s, hole=(0, 8000), clip=(0, 18000), fresh=fresh_from_0)
    assert p.left_anchor == 0 and p.from_ms == -1

def test_clip_span_clamps_and_shifts():
    assert clip_span((3000, 5000), duration_ms=60_000) == (0, 15_000)
    assert clip_span((30_000, 32_000), 60_000, shift_ms=5000) == (15_000, 42_000)
    assert clip_span((55_000, 58_000), 60_000) == (45_000, 60_000)

def test_clip_words_shifts_times():
    # one fresh segment at 0.0–1.0 s, clip starting at 40 s
    assert [x.start_ms for x in clip_words(fresh_raw, 40_000)] == [40_000, 40_400]
```

- [ ] **Step 2: Run them to see them fail** — `uv run pytest tests/test_repair.py -q`; Expected: ImportError.
- [ ] **Step 3: Implement `pipeline/src/wts/repair.py`** with the names above. `cut_clip` is not
  unit-tested (ffmpeg); Task 6 injects a fake clipper.
- [ ] **Step 4: Run them to see them pass** — Expected: 6 passed; ruff clean.
- [ ] **Step 5: Commit** "pipeline: repair.py proposes the words a fresh clip pass has where the transcript has none".

---

### Task 4: The automatic rule (`wts.repair_rule`)

**Files:**
- Create: `pipeline/src/wts/repair_rule.py`
- Test: `pipeline/tests/test_repair_rule.py`

**Interfaces:**
- Consumes: `Proposal` (Task 3), `wts.guards._has_loop`, `wts.words.normalize_text`.
- Produces:
  - `MIN_ANCHOR = 5`, `RATE = (1.5, 4.5)`, `CONFIDENT_PROB = 0.5`, `CONFIDENT_SHARE = 0.8`,
    `AGREE = 0.9`, `STOCK_PHRASES = ("thanks for watching", "thank you for watching", "please subscribe", "like and subscribe")`
  - `judge(p: Proposal, second: Proposal | None, speech_ms: int, nearby: Sequence[Word]) -> list[int]`
    — the numbers of the failed checks (1–5), empty when clear-cut. `speech_ms` is the
    uncovered speech the repair fills (`speech_between` over `(p.from_ms, p.to_ms)` clamped to
    the clip); `nearby` is the transcript's 60 words on each side; check 2's word count is
    `len(after) - len(before)`; check 5 fails when `second` is None.

- [ ] **Step 1: Write the failing tests** — one passing case and one per check:

```python
def test_clear_cut(): assert judge(good, second=good, speech_ms=8000, nearby=ctx) == []
def test_fails_1_without_anchors(): assert 1 in judge(replace(good, left_anchor=2), good, 8000, ctx)
def test_fails_2_too_few_words_for_the_speech(): assert 2 in judge(good_22_words, good_22_words, 30_000, ctx)
def test_fails_3_unsure_words(): assert 3 in judge(good_with_half_prob_0_2, ..., 8000, ctx)
def test_fails_4_loop(): assert 4 in judge(after_is_the_same_phrase_x6, ...)
def test_fails_4_repeats_neighbour(): assert 4 in judge(after_equals_a_sentence_in_ctx, ...)
def test_fails_4_stock_phrase(): assert 4 in judge(after_ending_thanks_for_watching, ...)
def test_fails_5_second_pass_differs(): assert judge(good, other_words, 8000, ctx) == [5]
def test_fails_5_without_second_pass(): assert judge(good, None, 8000, ctx) == [5]
```

- [ ] **Step 2: Run them to see them fail**; Expected: ImportError.
- [ ] **Step 3: Implement `judge`**; check 5 compares normalised token lists with
  `SequenceMatcher(...).ratio() >= AGREE`.
- [ ] **Step 4: Run them to see them pass**; Expected: 9 passed.
- [ ] **Step 5: Commit** "pipeline: repair_rule.py judges whether a repair is clear-cut (repair spec §5.3)".

---

### Task 5: The repairs file, applying repairs, and one shared cleaned-words function

**Files:**
- Create: `pipeline/src/wts/repairs.py`
- Modify: `pipeline/src/wts/chunking.py` (`prepare_episode`), `pipeline/src/wts/review/data.py` (`episode_payload`)
- Test: `pipeline/tests/test_repairs.py`, plus one case each in `tests/test_chunking.py` and `tests/test_review_data.py`

**Interfaces:**
- Consumes: `Proposal` (Task 3), `clean_transcript`.
- Produces:
  - `STATUSES = ("proposed", "accepted", "rejected", "auto")`; `APPLIED = ("accepted", "auto")`
  - `@dataclass class Repair: id: str; hole: Span; clip: Span; from_ms: int; to_ms: int; before: list[Word]; after: list[Word]; second_after: list[Word] | None; fails: list[int]; status: str`
    — `id` is `f"{hole[0]}-{hole[1]}"`
  - `@dataclass class RepairsFile: transcript_sha: str; flags: list[Span]; repairs: list[Repair]`
    — `flags` keeps every flag found, repaired or not (the audit's flags per hour)
  - `repairs_path(transcript_path: Path) -> Path` — `<stem>.repairs.json` beside it
  - `transcript_sha(transcript_path: Path) -> str` (sha256 of the file's bytes)
  - `load_repairs(transcript_path: Path) -> RepairsFile | None`; `save_repairs(transcript_path: Path, rf: RepairsFile) -> None` (temp file + replace)
  - `apply_repairs(words: list[Word], repairs: Sequence[Repair]) -> list[Word]` — applies
    `APPLIED` ones in time order; a repair whose words in `(from_ms, to_ms)` don't equal
    `before` by text is skipped with a warning log
  - `carry_decisions(old: Sequence[Repair], new: list[Repair]) -> None` — a new repair takes an
    old one's status when the holes overlap and the normalised `after` texts are equal
  - `cleaned_words(row: sqlite3.Row) -> tuple[list[Word], list[str]]` — `clean_transcript` on
    the transcript, then `apply_repairs` with its repairs file when one exists and its
    `transcript_sha` matches (a stale file applies nothing)

`prepare_episode` and `episode_payload` both call `cleaned_words` in place of
`clean_transcript`, so the review page's words keep matching `wts chunk`'s.

- [ ] **Step 1: Write the failing tests**

```python
def test_round_trip(tmp_path): ...  # save then load gives equal RepairsFile
def test_apply_accepted_only(): ...  # proposed/rejected change nothing; accepted inserts `after`
def test_apply_skips_when_before_no_longer_matches(caplog): ...  # words unchanged, warning logged
def test_apply_with_no_left_anchor(): ...  # from_ms=-1 replaces from the episode's start
def test_carry_decisions(): ...  # overlap+same text keeps "accepted"; different text stays "proposed"
def test_stale_file_applies_nothing(tmp_path): ...  # transcript bytes changed → cleaned_words == clean_transcript
# tests/test_chunking.py
def test_chunk_includes_accepted_repair(...): ...  # chunk text contains the repair's words
# tests/test_review_data.py
def test_payload_words_include_accepted_repair(...): ...  # no "differ from wts chunk's" error
```

- [ ] **Step 2: Run them to see them fail**; Expected: ImportError / assertion failures.
- [ ] **Step 3: Implement `repairs.py`, then switch the two callers to `cleaned_words`.**
- [ ] **Step 4: Run** `uv run pytest -q && uv run ruff check .`; Expected: all pass.
- [ ] **Step 5: Commit** "pipeline: accepted repairs are spliced into the cleaned words that wts chunk and the review page share".

---

### Task 6: The `wts repair` step

**Files:**
- Modify: `pipeline/src/wts/steps.py` (new `run_repair`, called in `run_all`), `pipeline/src/wts/cli.py` (`wts repair`, `wts run`), `pipeline/src/wts/config.py` (`repair_auto`)
- Test: `pipeline/tests/test_repair_step.py`, one case in `tests/test_run.py`, one in `tests/test_config.py`

**Interfaces:**
- Consumes: Tasks 1–5; `get_transcriber(cfg, local=)`, `build_initial_prompt(VOCAB_FILE)`,
  `TranscriberUnavailable`, `RemoteJobFailed`, `MachineProblem`.
- Produces:
  - `Config.repair_auto: bool = False` (config.toml key `repair_auto`)
  - `run_repair(conn, paths, cfg, ids, *, transcriber=None, detector: SpeechDetector | None = None, clipper=cut_clip, local: bool = False) -> Counter`
    with counts `episodes`, `flags`, `proposed`, `auto`, `dropped`, `skipped`, `error`
  - `wts repair [--select …] [--local]`; `wts run` runs it after transcribe and before chunk

Which episodes: selected ones with status `transcribed`, `chunked`, `embedded` or `published`
whose repairs file is missing or stale. Per episode: VAD speech → holes on `clean_transcript`
words → for each hole a first pass (clip, `propose`), and when it proposes, a second pass
(`shift_ms=SECOND_PASS_SHIFT_MS`) and `judge`; status `auto` when `cfg.repair_auto` and no
fails, else `proposed`; overlapping proposals keep the first; `carry_decisions` from a stale
old file; `save_repairs`. If the set of applied repairs changed and the episode is already
chunked or later, call `chunk_episode` (it requeues embedding). Not a status step: a failure is
logged and counted, the episode's status is untouched. `TranscriberUnavailable` stops the step
with "; N episodes left to repair", like transcribe.

- [ ] **Step 1: Write the failing tests** (fake detector returning fixed spans; a
  `FakeTranscriber` variant returning a different transcript per clip; fake clipper writing a
  small file)

```python
def test_proposes_and_saves(...):        # one hole → one proposed repair with fails recorded
def test_auto_when_configured(...):      # repair_auto=True and clear-cut → status "auto", chunks updated
def test_drops_flag_when_fresh_adds_nothing(...):   # counts["dropped"] == 1, no repair
def test_failed_clip_drops_that_flag_only(...):     # RemoteJobFailed on one clip, other hole repaired
def test_overlapping_proposals_kept_once(...):
def test_missing_audio_is_skipped(...):  # counts["skipped"] == 1, no file written
def test_up_to_date_file_is_left_alone(...):
def test_unavailable_stops_with_count(...):          # TranscriberUnavailable message names episodes left
def test_redo_keeps_decisions(...):      # stale file with an accepted repair → new file keeps "accepted"
# tests/test_run.py: run_all calls repair between transcribe and chunk
# tests/test_config.py: repair_auto parsed, default False
```

- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** `run_repair`, the config key, the CLI command and the `run_all` step.
- [ ] **Step 4: Run** `uv run pytest -q && uv run ruff check .`; Expected: all pass.
- [ ] **Step 5: Commit** "pipeline: wts repair finds holes and proposes repairs; wts run runs it before chunk".

---

### Task 7: Redoing a transcription (`wts transcribe --redo`)

**Files:**
- Modify: `pipeline/src/wts/state.py` (`RESET_TARGETS` gains `Status.DOWNLOADED`), `pipeline/src/wts/steps.py` (`run_transcribe(..., redo: bool = False)`), `pipeline/src/wts/cli.py`
- Test: `tests/test_transcribe.py` (or `test_state.py`) additions

**Interfaces:**
- Produces: `wts transcribe --redo [--select …]`: selected episodes past `downloaded` (and with
  audio) are reset to `downloaded`, their transcript moved to
  `paths.data_dir / "transcripts-previous" / <stem>.json` (an existing file there is kept and the
  new one gets `.<transcribed_at>` before `.json`), then transcribed as usual. Their repairs file
  stays and becomes stale (Task 6 carries decisions over).

- [ ] **Step 1: Failing tests:** redo moves the old transcript aside and writes a new one;
  a second redo doesn't overwrite the first saved copy; episodes without audio are skipped
  with a warning.
- [ ] **Step 2: Run to see them fail.**  **Step 3: Implement.**  **Step 4: Run the suite; all pass.**
- [ ] **Step 5: Commit** "pipeline: wts transcribe --redo re-transcribes episodes, keeping the previous transcript".

---

### Task 8: Review server: repairs in the payload and a decision endpoint

**Files:**
- Modify: `pipeline/src/wts/review/data.py`, `pipeline/src/wts/review/server.py`
- Test: `tests/test_review_data.py`, `tests/test_review_server.py`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - payload key `"repairs"`: list, proposed first then by time, of
    `{"id", "status", "fails", "hole": [s, e], "from_ms", "to_ms", "before": [text…], "after": [[text, start_ms, end_ms, prob]…]}`;
    empty when the file is missing or stale
  - `POST /api/repair` `{"episode_id": int, "repair_id": str, "status": "accepted"|"rejected"|"proposed"}`
    → saves the file (under a lock), re-chunks the episode (`chunk_episode`), commits, returns
    the new episode payload; 400 bad body, 404 unknown episode or repair, 409 stale file.
    Registered with the existing write checks (token, method, content type, origin).

- [ ] **Step 1: Failing tests:** payload lists repairs in that order; accepting returns a payload
  whose words contain the repair's words and whose chunks changed; rejecting an accepted one
  removes them; unknown repair 404; stale file 409; missing token 401 (one case suffices, the
  checks are shared).
- [ ] **Step 2–4:** fail, implement, `uv run pytest -q` passes.
- [ ] **Step 5: Commit** "pipeline: the review server lists an episode's repairs and saves decisions".

---

### Task 9: Review page: repairs list and the side-by-side panel (B1)

**Files:**
- Modify: `pipeline/src/wts/review/static/index.html`, `review.js`, `review.css`
- Modify: `web/e2e/review-home.py` (the test episode gets a repairs file with one proposed repair), `web/e2e/review.spec.ts`

**Interfaces:**
- Consumes: Task 8's payload and endpoint.
- Produces (the maintainer's layout, mockup B1):
  - A "repairs:" line beside the weak spots, times as buttons, proposed ones first; decided
    ones marked (✓ accepted, ✕ rejected).
  - A `<section id="repair-panel">` above the transcript: heading "Repair N of M · m:ss–m:ss" with
    ◀ ▶; two columns "Transcript now" (12 words of context each side, the hole shown as a marked
    gap "⋯ N s ⋯" when `before` is empty, else the `before` words struck through) and "Fresh pass"
    (same context with the `after` words highlighted); a line "The rule would apply this" or
    "The rule would ask: fails 2, 5"; buttons "▶ Play", "Use fresh pass", "Keep transcript"
    (and "Undo" on a decided one, sending `proposed`).
  - Play seeks the player to 2 s before `from_ms` (or the hole start) and pauses 1 s after
    `to_ms`. Opening a repair scrolls the transcript to the stretch and highlights it.

- [ ] **Step 1: Failing e2e test** in `review.spec.ts`: the repairs line shows one time; clicking
  it opens the panel with both columns and the rule line; "Use fresh pass" sends the request and
  the transcript then contains the repair's words; "Undo" removes them.
- [ ] **Step 2: Run** `cd web && npm run e2e:review`; Expected: the new test fails.
- [ ] **Step 3: Implement** the HTML, JS and CSS.
- [ ] **Step 4: Run** `cd web && npm run e2e:review` and `cd pipeline && uv run pytest -q`; Expected: pass.
- [ ] **Step 5: Commit** "review page: repairs list and side-by-side repair panel".

---

### Task 10: The rollout audit (spike)

**Files:**
- Create: `pipeline/spikes/repair_audit.py`

**Interfaces:**
- Consumes: `cleaned_words` (Task 5), `load_repairs`, `holes.speech_between`, the
  `compare_transcripts.py` alignment idea.
- Produces: `uv run python spikes/repair_audit.py [--select scope]` printing, for episodes with a
  copy in `transcripts-previous/`: holes the detector missed (the previous transcript has ≥ 8
  words where the current cleaned-and-repaired one has ≤ a quarter as many; time and text, to
  listen to); flags per hour (from `RepairsFile.flags`); repairs proposed / accepted / rejected;
  and per rule check, how often a failed or passed check matched the maintainer's decision
  (spec §7 step 4, rule 5 called out). Read-only (state.db `mode=ro`).

- [ ] **Step 1:** Write it; check it on the committed fixtures with a hand-made previous copy
  (a scratch run, not a test: spikes have none).
- [ ] **Step 2: Commit** "pipeline: spikes/repair_audit.py reports what repair caught, missed and how the rule matched decisions".

---

### Task 11: Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` (§3.2 steps list and §3.3: the repair step, pointer to the repair spec), `docs/superpowers/specs/2026-10-26-remote-transcription-design.md` (§5: replaced, pointer), `docs/superpowers/specs/2026-10-26-transcript-repair-design.md` (§5.5: the torch ruling), `pipeline/README.md` (`wts repair`, `wts transcribe --redo`, `repair_auto`), `docs/HANDOFF.md` (the rollout steps of spec §7 as the maintainer's next steps), `CLAUDE.md` if its command list names steps.

- [ ] **Step 1:** Edit the docs.
- [ ] **Step 2: Commit** "docs: transcript repair in the main spec, README and HANDOFF".
