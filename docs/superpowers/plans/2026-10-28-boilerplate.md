# Boilerplate Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect scripted, repeated passages (intros, sponsor reads, plugs, outros) by word runs shared across episodes, cut chunks at their edges, and flag those chunks so search hides them unless `include:ads` is given.

**Architecture:** A pure module (`wts/boilerplate.py`) turns an episode's words into hashed 8-word runs and finds spans covered by runs that 5+ episodes share. `wts chunk` caches each episode's run hashes in `state.db`, counts them across the corpus, and passes the spans to the chunker, which treats span edges as hard boundaries. Embed, publish and the Worker already honour `is_boilerplate`; the web app gets a label and a hint.

**Tech Stack:** Python 3 (`wts` pipeline, numpy, sqlite3, pytest), Preact + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-28-boilerplate-design.md` (approved 2026-10-28). Background: main spec `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §3.5, `docs/full-corpus-backlog.md` §1.

## Global Constraints

- Starting values: run length **N = 8** words, **K = 5** different episodes. K is an absolute count.
- M (minimum span words) and G (largest gap bridged) are set from measurement in Task 5, not guessed. Until then: M = 20, G = 0.
- Hidden unless asked: boilerplate chunks get `is_boilerplate = 1`; nothing else in embed, publish or the Worker changes.
- No chunk mixes span words and other words; the one-sentence overlap never crosses a span edge.
- Same corpus → same spans, whatever the order episodes were chunked in.
- A routine `wts chunk` run with one new episode adds no more than about a minute on wick.
- Erring toward leaving boilerplate in is better than hiding real talk.
- Eval gate after publish: recall, paraphrase recall, MRR and time hits within 0.02 of the 181eea7 baseline (0.915 / 0.872 / 0.819 / 0.860).
- Project rules: edit files with Edit/Write (not sed or inline scripts); commit to `main`, never push without the maintainer's approval; `state.db` opened read-only from spikes (`file:…/state.db?mode=ro&immutable=1`); `wts embed` with work and every publish are the maintainer's (Task 6 stops there).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FMTrinq9Q8NmVzwccKJHQS
  ```

## Review Focus

1. **Words whose normalised form is empty or several words** ("—", "...", "623" → "six hundred and twenty-three"): one token per word, empty ones skipped by runs but still inside a span that surrounds them, and spans index the original word list. Test in Task 1.
2. **Episodes leaving the corpus** (failed, or reset to `transcribed` by `--force`): their cached hashes must not count toward K. Test in Task 3.
3. **Idle and repeated runs:** a second `wts chunk` with nothing new must not refresh or requeue anything. Test in Task 3.
4. **Spans at the very start or end of an episode, a span inside one long sentence, an episode shorter than N words:** no crash, no empty chunk, edges still hard. Tests in Tasks 1 and 2.
5. **Order independence inside one run:** two new episodes that together push a run to K. The first one chunked must end up flagged too by the end of the same run. Test in Task 3.

---

### Task 1: Run hashes and span finding (`wts/boilerplate.py`)

**Files:**
- Create: `pipeline/src/wts/boilerplate.py`
- Test: `pipeline/tests/test_boilerplate.py`

**Interfaces:**
- Consumes: `wts.words.Word`, `wts.words.normalize_text`.
- Produces:
  - `RUN_WORDS = 8`, `MIN_EPISODES = 5`, `MIN_SPAN_WORDS = 20`, `MAX_GAP_WORDS = 0`
  - `@dataclass(frozen=True) class Params: run_words: int = RUN_WORDS; min_episodes: int = MIN_EPISODES; min_span_words: int = MIN_SPAN_WORDS; max_gap_words: int = MAX_GAP_WORDS`
  - `tokens(words: Sequence[Word]) -> list[str]`: one entry per word, `normalize_text(w.text)` with everything but `[a-z0-9']` removed (numbers come out of `normalize_text` as several words with hyphens: "623" → "six hundred and twenty-three"); `""` when nothing is left.
  - `run_hashes(toks: Sequence[str], n: int) -> np.ndarray`: the episode's distinct run hashes, `uint64`, sorted. Runs are taken over the non-empty tokens only.
  - `shared_runs(per_episode: Iterable[np.ndarray], min_episodes: int) -> np.ndarray`: sorted `uint64` hashes present in at least `min_episodes` of the arrays (each array is already distinct per episode).
  - `shared_digest(shared: np.ndarray) -> str`: sha256 hex of the sorted array's bytes.
  - `find_spans(words: Sequence[Word], shared: np.ndarray, params: Params = Params()) -> list[tuple[int, int]]`: half-open word-index ranges into `words`, sorted, non-overlapping.

Hashing, fixed so cached hashes stay valid across runs: a token's hash is `int.from_bytes(blake2b(tok.encode(), digest_size=8).digest(), "little")` (memoise per token); a run's hash is `Σ tok_hash[i+j] · P^(n−1−j)` with `P = 1_000_003`, in numpy `uint64` with wrap-around.

Spans: mark every non-empty token covered by a run whose hash is in `shared` (`np.isin`); map marks back to word indices; an empty-token word between two marked words is marked; join marked stretches whose gap is ≤ `max_gap_words`, *then* drop spans shorter than `min_span_words`.

- [ ] **Step 1: Write the failing tests**

```python
from wts.boilerplate import Params, find_spans, run_hashes, shared_digest, shared_runs, tokens
from conftest import ws

READ = "go to rockler dot com and use the code wood talk to save ten percent on your whole order today"

def eps_with(shared_text, k):
    return [run_hashes(tokens(ws(f"unique{i} words here {shared_text} tail{i} end")), 8) for i in range(k)]

def test_tokens_one_per_word():
    assert tokens(ws("Hello, — 623 Wood-Talk")) == ["hello", "", "sixhundredandtwentythree", "woodtalk"]

def test_run_hashes_stable_and_distinct():
    a = run_hashes(tokens(ws(READ + " " + READ)), 8)
    assert a.dtype == np.uint64 and list(a) == sorted(set(a.tolist()))
    assert np.array_equal(a, run_hashes(tokens(ws(READ)), 8))  # repeats collapse
    assert len(run_hashes(tokens(ws("too short")), 8)) == 0

def test_shared_runs_counts_episodes():
    assert len(shared_runs(eps_with(READ, 4), 5)) == 0
    assert len(shared_runs(eps_with(READ, 5), 5)) > 0

def test_find_spans_covers_the_read_only():
    shared = shared_runs(eps_with(READ, 5), 5)
    words = ws(f"we talked about glue {READ} and then about clamps")
    (s, e), = find_spans(words, shared, Params(min_span_words=10))
    assert " ".join(w.text for w in words[s:e]) == READ

def test_short_spans_dropped_and_gaps_bridged():
    shared = shared_runs(eps_with(READ, 5), 5)
    words = ws(f"intro {READ} joke {READ} outro")
    assert find_spans(words, shared, Params(min_span_words=40)) == []          # each piece is 20 words
    assert find_spans(words, shared, Params(min_span_words=30, max_gap_words=1)) == [(1, 42)]

def test_empty_token_inside_a_span_is_covered():
    shared = shared_runs(eps_with(READ, 5), 5)
    half = READ.split()
    words = ws(" ".join(half[:9] + ["—"] + half[9:]))
    assert find_spans(words, shared, Params(min_span_words=10)) == [(0, len(words))]

def test_span_at_episode_edges_and_short_episode():
    shared = shared_runs(eps_with(READ, 5), 5)
    assert find_spans(ws(READ), shared, Params(min_span_words=10)) == [(0, 20)]
    assert find_spans(ws("hi"), shared) == []

def test_digest_depends_on_content():
    assert shared_digest(np.array([1, 2], np.uint64)) != shared_digest(np.array([1, 3], np.uint64))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd pipeline && uv run pytest tests/test_boilerplate.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.boilerplate'`.

- [ ] **Step 3: Implement `wts/boilerplate.py`** to the interface above, with a module docstring pointing at spec 2026-10-28 §5.1.

- [ ] **Step 4: Run to verify they pass**

Run: `cd pipeline && uv run pytest tests/test_boilerplate.py -q && uv run ruff check .`
Expected: all pass, ruff clean.

- [ ] **Step 5: Commit** (`pipeline: boilerplate run hashes and span finding`).

---

### Task 2: Chunker with hard span edges

**Files:**
- Modify: `pipeline/src/wts/chunker.py` (`_units`, `_chunk`, `build_chunks`; remove `BOILERPLATE_SHARE`)
- Test: `pipeline/tests/test_chunker.py`

**Interfaces:**
- Consumes: spans as produced by `find_spans` (half-open indices into the episode's words in sentence order, i.e. `[w for s in sentences for w in s.words]`).
- Produces: `build_chunks(sentences: Sequence[Sentence], spans: Sequence[tuple[int, int]] = (), target_ms: int = TARGET_MS, max_ms: int = MAX_MS) -> list[Chunk]`. The second parameter changes from a per-sentence flag list to spans; every caller passes spans or nothing.

Approach: split each sentence at span edges (as well as at `max_ms`) into units, each flagged in-span or not; group consecutive units with the same flag into segments; run today's greedy-plus-one-sentence-overlap loop inside each segment only; `seq` runs on across segments; a chunk's `is_boilerplate` is its segment's flag. A short real-talk segment stays a short chunk of its own (Claude's call for spec §5.3: simplest, and it stays searchable).

- [ ] **Step 1: Write the failing tests** (in `tests/test_chunker.py`, building sentences with `ws` + `Sentence`):

```python
def test_no_spans_is_todays_chunking():
    # same chunks as before for an input with no spans (keep an existing case's expected output)

def test_span_becomes_its_own_flagged_chunks():
    # 3 sentences of 10 words, span covering exactly sentence 2 (words 10..20)
    chunks = build_chunks(sents, [(10, 20)])
    assert [(c.text.split()[0], c.is_boilerplate) for c in chunks] == [("a0", False), ("b0", True), ("c0", False)]

def test_sentence_straddling_an_edge_is_split():
    # one 20-word sentence, span (5, 15)
    assert [len(c.text.split()) for c in chunks] == [5, 10, 5]
    assert [c.is_boilerplate for c in chunks] == [False, True, False]

def test_overlap_never_crosses_an_edge():
    # long real talk, a span, long real talk: no word index appears in both a flagged and an unflagged chunk
    # and every chunk's word_times length equals its word count

def test_span_at_start_and_end():
    # span (0, 10) and (len-10, len): first and last chunks flagged, nothing empty

def test_long_span_splits_at_max_ms():
    # a span of 60 s of words: two or more flagged chunks, each <= MAX_MS
```

Write each body out fully; the comments say what to assert.

- [ ] **Step 2: Run to verify they fail**

Run: `cd pipeline && uv run pytest tests/test_chunker.py -q`
Expected: the new tests FAIL (wrong flags or `TypeError` on the spans argument).

- [ ] **Step 3: Implement** the approach above. Update `chunking.py`'s call to `build_chunks(sentences)` (no spans yet) so the suite still runs.

- [ ] **Step 4: Run** `cd pipeline && uv run pytest -q && uv run ruff check .` — Expected: all pass.

- [ ] **Step 5: Commit** (`pipeline: chunker cuts at boilerplate span edges`).

---

### Task 3: Corpus counts in `wts chunk` (cache, refresh, drift log, real-transcript test)

**Files:**
- Create: `pipeline/src/wts/migrations/008_run_hashes.sql`
- Modify: `pipeline/src/wts/chunking.py`, `pipeline/src/wts/steps.py` (`run_chunk`)
- Test: `pipeline/tests/test_chunking.py`, `pipeline/tests/test_state.py` (migration applies)

**Interfaces:**
- Consumes: Task 1 (`tokens`, `run_hashes`, `shared_runs`, `shared_digest`, `find_spans`, `Params`), Task 2 (`build_chunks(sentences, spans)`).
- Produces (in `wts.chunking`):
  - `CHUNKER_VERSION = 3`
  - `store_run_hashes(conn, episode_id: int, hashes: np.ndarray, n: int) -> None`
  - `corpus_shared_runs(conn, params: Params = Params(), *, include: int | None = None) -> np.ndarray`: counts the cached hashes of episodes in `chunked`/`embedded`/`published`, plus episode `include` whatever its status, and only rows whose `n == params.run_words`.
  - `index_episode(conn, row, corrections) -> None`: prepare the episode and store its run hashes, without touching chunks.
  - `chunk_episode(conn, row, corrections, shared: np.ndarray | None = None) -> bool`: stores the episode's run hashes, then cuts it against `shared` (when `None`: `corpus_shared_runs(conn, include=row["id"])`). Return value and requeue behaviour unchanged.
  - `refresh_chunks(conn, corrections, *, rehash: bool) -> int`: when `rehash`, `index_episode` for every chunked/embedded/published episode first; then one `corpus_shared_runs`, and `chunk_episode(..., shared=that)` for each. Returns how many changed.
  - `boilerplate_texts(conn) -> Counter[str]`: `normalize_text` of each flagged chunk's text → number of distinct episodes.
- The review server and `run_repair` keep calling `chunk_episode(conn, row, rules)` unchanged (spec §5.2: one episode is cut against the whole corpus; others wait for the next refresh).

`008_run_hashes.sql`:
```sql
-- Each chunked episode's distinct 8-word run hashes (boilerplate spec 2026-10-28 §5.2), written by
-- `wts chunk` from the same words it chunks, so the corpus can be counted without re-reading
-- every transcript.
CREATE TABLE run_hashes (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    hashes BLOB NOT NULL
);
```

`run_chunk` order: snapshot `boilerplate_texts`; chunk the new episodes as today; then
- inputs changed (`chunking_inputs`, unchanged mechanism) → `refresh_chunks(rehash=True)`;
- else, if `shared_digest(corpus_shared_runs(conn))` differs from kv `boilerplate_shared_sha` → `refresh_chunks(rehash=False)`;
- store the digest under `boilerplate_shared_sha`; log each newly hidden text (in the after-snapshot, not the before) as `newly hidden: "<first 80 chars>" (<n> episodes)`, at most 20 lines, most episodes first; set `counts["newly_hidden"]`.

- [ ] **Step 1: Write the failing tests** in `tests/test_chunking.py`, replacing `test_no_chunk_is_boilerplate_even_when_five_episodes_share_a_passage` and `bp == 0` in `test_chunk_reports_chunks_and_flags`, and rewriting `test_new_episodes_alone_do_not_trigger_a_refresh` for the new trigger:

```python
def test_five_episodes_sharing_a_read_get_it_flagged(conn, paths, cfg, episodes_with_ad):
    run_chunk(conn, paths, cfg, episodes_with_ad)
    for e in episodes_with_ad:
        flagged = [t for t, bp in conn.execute("select text, is_boilerplate from chunks where episode_id=?", (e,)) if bp]
        assert flagged and "rockler" in " ".join(flagged)
        assert all("q" not in t for t in flagged)   # the unique sentences stay unflagged

def test_four_episodes_are_not_enough(conn, paths, cfg, make_episodes):
    # AD_BLOCK in 4 episodes: no flagged chunk

def test_order_independent_within_a_run(conn, paths, cfg, make_episodes):
    # 4 episodes with AD_BLOCK chunked in one run; then a 5th in a second run:
    # after the second run all 5 have the read flagged, and the first 4 went back to `chunked`
    # only if they had been embedded (force_status embedded before the second run, assert chunked)

def test_failed_or_reset_episode_does_not_count(conn, paths, cfg, episodes_with_ad):
    run_chunk(conn, paths, cfg, episodes_with_ad)
    fail(conn, episodes_with_ad[0], "chunk", "x")      # or force_status(..., "transcribed")
    run_chunk(conn, paths, cfg, [])
    assert boilerplate_chunk_count(conn, episodes_with_ad[1]) == 0   # only 4 left

def test_idle_run_refreshes_and_requeues_nothing(conn, paths, cfg, episodes_with_ad, refreshes):
    run_chunk(conn, paths, cfg, episodes_with_ad)
    for e in episodes_with_ad: force_status(conn, e, "published")
    n = len(refreshes)
    run_chunk(conn, paths, cfg, [])
    assert len(refreshes) == n and all(status_of(conn, e) == "published" for e in episodes_with_ad)

def test_newly_hidden_text_is_logged(conn, paths, cfg, episodes_with_ad, wts_messages):
    counts = run_chunk(conn, paths, cfg, episodes_with_ad)
    assert counts["newly_hidden"] >= 1
    assert any(m.startswith('newly hidden: "this episode is brought to you by rockler') for m in wts_messages)

def test_single_episode_rechunk_uses_corpus_counts(conn, paths, cfg, episodes_with_ad):
    # run_chunk the 5; then chunk_episode(conn, row, []) for one of them: still flagged

def test_real_sponsor_reads_flagged(conn, paths, cfg, make_episodes, real_transcripts):
    # restored from 67e1300^ (body as there, no xfail mark):
    assert with_bp >= min(5, len(ids))
    assert bp_words < 0.15 * total_words
```

In `tests/test_state.py`: a fresh `state.db` has a `run_hashes` table.

- [ ] **Step 2: Run to verify they fail**

Run: `cd pipeline && uv run pytest tests/test_chunking.py tests/test_state.py -q`
Expected: the new tests FAIL (nothing flagged; no `run_hashes` table).

- [ ] **Step 3: Implement** the migration, the `chunking.py` functions and the `run_chunk` order above. Update the module docstrings (`chunking.py` no longer says detection is off). If the real-transcript test misses at M = 20, pass a `Params` to make it hold *only if* that value is what Task 5 will start from; otherwise record a `Ruling:`.

- [ ] **Step 4: Run** `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass. Also `uv run pytest tests/test_review_server.py tests/test_repair_step.py -q` pass unchanged.

- [ ] **Step 5: Commit** (`pipeline: wts chunk detects boilerplate across the corpus`).

---

### Task 4: Web app label and `include:ads` hint

**Files:**
- Modify: `web/src/components/Transcript.tsx` (`Passage`; the header comment's "A sponsor read is a paragraph like any other" line), `web/src/components/EmptyState.tsx` (`NoResults`, Exact branch), `web/src/components/SyntaxHelp.tsx` (`ROWS`), `web/src/styles/components.css`
- Test: `web/test/transcript.test.tsx`, `web/test/states.test.tsx`

**Interfaces:**
- Consumes: `ContextChunk.boilerplate: boolean` (already in `worker/src/api-types.ts`).
- Produces: nothing other tasks use.

Copy (Claude's call for spec §5.4's wording):
- Passage tag: **`Intro, ad or plug`**, using the existing `.passage__tag` element; the `<li>` also gets `passage--boilerplate` (muted text via the existing muted colour token, as `.para.boilerplate` does on the review page). A folded hit's "Nearby match" tag wins if both apply.
- `NoResults`, Exact, after the existing tip: **`Intros, sponsor reads and plugs are left out; add include:ads to search them too.`**
- `SyntaxHelp` row: `{ examples: ["include:ads"], finds: "intros, sponsor reads and plugs too" }`, last.

- [ ] **Step 1: Write the failing tests**: a context chunk with `boilerplate: true` renders the tag text and class, and one with `false` doesn't; Exact `NoResults` shows the include:ads sentence and Related doesn't; the tips dialog lists `include:ads`.
- [ ] **Step 2: Run** `cd web && npx vitest run test/transcript.test.tsx test/states.test.tsx` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the copy and styles above.
- [ ] **Step 4: Run** `cd web && npm test && npm run typecheck` — Expected: all pass. Then `npm run e2e:shots` and look at the expanded-transcript captures in light and dark if any state shows a boilerplate chunk (they may not; no new fixture needed).
- [ ] **Step 5: Commit** (`web: label boilerplate passages; mention include:ads`).

---

### Task 5: Tune M and G on the real corpus; measurement tools

**Files:**
- Create: `pipeline/spikes/boilerplate_report.py`
- Modify: `pipeline/src/wts/boilerplate.py` (`MIN_SPAN_WORDS`, `MAX_GAP_WORDS`, and a `NEVER_HIDE` tuple only if needed), `docs/superpowers/specs/2026-10-28-boilerplate-design.md` §5.1 (record the values and evidence)

`boilerplate_report.py` (read-only on `state.db`; uses `wts.chunking.prepare_episode` and `wts.boilerplate`, not the cache) has three subcommands:
- `spans [--min-words M] [--max-gap G]`: every distinct span text with its episode count and length, shortest first, plus totals (spans, episodes with any, share of words).
- `eval [REPORT]`: for each `eval/queries.yaml` case with `expect`, whether the expected moment (±45 s) falls inside a detected span; for `expect_absent`, whether the named wrong hit does.
- `pollution REPORT`: the 2026-10-28 measurement: top-10 hits of an eval report (`eval/reports/*.json`) in chunks that spans cover by ≥ 25%, by mode and how many at #1. It works from spans computed from transcripts, independent of the stored flags.

- [ ] **Step 1: Write the script and run** `cd pipeline && uv run python spikes/boilerplate_report.py pollution ../eval/reports/20261028T172350Z.json --min-words 12` — Expected: about 51 of 2,262 (the 2026-10-28 numbers; small differences from the threshold are fine, note them).
- [ ] **Step 2: Measure.** Run `spans` for M in {8, 10, 12, 15, 20} and G in {0, 3, 8, 15}. Read the short spans and the intros. Pick the smallest M and the largest G for which no listed span is ordinary speech (the spec's anti-goal examples are the test), the intro's weekly joke is bridged where possible, and no span runs into real talk. If one or two ordinary phrases survive at a good M, add them to `NEVER_HIDE` (normalised text; a span equal to one isn't hidden) with a unit test in `tests/test_boilerplate.py`.
- [ ] **Step 3: Check the eval cases.** Run `eval` with the chosen values. Expected: no `expect` passage inside a span. If one is, stop and ask the maintainer whether the case or the detector is wrong (spec §6.2).
- [ ] **Step 4: Record.** Set the constants, write the values, the table of what each M/G hid and the reasoning into spec §5.1, and run `cd pipeline && uv run pytest -q`.
- [ ] **Step 5: Commit** (`boilerplate: tune span length and gap on 159 episodes; report spike`).

---

### Task 6: Re-cut the corpus (stops for the maintainer)

- [ ] **Step 0:** Ask the maintainer to run `uv run wts backup` (the NAS isn't reachable from Claude's sandbox) and wait for it. A safety net only: transcripts aren't touched, chunks rebuild from them, and the embedding cache is keyed by text and never pruned, so a rollback (revert, `wts chunk`, `wts embed`) reuses the old vectors.
- [ ] **Step 1:** `cd pipeline && uv run wts chunk`. Expected: a refresh of every episode (CHUNKER_VERSION 3), `newly hidden:` lines that are all scripted material, most episodes back to `chunked`. Note the run time.
- [ ] **Step 2:** Time a routine run: `uv run wts chunk` again. Expected: nothing to do, no refresh, well under a minute.
- [ ] **Step 3:** Spot-check one episode per era on the review page's data (`uv run wts review <n>` or the chunks table): ep 1–100 (2007–10), 150–300, 400–500, 600+.
- [ ] **Step 4: Stop.** Tell the maintainer: run `uv run wts embed` on wick, then publish to staging. Wait.

### Task 7: Measure after publish; docs

**Files:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` (§3.2 `wts chunk` row, §3.5 rewritten to point at the new spec, §5.4 and §5.5 notes, §9's rework entry, §11's state-size line), `docs/full-corpus-backlog.md` §1 (closed, pointing at the spec), `docs/HANDOFF.md`, `eval/baseline.json` if the maintainer accepts the new numbers.

- [ ] **Step 1:** `cd pipeline && uv run wts eval run` (background, ~12 min). Expected: within 0.02 of baseline on all four scores. If not: list cases that got worse, each marked hidden or re-cut (Task 5's `eval` subcommand on the new report), and stop for the maintainer.
- [ ] **Step 2:** `uv run python spikes/boilerplate_report.py pollution <new report>`. Expected: close to zero, from 51.
- [ ] **Step 3:** Update the docs listed above with what was measured. The handoff's next steps gain: re-measure M, G, N and K with Task 5's script once the full archive is in (milestone M2), before production (spec §5.1).
- [ ] **Step 4: Commit** (`docs: boilerplate detection shipped; eval and pollution after`). Ask before pushing.
