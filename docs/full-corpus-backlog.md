# Full-corpus backlog

Things to test and iterate on once the full archive (~625 episodes, ~72k chunks) is transcribed
and published (M2), because the 36-episode seed is too small to judge them. Each entry says what
we know, where the details live and what to try first. Started 2026-10-09 (maintainer); add to it
rather than leaving "on the archive" notes scattered through the handoff.

## 1. Boilerplate (sponsor reads, plugs, intros, inserted ads) — binned 2026-10-09

**State:** detection was **removed** from the pipeline (maintainer, 2026-10-09). The plumbing
stays, so a new detector only has to set the flag:
- `chunks.is_boilerplate` in `state.db` and D1 (always 0 now); `chunker.py`'s 60%-of-words rule
  that turns flagged sentences into a flagged chunk.
- `wts embed` and `wts publish` skip flagged chunks (no vector); `wts publish` deletes the vector
  of a chunk that becomes flagged.
- The Worker's `include:ads` (`is_boilerplate = 0` unless given) and `/api/context`'s
  `boilerplate` field. The web app doesn't mention either while nothing is flagged.
- The chunk step's refresh trigger includes `CHUNKER_VERSION` (`pipeline/src/wts/chunking.py`):
  a new detector bumps it, and the next run re-chunks everything once.

**Why it was binned:** the MinHash/LSH sentence matcher (spec §3.5 as first built: word-set
Jaccard ≥ 0.8 across ≥ 5 episodes, sentences of 6+ words) flagged **2–3 of 4,210 chunks** on the
seed and missed the sponsor reads it was for:
1. Whisper punctuates the same read differently per episode, so sentence word-set similarity
   falls to ~0.6.
2. Reads come in short pieces between live host talk, so a 30 s chunk is only 25–40% read,
   under the 60% rule.

Its re-check of every earlier episode on each new one was also order-dependent (code review
`docs/code-review-d15ec6e.md` #8: a fix needed two reads of every transcript per run), a cost
with no benefit while it found nothing.

**What looked promising (Checkpoint B, 2026-10-05):** runs of 6–8 words shared by ≥ 5 episodes,
ignoring sentence boundaries, found the Woodcraft read and the merch-code plug in all 6 of
ep610–615 (`pipeline/spikes/`; the handoff's "Plan 1 results"). Pair it with cutting chunks at
boilerplate edges, so a read becomes its own flagged chunk.

**To decide with the full corpus:**
- Is hiding reads worth it at all? Measure first: how much of the archive is reads, and how
  often a search's top 10 is polluted by them (plan 5's `negative` test cases, spec §7.2).
- n-gram length and episode threshold; how reads drift across sponsors and years (2007–2013
  have no sting; sponsors change).
- Ads inserted per download are gone (bot User-Agent, spec §3.2), so only the show's own reads
  matter.
- Cutting chunks at read edges changes chunk boundaries → re-chunk and re-embed the corpus, so
  it needs its own brainstorm, spec and plan (spec §9).
- Ad-libbed host reads won't match any text rule; a local LLM classifier is the fallback idea.
- Restoring the old detector: it was removed in `8988c73`/`67e1300`; `49963e6` (the last
  commit with it) has `boilerplate.py`, `test_boilerplate.py`, the fingerprint
  tables (`bp_sentences`, `bp_bands`, dropped by state migration 006) and the two-pass
  refresh.

## 2. Search relevance (plan 5's test search set, scored on the archive)

From the handoff's Task 14 notes; try in this order:
1. bge's query instruction (`Represent this sentence for searching relevant passages: `), for
   short and question-form queries ("how do I…" pulls in Q&A answers by tone).
2. Keyword-weighted RRF.
3. Fewer vector hits (topK 50 → 20–30).
4. An absolute similarity floor (~0.6) for `related` hits: right for `hvlp sprayer year:2020`
   (all padding at 0.52–0.59), wrong for the bench-top case (off-topic hits at 0.66–0.73). Tune
   on the set; short and acronym queries may score low overall.
5. Smaller chunks, only if all else fails.

"Why is this related?" (the design's open item, 2026-10-09): a short per-card reason ("about
turbine sprayers") needs a backend that can say why; decide after the tuning above.

Judgements already noted: #127 at 44:28 and #171's miter answer are non-relevant for the
bench-top queries; the `collapse` tag for `more_in_episode` cases.

## 3. Text and matching

- Porter stemming treats glue/glued/gluing as different words (`glu*` works): measure before
  changing anything.
- Fractions heard as `3-8` could become `3/8` (like the split-number join in `wts chunk`).
- `ep:` in smart mode only filters the corpus-wide top 50 (Vectorize indexes `year`, not
  `episode_id`); add a metadata index if the set shows a need.
- `bad_word_times`: words Whisper invents after the audio ends (spec §3.3 guard tweak, needs
  the maintainer's OK).

## 4. Cost and limits at archive size

- D1 rows read: a common word (`wood`, ~10,800 matches on the archive) reads ~35k rows per
  uncached search. If it matters: rank on `chunks_fts` alone in a subquery and join only the
  page's rows (handoff, Checkpoint F).
- Workers Paid is needed for the archive: Vectorize storage (~55–69M dims) and D1 rows written
  by a full re-chunk (~400–700k).
- Measure p95 latency (spec §1, ≤ 800 ms) and the smart-search budget against real traffic.

## 5. Coverage

- Apple IDs reach back only to 2017-10 (the lookup's newest-200 limit): an M2 fallback for
  older episodes.
- YouTube: 89 of 625 matched, 55 within the 3 s rule; recheck after the archive's feed refresh.

## 6. Topics (spec §9, phase 2) — spiked 2026-10-28, parked until boilerplate ships

**What the maintainer wants:** both a per-episode "topics discussed" list and "every place a
subject came up", across episodes too. A topic is not a table-of-contents entry: "cutting
dovetails" can come up in the first and last ten minutes, so a topic has several times.

**Spike** (throwaway scripts, not in the repo; qwen3.6:35b on walnut; ep71, 171, 466, 602):
1. **Tag each ~3 min window** (6 chunks) with 0–4 subject names. About 30 s per episode in all
   (≈ 5 h for 625 episodes). The tags are specific and in the hosts' terms ("horse stall
   mats", "lever mortise chisels", "reinforcing miters with splines", "Derek Cohen Jackrabbit
   plane") and land where the talk is. This is the layer to keep.
2. **Model merge of an episode's tags into topics: too coarse.** Some good ("Chisel Types and
   Selection" @ 44:36, 47:12, 50:02; ep466's outdoor finishing at 9 times), but it invents
   catch-alls ("Project Design and Construction", "Miscellaneous Projects") and loses detail.
3. **Merge by embedding (bge-base, complete linkage on cosine):** 0.78 makes few wrong groups
   but leaves some subjects split ("SketchUp software" / "SketchUp for woodworking"; "Glendrake"
   / "Glen Drake"). 0.72 joins the big subjects fully but makes wrong groups ("baseboard
   miters" + "woodworking education during injury", "Windsor chair making" + "CNC
   reproduction"). Across the four episodes it found real shared subjects ("finishing outdoor
   furniture" in ep171 and ep466, "learning SketchUp" in ep71 and ep171) and some false ones
   ("dovetail chisels" + "dovetail saws").

**Problems seen:** the intro's topic preview ("this week: chisels and mats") counts as a
mention at 0:03; times are only as fine as the window; misheard words get through
("Amazoniko wood", ep602 27:39).

**Suggested design to brainstorm:** window tags (1) → loose embedding groups (~0.72) as
candidates → the model checks each small group (same subject? split, and name it) → drop tags
from the intro's preview; snap times to chunk starts. Run after boilerplate, so ads and
intros are never tagged. Open: where topics show (the site has no episode page), and whether
topic search helps short-query misses (eval `classic-video-games`).
