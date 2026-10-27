# Transcript repair: finding and filling Whisper's skipped passages

Status: draft for review, 2026-10-26. Extends the main spec
(`2026-10-04-wood-talk-search-design.md`, §3.2–3.3) and replaces §5 of
`2026-10-26-remote-transcription-design.md`.

## 1. Why

Whisper sometimes skips a passage: it writes a short phrase, loses its place and carries on
seconds later, so the words in between never reach search. It happens on both machines and on
ordinary audio:

| Episode | What went missing | Machine |
|---|---|---|
| ep071 1:11:41 | 79-word listener tip ("It's been said you can never have enough clamps…"); walnut wrote "Tom's Tips. Tom's Tips." over it | walnut |
| ep300 33:31 | 22 words ("any sort of serious risk about the boiled linseed oil…") | wick |
| ep300 26:07, 33:55 | 13 and 11 words | wick |
| ep071 1:01:30 | 12 words ("…I pick up my Lee Nielsen's and") | wick |

The maintainer listened to each and confirmed the words are spoken. Nothing in the pipeline
catches this today: the guards (main spec §3.3) cut loops and made-up endings, and `wpm_low`
looks at the whole episode, where a 30-second hole barely moves the rate.

The goal: find these holes, re-transcribe just that stretch, and put the missing words into
search, with the maintainer approving repairs until an automatic rule has earned their trust.

## 2. What we learned getting here (2026-10-26)

These findings shape the design; the evidence is in the session's comparison runs
(`pipeline/spikes/compare_transcripts.py`).

- **walnut and wick never match exactly, and that's fine.** With identical software
  (`mlx-whisper` 0.4.3, `mlx`/`mlx-metal` 0.32.3, `numpy` 2.5.3, Python 3.13), each machine
  repeats itself on clear audio (wick exactly; walnut to 99.9% of words), but the two differ
  from each other: different GPU (M5 Pro vs M1 Max) and macOS (27 vs 15.7). The differences are
  crosstalk fragments (each side keeps a different speaker), occasional mishearings of names
  (vocabulary, handled by corrections), and skipped passages, on both sides. The maintainer
  judged walnut as good as wick.
- **Random retries.** When Whisper is unsure of a 30-second window it retries at a higher
  temperature with unseeded random sampling, so runs differ wherever that happens. Episodes
  with background music (ep616, recorded live with music) trigger it constantly.
- **Holes can be detected from one transcript plus the audio.** A throwaway test over 5.1 h
  (ep001, ep071, ep300; both machines) compared two detectors against the 5 known holes:

  | Detector | Threshold | Holes caught | Other flags |
  |---|---|---|---|
  | words only (time no word covers) | 2 s | 4/5 | 4.3/h |
  | speech without words (Silero VAD) | 1.5 s | 4/5 | 4.7/h |
  | speech without words | 2 s | 4/5 | 1.2/h |
  | either | 3 s | 2/5 | ~0.2/h |

  The one it can't catch (ep071 1:01:30) leaves no timing trace: Whisper squeezed the
  neighbouring words together. Holes like that are out of reach of this design (§4).
  A word counts as covering at most 1 s plus 0.3 s after it; without that cap, Whisper hides
  holes by stretching one word across them.

### §5 of the remote-transcription spec, replaced

The exact-match check (99% words, ±2% segments) cannot pass between two different Macs and is
dropped. walnut is accepted as equivalent to wick on the maintainer's listening (above).
Quality is guarded instead by this repair step and its audit (§7).

## 3. Goals

- Find stretches where someone is speaking but the transcript has no words, re-transcribe them,
  and propose the missing words as a repair.
- Show each proposed repair on the review page, side by side with the current text, with the
  audio, for the maintainer to accept or reject.
- Accepted repairs reach search through `wts chunk`; Whisper's raw JSON is never edited.
- Record, for every repair, what an automatic rule would have decided, so the rule can be
  checked against the maintainer's decisions and later switched on.
- A rollout that re-transcribes the 36 in-scope episodes on walnut, repairs them, and audits
  what is left against wick's old transcripts.

## 4. Non-goals and anti-goals

**Not in this work:**
- Two full transcripts of every episode, merged. One transcript plus targeted repairs.
- Holes that leave no timing trace (squeezed words, as at ep071 1:01:30).
- Crosstalk: which speaker Whisper writes down when two talk at once. The maintainer judged
  these harmless.
- Removing background music before transcription (ep616-style episodes). Possible later.
- Name mishearings: those are corrections and vocabulary, as today.

**Failure even if it works:**
- Invented words in search. A repair that puts words in that weren't spoken is worse than the
  hole. Until the automatic rule is switched on, nothing goes in without the maintainer's yes.
- Losing Whisper's original output. Repairs live beside it.
- A slow backlog: repair should add seconds to a minute per episode, not minutes.

## 5. How it works

### 5.1 Finding holes

For each transcribed episode, on its words after the guards (as `wts chunk` produces them,
before corrections):

1. Speech: run Silero VAD over the audio (16 kHz mono) on wick's CPU.
2. Covered time: each word covers from its start to `min(end, start + 1.0 s) + 0.3 s`.
3. A flag is speech that no word covers, at least **1.5 s** long, between the first and last
   word of the episode. Flags within 5 s of each other are one flag.

The 1.5 s threshold is a starting value. False alarms are cheap (§5.2 drops them), so it errs
low; the rollout (§7) checks it.

### 5.2 Making a repair

For each flag:

1. Cut a clip from about 10 s before the flag to 10 s after it.
2. Transcribe the clip fresh: the vocabulary prompt only (as `wts transcribe` builds it), none of
   the episode's earlier text. On walnut when `transcribe_url` is set (the existing upload route;
   no server change), else on this Mac.
3. Shift the clip's word times by the clip's start and line its words up with the transcript's
   words in the same span (word alignment, as `compare_transcripts.py` does).
4. If the fresh pass has words where the transcript has none (or far fewer), that is a proposed
   repair: the transcript's words in the stretch are replaced by the fresh pass's, between the
   last matching word before and the first after. If it adds nothing, the flag is dropped
   silently.
5. Second pass, for the automatic rule: transcribe the clip again on the same transcriber,
   starting 5 s earlier, so Whisper starts from a different context. (Not on wick's GPU: the
   non-GPU pipeline is meant to move to Linux later, §5.6.)

### 5.3 The automatic rule (recorded; applied only when switched on)

A repair is clear-cut only if all hold; otherwise it is for the maintainer:

1. **It fits:** at least 5 matching words on each side of the new stretch.
2. **It fills the speech:** new words ÷ seconds of uncovered speech between 1.5 and 4.5.
3. **Whisper was confident:** most new words at probability ≥ 0.5 (the review page's "unsure"
   line); the exact share is the builder's to set and the rollout's to check.
4. **It doesn't look made up:** no repeated phrase loop (the guards' loop test), the new text
   doesn't repeat a neighbouring sentence, and no known stock phrase ("Thanks for watching").
5. **Two passes agree:** the second pass's new words are essentially the same as the first's.

Each repair stores the rule's verdict and which checks failed. A config setting turns automatic
application on; it is **off** by default and stays off through the rollout.

### 5.4 Where repairs live

A file per episode, `<data>/repairs/<stem>.json`, in a folder beside `transcripts_dir`, not in it
*(changed during implementation, 2026-10-26: as `<stem>.repairs.json` inside `transcripts/`, it
was taken for a transcript by everything that reads every `.json` there, and the corrections
preview failed on it)*. Per repair: the flag's
span, the clip span, the current words, both passes' words, the proposed replacement, the
rule's verdict and reasons, a status: `proposed`, `accepted`, `rejected`, or `auto` (applied
by the rule), and the machine that heard the fresh pass (`walnut`, or this Mac's name with
`--local`; added 2026-10-27, missing in older files; the review panel's "Fresh pass" heading
shows it). Corrections apply to the words accepted repairs put in, and the corrections preview
sees them too (2026-10-27). The file names the transcript it was made from (its `transcribed_at` or a hash);
if the transcript is replaced, its repairs are stale and are made again (decisions carry over
as below).

`wts chunk` applies `accepted` and `auto` repairs to the words after the guards and before
corrections, and re-chunks an episode when its repairs change, the same way a new correction
rule does. (My call: the guards work on Whisper's segments and drop whole ones, so repairs are
spliced into the cleaned words, where they can't be dropped again by a guard; rule 4 does the
made-up-text check for them instead.) For the same reason, holes are found in the cleaned words
(§5.1): a spoken segment a guard dropped is a hole too. The review page's "Transcript now"
column shows the cleaned words, as the page does today.

If an episode is re-transcribed, a decision carries over to a new repair when the spans overlap
and the proposed words are the same; anything else is proposed again. (My call: redoing the 36
once is fine, re-reviewing after every redo is not.)

### 5.5 Running it

A new step, `wts repair [--select …]`, finds holes and makes repairs for episodes that are
transcribed and have no up-to-date repairs file. `wts run` runs it after `transcribe` and before
`chunk`. walnut being unreachable stops the step the same way it stops `transcribe`
(`TranscriberUnavailable`, episodes keep their retries). Whether it gets its own episode status
or runs beside the status machine (as corrections do) is the builder's call.

Undecided repairs never hold an episode back (maintainer's decision, 2026-10-26): it is chunked,
embedded and published as transcribed, and an accepted repair reaches search at the next run
that re-chunks it. This holds for the rollout's 36 and for the backlog. Search is never worse
than a plain transcript, and nothing waits on the review queue.

`silero-vad` becomes a pipeline dependency, and with it CPU `torch` in the core dependencies
(before, `torch` came only with the `mac` extra): repair has to run on the later Linux runner
too. *(Corrected during implementation, 2026-10-26.)*

### 5.6 Which machine does what

walnut takes over transcription (`transcribe_url` set); wick's old transcripts are kept only for
the rollout's audit (§7).

| Job | Machine |
|---|---|
| Full episode transcription | walnut |
| Finding holes (VAD on the audio) | wick's CPU, with the rest of the pipeline (later Linux) |
| Fresh pass on each flagged clip | walnut, through the existing upload route |
| Second pass, for rule 5 | walnut, clip starting 5 s earlier |
| Chunk, embed, publish | wick, as now |

With `--local-transcribe` (walnut down), wick does all of it.

Nothing in the repair step needs a Mac GPU except through the transcriber, so it can move with
the rest of the non-GPU pipeline to Linux later (the planned Docker deployment from Forgejo,
transcription staying native on walnut). VAD runs on CPU.

### 5.7 The review page

The maintainer chose this layout (mockup "B1", 2026-10-26):

- The header lists the episode's repairs next to the weak spots, by time, proposed ones first.
- Clicking one opens a panel **above the transcript** (like today's report panel): two columns,
  "Transcript now" (the hole shown as a marked gap with its length) and "Fresh pass" (the new
  words highlighted), a play button for the stretch, and **Use fresh pass** / **Keep transcript**.
  ◀ ▶ steps through the episode's repairs. The transcript below scrolls to the stretch and
  highlights it.
- The panel also shows the rule's verdict ("the rule would apply this" or "would ask: fails 2,
  5"), so decisions and verdicts can be compared.
- A decision is saved to the repairs file through a new write endpoint (same checks as the
  existing ones). As with a correction made on the page, search changes after `wts chunk`.
- Dropped flags are not shown.
- `wts review --next-repair` opens the newest episode with an undecided repair in a current
  repairs file, with that repair's panel open; run again, it moves on as decisions are made.
  `--at` on a repair (from 2 s before its hole to the hole's end) opens it the same way; any
  other time only moves the player (added 2026-10-27, the maintainer's request).

## 6. Constraints

- Whisper's raw JSON is never edited (main spec §3.2).
- No new secrets; no change to transcribe-web (the clip uses the existing upload route).
- Tests run on Linux with ML faked, as now; VAD and Whisper behind the same kind of seam as
  `Transcriber`.
- state.db is read-only to everything but the pipeline's own steps.

## 7. Rollout

1. Keep wick's transcripts of the 36 in-scope episodes: copy them aside (e.g.
   `transcripts-wick/`) before anything overwrites them.
2. Re-transcribe the 36 on walnut with today's vocabulary. This needs a way to redo an episode's
   transcription (today a transcribed episode is never transcribed again); its form is the
   builder's call.
3. `wts repair` on the 36; the maintainer reviews every repair on the page.
4. Audit: compare walnut's repaired transcripts with wick's old ones. Wherever wick has 8 or
   more words walnut lacks, that is a hole the detector missed; list them with times to listen
   to. Report holes caught vs missed, flags per hour, and how often the rule's verdict matched
   the maintainer's decision, check by check. Rule 5 especially: two passes on the same machine
   are less independent than two machines, and may agree on the same mistake; if its agreement
   doesn't track the maintainer's decisions, it is dropped or weakened.
5. With the maintainer: keep or change the threshold and the rule; switch automatic application
   on only if the rule matched their decisions.
6. Then the quarter: `wts scope add spread:N` and the backlog run, with repair in it.

After step 3, rerun the search eval for a new baseline (HANDOFF): the 36 episodes' text changes.

## 8. Left to the builder

- The exact clip padding, alignment details and the confidence share in rule 3.
- How "redo transcription" is exposed, and whether repair has its own episode status.
- The repairs file's exact fields, and how the review page's existing code is extended.
- Where the audit lives (a spike script is fine).
