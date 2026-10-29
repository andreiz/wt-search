# Boilerplate detection: design

Status: draft for the maintainer's review (2026-10-28). Replaces the binned design in the main
spec's §3.5 (`2026-10-04-wood-talk-search-design.md`) and closes `docs/full-corpus-backlog.md` §1.

## 1. Why

Every Wood Talk episode has scripted material around the conversation: the intro, sponsor
reads, show plugs, the outro. Search treats it like any other speech, so it turns up in results
where it doesn't belong. Measured 2026-10-28 on the 159 published episodes (1.65M words):

- Word runs of 8+ words that appear in 5+ episodes cover **1.37% of all words**: 1,141 runs in
  147 episodes, 417 of them 20+ words long. 250 of those long runs start in the first 3 minutes.
- In the eval's 254 searches (report `eval/reports/20261028T172350Z.json`), **51 of 2,262 top-10
  hits (2.3%)** are chunks that such runs cover by 25% or more. 7 of them are #1. About 85% are in
  Related, and intros are the worst offender. For "Festool Systainers", Related's #1, #3, #4 and
  #6 are all intros (ep177, 171, 182, 166).

The families found:

| Family | Examples | Where |
|---|---|---|
| Intros | "welcome to wood talk… now here are three guys who [a new joke each week]", "here are your hosts Marc, Shannon and Matt", "Wood Talk Online", the Weekend Show | ~110 episodes, all eras |
| Scripted sponsor reads | Woodcraft (2025–26), Rockler (2020–23) and its gift-card giveaways, Festool (2013), a hardware maker's read | |
| Show plugs | Patreon ("generous contributions of people like you"), the T-shirt store, the Frog Pants network tag (2011–14), "leave us a review on iTunes" | |
| Outros and contact info | "give them the contact info", the voicemail number, the Skype name, "woodtalkshow.com slash contact", "thanks for listening… catch you next time" | |
| Segment jingles | Tom's Tips (2008–12), "let's get to what's on the bench" | |

Scripted pieces are about 25–50 words each, and chunks are about 90 words, so most of today's
chunks that hold a read also hold real talk. That's why the old sentence-level detector with its
60%-of-a-chunk rule flagged only 2–3 chunks.

## 2. What the maintainer decided

- **Hidden unless asked.** Detected boilerplate doesn't appear in Exact or Related.
  `include:ads` brings it back in Exact (keyword search), as it already does. It's not just
  ranked lower.
- **Clean cuts.** Chunks are cut at the edges of each detected passage, so a chunk is either all
  boilerplate or none. Real talk next to a read stays searchable, and the read doesn't leak in
  with it. The maintainer accepts the cost: one re-chunk and re-embed of the whole corpus, then a
  full publish.
- **No manual flagging now.** Marking passages by hand doesn't scale to 600+ episodes. A
  "mark as ad" control in the **new-episode review flow** may come later (§7).
- **Ad-libbed reads are out of scope** for this build (§7).

## 3. Goals

1. Detect scripted, repeated material (all the families in §1) by text matching across the
   corpus, as word-level spans with a first and last word.
2. Cut chunks at those spans' edges and flag the boilerplate chunks (`is_boilerplate = 1`).
3. Hidden by default everywhere search looks. This already works once the flag is set: embed and
   publish skip flagged chunks, so Related never sees them, and the Worker's keyword SQL filters
   them unless `include:ads` is given.
4. Keep detection correct as the corpus grows from 159 to 600+ episodes, with no manual steps.
   When a new sponsor's read reaches the episode threshold, the earlier episodes that have it get
   re-cut on the next run.
5. Show boilerplate in the transcript views, marked, rather than leaving gaps (§5.4).

## 4. Non-goals and anti-goals

**Non-goals**
- Ad-libbed or paraphrased reads ("check out your local Woodcraft…", "20% off Flexcut…"). They
  don't repeat word for word.
- Ranking boilerplate lower instead of hiding it.
- Ads inserted per download. They're gone already (bot User-Agent, main spec §3.2).
- Related search with `include:ads`. Boilerplate has no vectors.

**Anti-goals** (failures even if the detector "works")
- **Hiding real content.** A host's own sentence ("I don't know about you guys but I…", "I'll put
  the link in the show notes", "you got to do what you got to do") repeats across episodes and
  must not be hidden. Neither may a listener's question that follows a "leave us a voicemail"
  line, or a tip that follows the Tom's Tips jingle. Erring toward leaving some boilerplate in is
  far better than hiding a real answer.
- **Lower recall.** The eval's recall, paraphrase recall, MRR and time hits must not drop
  (baseline 181eea7: 0.915 / 0.872 / 0.819 / 0.860).
- **Order dependence.** The old detector's result depended on which episodes were chunked first
  (code review #8). The new one must give the same spans for the same corpus, whatever the order.
- **Slow runs.** A routine run with one new episode must stay cheap on wick and walnut. Today a
  full pass over 159 episodes takes about 10 s and 850 MB with string keys, so at 600+ episodes
  it needs hashed runs or similar.

## 5. Design

### 5.1 Detection (decided)

Approach (from the Checkpoint B spike and the 2026-10-28 measurements):

1. Normalise each episode's words after guards, repairs and corrections: lower case, strip
   punctuation, keep word timings. Corrections run first, so a misheard "Wood Talk" that a rule
   fixes still matches.
2. Count, over the whole corpus of chunked episodes, how many **different episodes** contain each
   run of N consecutive words, ignoring sentence boundaries.
3. Every word covered by a run found in at least K episodes is a candidate. Consecutive
   candidate words form a span.
4. Keep only spans long enough to be scripted (minimum length M words). Merge spans separated by
   a short gap (at most G words), so a read with one misheard word, or an intro with its weekly
   joke in the middle, comes out as one span.

Starting values measured 2026-10-28: **N = 8, K = 5**. N = 6 doubles the coverage (2.88%) with
much more ordinary speech; N = 10 loses little (1.14%). K is an absolute count of episodes, not
a share, so a sponsor that ran for a year is still caught in a 600-episode corpus.

**Left to the builder, measured, not guessed:** M and G, and confirming N and K on the full
corpus. Guide: of 724 spans under 20 words, most are boilerplate ("if you want to leave us a
review on iTunes", "thanks for listening… catch you next time"), but some are ordinary speech
(see the anti-goals). The builder lists the distinct short spans with episode counts, picks
M and G so that ordinary speech isn't hidden, and records the values and the evidence in this
spec. If a few ordinary phrases still get through at a sensible M, a small never-hide list in
the pipeline's config is acceptable (builder's call). Matching the intro joke: G large enough to
bridge "three guys who [joke]. I'm Marc…", if that can be done without merging a read into the
real talk after it.

**Measured values (2026-10-28, 156 numbered episodes, `pipeline/spikes/boilerplate_report.py`):
M = 10, G = 12** (with N = 8, K = 5).

| M | G = 0 | G = 3 | G = 8 | G = 15 |
|---|---|---|---|---|
| 8 | 1,108 spans, 1.33% of words | 1.34% | 1.37% | 1.41% |
| 10 | 794 spans, 1.17% | 1.20% | 1.24% | 1.29% |
| 15 | 556 spans, 1.00% | 1.08% | 1.14% | 1.21% |
| 20 | 408 spans, 0.85% | 0.96% | 1.04% | 1.12% |

At M = 10, G = 12: 638 spans in 155 of 156 episodes, 1.28% of words.

- **M = 10.** Every distinct span of 10–19 words was scripted or a show transition ("all right,
  Shannon, what do you got going on?", "let's move into what's on the bench"). The repeats that
  are ordinary speech are all 8–9 words: "I don't know about you guys, but I" (9 episodes),
  "that's all I have to say about that" (5), "you got to do what you got to do" (5). So no
  never-hide list is needed.
- **G = 12.** Every gap of up to 12 words between two spans was inside a read or an outro (an
  aside such as "you beautiful people", "be sure to", a phone number), or the intro's weekly
  joke ("three guys who [love the smell of shellac in the morning]"). The one 15-word gap seen
  held an episode's topic preview (ep588), which shouldn't be hidden.
- **Eval check:** no `expect` passage of `eval/queries.yaml` falls inside a span.
- **Pollution measured the same way:** 58 of 2,256 top-10 hits in the 2026-10-28 report are in
  chunks these spans cover by 25% or more (7 at #1; 48 in Related).

**Tuning as the corpus grows** *(Claude's call, 2026-10-28)*: tune on the 159 episodes now and
ship. K is an absolute count, so as the archive grows toward ~625 episodes, more ordinary host
phrases will reach K. Two guards:
- Each `wts chunk` run that changes boilerplate logs the distinct span texts that are **newly**
  hidden (with episode counts), so drift shows up in the run log without anyone looking for it.
- When the full archive is in (milestone M2), re-measure M, G, N and K as in this section and
  re-tune before production.

### 5.2 Running as the corpus grows (decided in outline)

- The shared-run counts are built from **all chunked episodes on each `wts chunk` run** that has
  anything to do, so the result depends only on the corpus, never on order. (The old two-pass
  re-check is not needed: one counting pass, then each episode's spans.)
- An episode's chunks are rebuilt only if its spans or its text changed. The existing compare in
  `chunk_episode` already returns early when the rebuilt chunks equal the stored ones, so episodes
  whose boilerplate didn't change aren't re-embedded.
- The refresh trigger (today `corrections` digest + `CHUNKER_VERSION`) must also fire when a new
  episode has been chunked, since that can push a run over K. Bump `CHUNKER_VERSION` once for
  this change, which re-cuts the whole corpus.
- **Single-episode changes** *(Claude's call, 2026-10-28)*: `wts repair` and the review page's
  accept-repair flow re-chunk one episode. That episode is cut using counts over the whole
  corpus, including its own new text. Other episodes whose spans that change affects are re-cut
  by the next `wts chunk` refresh, which recounts everything. So the steady state depends only on
  the corpus, and a repair doesn't pay to re-cut and re-embed other episodes on the spot.
  `chunk_episode` therefore takes the corpus counts (or a way to get them) as an input.
- **Builder's call:** how to keep this cheap at 600+ episodes, e.g. hashed runs (64-bit) instead
  of strings, or caching each episode's run hashes in `state.db` keyed by its text digest.
  Target: a routine run with one new episode adds no more than about a minute on wick.

### 5.3 Chunking (decided)

- Span edges are hard boundaries. A span becomes one or more chunks of its own, flagged
  `is_boilerplate`. No chunk mixes span words and other words, and the one-sentence overlap
  never crosses a span edge.
- Spans are word-level, and the chunker works on sentences, so a sentence that straddles an edge
  is split at the edge.
- Real talk between spans is chunked as today: about 30 s target, 45 s maximum, overlapping by
  one sentence. **Builder's call:** what to do with a very short real-talk piece between two
  spans or at the start of an episode (keep it as a short chunk, or join it to the real talk
  beyond the nearest span), as long as it stays searchable and unflagged.
- `BOILERPLATE_SHARE` (60%) has no job once chunks never mix. The builder may remove it.
- Chunk ids stay `(episode, seq)`. Most `seq` values shift once, so nearly every chunk is
  re-embedded once. That's accepted (§2).

### 5.4 Display (decided; wording left to the builder)

- **Web app, "More transcript" and "+n more nearby":** boilerplate paragraphs are shown, muted,
  with a short label. The "Sponsor read" label of main spec §5.4, dropped 2026-10-09, comes back
  under a name that also fits intros and outros (e.g. "Intro, ad or plug").
- **Web app, no results:** the hint can mention `include:ads` again (main spec §5.5).
- **Review page:** it already greys out boilerplate paragraphs (`.para.boilerplate`), so no
  change is needed beyond checking it still renders right with the new cuts.
- `include:ads` hits in Exact may carry the same label on their card (builder's call).

### 5.5 Pipeline touch points (for orientation)

- `pipeline/src/wts/chunking.py`: `chunk_episode` passes `[False] * len(sentences)` to
  `build_chunks` today; detection replaces that. `refresh_chunks` and `chunking_inputs` hold the
  refresh trigger.
- `pipeline/src/wts/chunker.py`: `build_chunks(sentences, boilerplate, …)` takes a per-sentence
  flag today; it needs word-level spans and hard edges.
- `pipeline/src/wts/steps.py` reports boilerplate counts per run already.
- Unchanged: `embed.py`, `publish.py` (deletes vectors of chunks that become boilerplate),
  `worker/src/search.ts` (the `is_boilerplate = 0` filter), `worker/src/context.ts` (the
  `boilerplate` field), `evalset/generate.py` (samples only non-boilerplate chunks).
- `test_real_sponsor_reads_flagged` was deleted in `67e1300`. Restore it from `67e1300^` against
  the committed fixtures (`tests/fixtures/real`: ep001 and ep610–615) with its old targets: at
  least 5 episodes with boilerplate, under 15% of words flagged *(Claude's call)*. Those 7
  fixtures sit right at K = 5, so the test may need K passed in, which is fine.
- The old detector (`49963e6`) is history, not a starting point.

## 6. How we'll know it worked

1. **Pollution:** re-run the 2026-10-28 measurement (top-10 hits of the eval's searches that
   are mostly boilerplate, by an independent shared-run check). Target: close to zero, from 51 of
   2,262. The measurement script goes in `pipeline/spikes/` so it can be re-run.
2. **No harm:** `wts eval run` after the full publish. Recall, paraphrase recall, MRR and time
   hits must not drop by more than the eval's own tolerance (0.02) from the 181eea7 baseline
   *(Claude's call: re-cutting nearly every chunk moves times and ranks a little on its own)*.
   Before re-embedding, the builder checks that no eval case's expected passage falls inside a
   detected span. If one does, either the case or the detector is wrong, and the maintainer
   decides which. If the eval drops past the tolerance, list the cases that got worse and
   whether each one's expected passage is now hidden (a detector problem) or merely re-cut (a
   boundary effect). The maintainer decides whether to re-tune, accept or roll back.
3. **Negatives:** the cases whose wrong hit is a scripted read or outro (e.g.
   `stock-market-investing`, ep583 38:48) should pass. Cases about ad-libbed reads
   (`dog-training-tips` ep558 36:42, `fishing-lures-and-tackle` ep616 11:52) are expected to keep
   failing. That's the known gap, not a regression.
4. **A look by eye:** on the review page, a handful of episodes from each era (2007–10, 2011–16,
   2017–22, 2023–26) show their intro, reads and outro greyed out and nothing else.

## 7. Later, not now

- **Ad-libbed reads:** classify the remaining sponsor mentions with the local model on walnut
  (Ollama, `qwen3.6:35b`). It needs its own measurement and design.
- **Manual flags in the new-episode review flow:** a "mark as ad / not an ad" control when the
  maintainer reviews a new episode, overriding the detector for that passage.
- A new sponsor's first few episodes are searchable until its read reaches K episodes. That's
  accepted; this build's re-cut on later runs fixes them.

## 8. Rollout

1. The builder implements and tests (pipeline tests with fakes; the real-transcript test).
2. Claude runs `wts chunk` (re-cuts everything), checks spans and the eval cases (§6.2), and
   reports.
3. The maintainer runs `wts embed` on wick (GPU) and publishes to staging.
4. Claude runs the eval and the pollution measurement and reports.
5. Docs: rewrite main spec §3.5 (and the §5.4/§5.5 notes, §9's rework entry), close backlog §1,
   update `docs/HANDOFF.md`.
