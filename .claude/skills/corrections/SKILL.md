---
name: corrections
description: Turn transcript mistakes the maintainer reports (misheard names, brands, woodworking terms) into safe pipeline/corrections.yaml rules and pipeline/vocab.txt entries for the Wood Talk search pipeline. Use whenever the maintainer sends transcript errors, "X should be Y", spot-check notes, or `transcript_peek.py suspects` output, or asks to add a correction or vocabulary term.
---

# Transcript corrections and vocabulary

The maintainer reports transcript mistakes; you turn each into a rule that fixes it everywhere
**without changing any correct use** of the same words, check that against real transcripts,
and commit. Read `CLAUDE.md` first (Edit tool for changes, commit straight to `main`).

## The two files

**`pipeline/corrections.yaml`** fixes existing transcripts. It is applied in `wts chunk`, so it
changes what search sees; the raw Whisper JSON is never edited.

```yaml
global:
  saw stop: SawStop            # multi-word key, one-word value
  festival tools: Festool tools  # values may have several words
  uh: ""                       # empty value deletes the word(s)
episodes:
  2026-08-05_ep612_reservations-about-shannon:   # stem: this episode only
    bob: Rob                   # e.g. a guest's name misheard in one episode
```

How rules match (`pipeline/src/wts/corrections.py`):
- Whole words only, ignoring case and punctuation: `t9` matches "T9", "T-9" and "t9,".
  A word's trailing punctuation is kept.
- Multi-word keys match consecutive words; the longest matching key wins; episode rules are
  tried before global ones.
- Matching can't see context or case, so a key must never be a word that is also used correctly.
  `mark → Marc` is the cautionary example: it fixes "Mark" for the host Marc Spagnuolo but also
  turns "the 30-second mark" and "question mark" into "Marc". Use a longer key that only occurs
  in the mistake ("festival sustainers", not "festival"), an episode-only rule, or no rule.

**`pipeline/vocab.txt`** improves *future* transcriptions only: its terms go into Whisper's
initial prompt. One term per line, `#` lines are section comments. The prompt is capped at
**150 words**; `check_corrections.py` prints its length.

Rule of thumb: a misheard name or term usually gets both — a correction for the transcripts that
exist, and a vocab entry so Whisper hears it right next time. Something Whisper can't know from
the audio (capitalisation of a store name, a brand's punctuation) only needs the correction.

## Workflow

1. **Look at the context.** The maintainer gives the wrong text, the right text and usually the
   episode and time. Read around it:
   `cd pipeline && uv run python spikes/transcript_peek.py read <episode-number> --from 6:00 --to 7:00`
   (raw Whisper text; «marked» words are low-confidence). Look for other spellings of the same
   mistake nearby ("BowShield" next to "Bow Shield").
2. **Draft the rule** and test it without editing anything:
   `uv run python spikes/check_corrections.py --try "festival sustainers: Festool Systainers"`
   It prints every sentence the rule would change, across all transcripts.
3. **Every printed change must be a fix.** If one isn't, make the key longer or more specific,
   or make it an episode rule, or drop it and say why. Also search for the key's words on their
   own to find variants the rule misses.
4. **Edit** `corrections.yaml` (group related keys, with a short comment saying which episode
   they came from) and `vocab.txt`. Run `uv run python spikes/check_corrections.py` again (it
   compares the working file with `HEAD`) and show the maintainer the full list of changed
   sentences.
5. **Test and commit**: `uv run pytest -q && uv run ruff check .`, then commit straight to
   `main` with a message listing the rules and where they came from, and push.
6. **Tell the maintainer** to apply it on the Mac: `git pull`, then `uv run wts chunk`
   (re-chunks only episodes whose text changed) and `uv run wts embed` (re-embeds only changed
   chunks).

## Where the transcripts are

- On the Mac (a local session): all of them, in `wts paths`' `transcripts_dir`. Both scripts use
  it by default. Prefer this: it catches false matches in every episode.
- In a cloud session: only the committed fixtures, the first 15 minutes of ep001 and ep610–615.
  Pass `--dir tests/fixtures/real`, and say that the check covered only those excerpts.

## Out of scope

- Editing transcript JSON files, or the fixtures in `pipeline/tests/fixtures/real/`.
- Changing how corrections work (`corrections.py`), the guards, chunking or boilerplate
  detection: those are design changes (brainstorm → spec → plan); note them for the maintainer.
- Speaker names ("Mark" vs "Marc" when it depends on who is meant): no safe global rule exists.
