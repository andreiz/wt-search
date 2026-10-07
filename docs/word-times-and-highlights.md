# Word times, highlights and cue times

How a search hit becomes "play from 20:28". This covers the data the pipeline stores, what
FTS5 gives back, and how the Worker joins the two (plan 2 Task 12; spec §4.1, §4.5, §4.6).

## The problem

A chunk is about 30 s of speech. Cueing a player at the chunk's start can land up to 30 s
before the word the listener searched for. So every chunk also stores when each of its words
starts, and the Worker cues from the word that matched.

## `word_times`: one start time per word

`chunks.word_times` holds the start of every word in the chunk, in milliseconds, as
comma-separated **deltas**. The first delta is measured from the chunk's `start_ms`, each
later one from the previous word. Deltas are short numbers, so the column costs about 50 MB
across the whole archive instead of several times that for absolute times.

```
start_ms   = 1234567
text       = "So we glued up the SawStop, fence"
word_times = "0,233,210,390,120,180,600"

word      So       we       glued    up       the      SawStop,  fence
delta     0        233      210      390      120      180       600
start_ms  1234567  1234800  1235010  1235400  1235520  1235700   1236300
```

- The first delta is normally 0, because a chunk starts at its first word.
- A delta can be negative in principle (Whisper's word times aren't guaranteed to be
  monotonic), so decoders accept a sign.
- The codec is `encode_word_times` / `decode_word_times` in `pipeline/src/wts/chunker.py`
  and `decodeWordTimes` in `worker/src/wordtimes.ts`. Both are tested against the same
  fixture, `worker/test/fixtures/word_times.json`, so the two halves can't drift apart.
- The Worker's decoder never throws. Malformed `word_times` decodes to nothing, and the cue
  falls back to the chunk's `start_ms`: a slightly early cue, never a failed search.

## Text and word times line up by spaces

The one rule that makes this work: **chunk text is the words joined by single spaces, and
`word_times` has exactly one entry per space-separated token.** Word *n* in the text is
entry *n* in `word_times`, so a word's index is the number of spaces before it.

The pipeline enforces this where the text is built:

- `chunker._chunk` raises if any word is empty or contains a space.
- Corrections (`corrections.yaml`) keep the alignment too. A replacement of several words
  becomes one word per token, sharing out the replaced span's time evenly
  (`corrections._replace`), so `saw stop` → `SawStop` or `dado` → `dado stack` never shifts
  the words after it.

"Word" here means a Whisper word, punctuation included: `SawStop,` is one token with one
time.

## FTS5 tokens are not the same as words

FTS5 indexes the text with its own tokenizer (`porter unicode61`), which splits on
punctuation and lowercases. So FTS5's tokens can be *parts* of our space-separated words:

| Our word | FTS5 tokens |
|---|---|
| `SawStop,` | `sawstop` |
| `T-square` | `t`, `square` |
| `don't` | `don`, `t` |

The Worker asks FTS5 to mark what it matched with `highlight(chunks_fts, 0, char(1),
char(2))`, which returns the chunk text with `\u0001` before and `\u0002` after each match.
Real output from our schema (shown with `[` `]` instead of the control characters), on the
text `We put the SawStop, a T-square and hide glue on the bench`:

| Query (`fts`) | `highlight()` output |
|---|---|
| `"sawstop"` | `We put the [SawStop], a T-square and hide glue on the bench` |
| `"square"` | `We put the SawStop, a T-[square] and hide glue on the bench` |
| `"t-square"` | `We put the SawStop, a [T-square] and hide glue on the bench` |
| `"hide glue"` | `We put the SawStop, a T-square and [hide glue] on the bench` |
| `"bench" OR "glue"` | `We put the SawStop, a T-square and hide [glue] on the [bench]` |
| `"saw"*` | `We put the [SawStop], a T-square and hide glue on the bench` |

What this shows:

- A match can start or end **inside** a word (`[SawStop],`, `T-[square]`). The trailing
  comma isn't highlighted.
- A phrase is marked as **one span**, spaces included (`[hide glue]`, `[T-square]`).
- With `OR`, every match is marked, in text order, whichever term it came from.
- A prefix match marks the whole FTS5 token (`[SawStop]` for `saw*`).

We use FTS5's own `highlight()` rather than re-implementing the porter stemmer in
TypeScript (plan 2 decision 3). The highlights then always agree with what FTS5 matched:
`dovetails` lights up for a `dovetail` search because FTS5 itself matched it.

## From markers to ranges and a word index

`highlightRanges(marked)` in `worker/src/highlight.ts` turns that output into what the API
returns:

- `text`: the output with the markers removed. It is the chunk text again.
- `ranges`: `[start, end)` offsets into `text`, one per marked span, in UTF-16 code units
  (JavaScript string indices, which is what the frontend slices with). Python clients such
  as `wts search` convert before slicing a `str` (spec §4.4).
- `firstToken`: the index of the word containing the first range's start, which is the number of
  spaces before it.

It never throws on odd markers: a second opening marker while one is open is ignored, a
closing marker with none open is ignored, and a range left open closes at the end of the
text.

## From the word to a cue

Continuing the example above, a search for `sawstop`:

1. `highlight()` gives `So we glued up the \u0001SawStop\u0002, fence`.
2. `highlightRanges` gives the range `[19, 26)`. There are 5 spaces before offset 19, so
   `firstToken` is 5.
3. `hitMs` decodes `word_times` and takes entry 5: **1,235,700 ms**. This is the API's
   `hit_ms`.
4. `cueSeconds(hit_ms, offset) = max(0, floor(hit_ms / 1000) − 7 + offset)` gives
   1235 − 7 = **1228 s (20:28)** for a platform with offset 0.

The 7 s lead-in starts playback just before the word, so the listener hears it in context.
The per-platform offsets (`offset_youtube_s`, `offset_apple_s`, `offset_spotify_s` on the
episode) shift one platform's cue without code changes, for a platform whose audio doesn't
line up with ours.

`hitMs` falls back to the chunk's `start_ms` when there is no highlight, the index is out
of range, or `word_times` doesn't decode.

## Meaning-only ("related") hits

A hit that came only from Vectorize may contain none of the query's words. Smart search
(`loadRelated` in `worker/src/search.ts`) runs one more FTS5 query over those chunks with
the query's words ORed (`rowid IN (…) AND "a" OR "b"`), to highlight any of them that do
appear; when none do, there are no ranges. A quoted phrase counts word by word here
(`parseQuery()`'s `terms`): a hit found by meaning rarely has the exact phrase, so
`"lacquer spray"` marks both words in "then I spray lacquer". Function words
(`HIGHLIGHT_STOPWORDS`: "a", "the", "I", "how", …) are left out, so a question doesn't mark
every "a"; a prefix like `the*` is kept. Keyword hits still mark a phrase as one span; their
stopword highlights are dropped after FTS5 marks them (`withoutStopwords` in
`highlight.ts`), so their cue is the first meaningful word, unless only stopwords were
marked. For related hits the cue is the chunk's start (spec
§4.5): the passage as a whole is the hit, and a highlighted word may be anywhere in it.

## Links

`deepLinks` in `worker/src/links.ts` is the one place links are built (spec §4.6):

- **YouTube:** `https://www.youtube.com/watch?v=<id>&t=<cue>s`.
- **Apple Podcasts:**
  `https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=<id>&t=<cue>`.
- **Spotify:** `https://open.spotify.com/episode/<id>?t=<cue>`.
- **Episode page:** always shown, with no cue. The card shows "jump to mm:ss" next to it.

The Apple and Spotify formats are the ones their own share sheets make when sharing from the
current time; which devices honour them is tracked in [`deep-links.md`](deep-links.md).
Those two links land early by however many ads the listener hears before that point
(spec §4.6).

## Known limits

- The cue is for the **first** highlight in the chunk, which isn't necessarily the best
  one. With `bench OR glue`, the cue is on whichever comes first in the text.
- The control characters `\u0001` and `\u0002` are the highlight markers. Whisper text
  doesn't contain them, but nothing in the pipeline strips them either. If one ever got
  into a transcript, that chunk's highlights would be off; searches would still work.
