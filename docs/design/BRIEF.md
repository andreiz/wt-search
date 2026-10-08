# Design brief — Wood Talk transcript search

For Claude Design: first a **design system**, then the **UI** built on it. This brief stands on
its own; the engineering spec behind it is `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`
§5 (frontend) and §4.4 (API), which win if the two ever disagree. Written 2026-10-08. Items
marked *(proposed)* go beyond spec §5 and are confirmed with the maintainer in plan 3.

## 1. What it is

A search engine over the transcripts of **Wood Talk**, a woodworking podcast (2007–today, ~625
episodes, three hosts talking shop: tools, joinery, finishes, listener questions). Someone types
what they remember, "hide glue", "how do I flatten a workbench top", and gets the moments in
episodes where it was said, each with buttons that play the episode **at that moment** on
YouTube, Apple Podcasts or Spotify.

- **Who:** listeners and woodworkers, mostly on phones, often mid-project in a shop. They want
  the answer fast and then to listen; they don't read long pages.
- **Unofficial:** a fan-built tool, made with the hosts' blessing. Its own identity, **not**
  Wood Talk's logo, artwork or branding; the name in the header is plain text.
- **Two search modes:** **Smart** (default: matches meaning as well as words, so it finds
  "spray finish" when the episode said "HVLP") and **Exact** (keywords only, with counts).
  Smart results come in two kinds: **keyword** hits (the words are there, highlighted) and
  **related** hits (found by meaning; no highlights). Related hits are suggestions and must
  read as secondary.

## 2. Look and feel

- **Warm and workshop-like:** a wood-tone accent (think walnut, cherry, shellac amber) on calm
  neutrals; quiet, readable, practical. Not rustic kitsch, no wood-grain textures behind text.
- **Light and dark**, following the system setting.
- **Readable first:** transcript excerpts are the content; generous line height, a text size
  that reads well on a phone held at arm's length in a shop.
- **WCAG AA** everywhere, both themes, including `<mark>` highlights and disabled states.
- Fast and light: system fonts or one webfont at most; no heavy imagery.

## 3. Deliverable 1 — design system

Tokens (both themes): colour (background, surface, raised surface, text, muted text, border,
accent, accent text, highlight for `<mark>`, focus ring, success, warning, danger, info), type
scale (body, small, label, card title, page title), spacing, radius, shadow, motion (short,
subtle; respect reduced motion).

Components, each with its states (default, hover, focus, active, disabled, loading):

| Component | Notes |
|---|---|
| Search input + Search button | Large; the `/` key focuses it. Clear button when not empty. |
| Mode switch | Segmented control: **Smart** / **Exact**, each with a one-line tooltip. |
| Sort menu | Relevance / Newest / Oldest. |
| Year range control | *(proposed)* A chip "Any year" that opens from–to year pickers (2007–this year); once set it shows "2015–2020 ×". |
| Syntax help | A `?` button opening a popover (content in §5). |
| Result card | The core component; anatomy in §4.2. Variants: keyword hit, related hit, expanded (More transcript), with report form open. |
| Platform button | ▶ YouTube, ▶ Apple, ▶ Spotify: icon + label, the start time on hover/long-press. Plus a plain "Episode page" link. |
| Tag | "Related" (meaning-only hit); possibly "Sponsor read" when `include:ads` shows one. |
| Timestamp chip | "1:09:51": the moment in the episode. |
| Notice | Inline, subtle: info / warning / danger. For degraded search, truncation, rate limit, errors. |
| Banner | Full-width, for maintenance. |
| Inline form | Report a transcript error: text areas with counters, a Turnstile widget slot, submit, success and error states. |
| Pagination | Previous / Next (+ page numbers in Exact mode, up to 10). |
| Skeleton | Loading cards. |
| Footer | Small print and links. |

## 4. Deliverable 2 — UI

One page, one column (results ~720–760 px wide on desktop), a header with the search controls
that stays reachable (sticky, compacting on scroll on phones). All state lives in the URL
(`?q=&mode=&sort=&page=`), so any search can be shared.

### 4.1 Search area
- The input, the Search button, then a row: mode switch · sort · year range · `?`.
- Searching happens on Enter or the button, not while typing. Changing mode, sort or years
  re-runs the current search.
- Below, a one-line summary: Smart: "Smart search" (+ page); Exact: "**318 matches**", or
  "**1,000+ matches**" past the count cap.

### 4.2 Result card (top to bottom)
1. **Ep. 71 · Welcome to the Three-Way** (number, then the title with the number removed —
   feed titles repeat it: "Welcome to the Three-Way | 71") · **Jun 10, 2010** · timestamp chip
   **1:09:51**. Unnumbered episodes show the title only.
2. **Excerpt**, about 2–3 lines on a phone: the ~30 seconds of transcript (80–120 words) is
   clamped around the first highlight, with `<mark>` on the matched words. Related hits: no
   marks, a "Related" tag by the timestamp, slightly quieter styling.
3. **Actions:** ▶ YouTube, ▶ Apple, ▶ Spotify — only those the episode has (old episodes
   often have Spotify only), YouTube first; then Episode page · More transcript ·
   **+3 more in this episode** (when nearby hits were folded into this card; it searches
   within that episode).
4. A small "Report transcript error" link.

Apple and Spotify can start a little early (inserted ads shift their timeline): a small,
unobtrusive note near those buttons, e.g. an info icon: "May start a bit early because of ads".

### 4.3 More transcript
Expands the card in place: about ±90 seconds of transcript as paragraphs, each with its
timestamp label (each label is a play link at that moment), the hit's paragraph emphasised.
On desktop, hovering over the excerpt for 400 ms may show a preview; on touch, tap expands.

### 4.4 Report a transcript error
An inline form inside the card: **Quoted text** (pre-filled from the excerpt or the user's
selection, editable, ≤ 500), **Suggested correction** (optional, ≤ 500), **Note** (optional,
≤ 1000), the Turnstile check (a ~300×65 widget, often invisible), **Send**. Success: "Thanks —
we'll review it." Errors are inline, friendly, keep what was typed; "too many reports, wait a
minute" is one of them.

### 4.5 States to design (each in light and dark, phone and desktop)

| State | What shows |
|---|---|
| Before any search | Example searches as chips ("hide glue", "split-top Roubo", "how do I sharpen a card scraper"), and "625 episodes indexed through Sep 17, 2026". |
| Loading | Skeleton cards; the controls stay usable. |
| Results, Smart | Keyword hits first, related hits mixed in by rank (sample data in §6). |
| Only related hits | Before them: "No exact matches — passages about similar things:". |
| No results | "Nothing found." with suggestions: try Smart mode, fewer words or looser years, or `include:ads` for sponsor reads. |
| Exact, truncated | After the last page: "Showing the best 200 of 1,000+ matches — add words, a "phrase" or a year to narrow it." |
| Smart search degraded | A subtle notice above results, by reason: *unavailable* "Meaning search is unavailable right now; these are keyword matches."; *budget* and *off* "Meaning search is paused; these are keyword matches." |
| Maintenance | A banner: "Search is down for maintenance. Please try again later." |
| Rate limited | "Too many searches from here; try again in a minute." with a countdown. |
| Error | "Something went wrong." with Retry. |
| Report form | open, sending, sent, error. |
| More transcript | expanded card. |

### 4.6 Keyboard and accessibility
`/` focuses search; arrow keys move between results; *(proposed)* j/k too, and Enter on a
result plays its first platform; Esc closes popovers and forms. Visible focus everywhere; buttons are real buttons
with names ("Play on YouTube at 1:09:44"); results are a list; the excerpt marks are announced
as highlights; motion respects reduced-motion.

### 4.7 Footer
"Unofficial · made with the hosts' blessing" · links to the show (YouTube, podcast, website) ·
"Searches are logged anonymously to improve results." · *(proposed, open)* "Send feedback".

## 5. Syntax help (the `?` popover)

| Type | Finds |
|---|---|
| `hide glue` | both words |
| `"hide glue"` | the exact phrase |
| `titebond -hide` | without a word |
| `glue OR epoxy` | either |
| `dovetail*` | words starting with it |
| `year:2015` · `after:2019` · `before:2012` | by year (after/before exclude the year itself) |
| `ep:613` | one episode |
| `include:ads` | also search sponsor reads |

## 6. Sample data (real excerpts; use these, not lorem ipsum)

From the real staging index, trimmed and lightly corrected (a few misheard words fixed); real
excerpts read as unpolished speech, and the design should be comfortable with that.

Query `hvlp sprayer`, Smart mode, sort by relevance:

1. **Ep. 71 · Welcome to the Three-Way** · Jun 10, 2010 · **1:09:51** · keyword · YouTube no,
   Apple no, Spotify yes · +3 more in this episode
   > All right, the great folks over at Highland Woodworking, they have the Earlex HV2900
   > <mark>HVLP</mark> <mark>sprayer</mark>. When you purchase it at the sale price of $149.99,
   > they will throw in a free copy of Jeff Jewitt's spray finishing made simple book and DVD.
   > Nice. When I was out there, they had that same special. Oh, did they really? Yeah, but that
   > Earlex unit is another one of the little guys.
2. **Ep. 608 · Kreg Edge Discussion and The Best Trade Show You'll Never Go To** · May 29,
   2026 · **19:26** · related · YouTube, Apple, Spotify · +1 more in this episode
   > The turbine sprayers are just vacuum cleaners going the other way. Okay. All right. Well,
   > that was awesome. Good luck with that. We stopped by the Old Masters booth. That's a
   > finishing company. We watched both Matt and Shannon try their best to create bow wood grain.

Query `10% off`, Exact mode: **Ep. 615 · Why We Don't Use Metric** · Sep 17, 2026 · **1:02** ·
keyword · YouTube, Apple, Spotify
> There's something about regularly priced merchandise that does not roll off the tongue.
> <mark>10%</mark> <mark>off</mark> the stuff that you don't really want? <mark>10%</mark>
> <mark>off</mark> the stuff that ain't on sale. How about that? Can't be combined with other
> offers. Exclusions apply.

A related hit that is a stretch (shows why related hits must look secondary), query `how do I
flatten a workbench top`: **Ep. 171 · Mind the Neck Divot!** · Feb 25, 2014 · **59:39** · related
· Spotify only
> Essentially, the spline method is almost like a loose tenon in some respects. But, you know,
> miter half laps, that's another one. There are probably more ways than I could think of to
> strengthen a miter.

Lengths to design for: titles up to ~70 characters ("Kreg Edge Discussion and The Best Trade
Show You'll Never Go To"); episode numbers 1–616 and none; timestamps up to 2:30:00; 1–3
platform buttons.

## 7. Constraints for the build (so designs are buildable)

- Built with Vite + TypeScript + Preact; the design system's tokens become CSS custom
  properties. Components should map to plain HTML and CSS, no heavy UI framework.
- Play links come ready-made from the API, per platform, already set to the right second; the
  UI never builds them.
- Text in excerpts is exactly as transcribed (it can contain filler words and small errors);
  that's what "Report transcript error" is for.
- Page size 20; Smart mode has no total count, only "more"; Exact mode shows counts and up to
  10 pages.
