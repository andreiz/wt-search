# Handoff: Wood Talk Search UI

## Overview
A single-page transcript search for the Wood Talk podcast (625 episodes). The user types a query, picks Smart (meaning + keywords) or Exact (keywords with counts), and gets passages with timestamps that deep-link into YouTube / Apple / Spotify. Source brief: `docs/design/BRIEF.md` in `andreiz/wt-search`. That brief stays the source of truth for behavior and API contracts. This README covers **visual and interaction design**.

## About the design files
The `.dc.html` files are **HTML design references**, not production code. Rebuild them in the repo's stack (Preact + plain CSS custom properties, per the brief) using its own patterns. They open in a browser if `support.js` sits next to them. All styles are inline in the mocks. Pull the values from here and `tokens.css`.

## Fidelity
**High fidelity.** Colours, type, spacing, radii and states are final. **The dense layout (canvas section 4) is the chosen results layout.** Sections 2–3 use the earlier roomy card and are still the reference for every non-list state: empty, loading, errors, report form, feedback, popovers, expanded transcript.

## Layout
- Page: `--bg`. Content column `max-width:760px`, centred. Desktop padding 24px sides; phone 12px (main) / 16px (header, footer).
- Order: header → main (summary line, notices, results, pager) → footer.
- Breakpoint: "phone" < 600px. The two differences are 44px hit targets and the platform-button treatment (below).

## Components

### Header (`SearchHeader.dc.html`)
- Brand row: "Wood Talk Search", 19px/750 (17px phone), letter-spacing −0.015em. Right side: "Unofficial · fan-made", 13px `--muted`.
- Search row, gap 8px:
  - Input: height 54px (50 phone, 46 compact), radius 12, `--raised`, 1.5px `--border`. Focus: border `--focus` plus a 3px ring of `--focus` at 28%.
  - Inside the input: 18px search icon, 17px text. Placeholder "Search 625 episodes — tools, joinery, finishes…" ("Search 625 episodes" on phone).
  - A `/` kbd hint shows on desktop when the input is empty. A 36px clear button shows when it's filled.
  - Search button: same height, padding 0 24px (16 phone), radius 12, `--accent` / `--on-accent`, 16px/650. Disabled: `--skel` / `--muted`.
- Controls row, gap 8px, wraps:
  - Mode segmented control (role=radiogroup): track `--skel`, 3px padding, radius 10. Segment height 32 (38 phone), radius 8, 14px/650.
    - Selected segment: `--raised` + `0 1px 2px rgba(40,20,5,.15)`, text `--text`. Unselected: transparent, `--muted`.
    - Tooltips: "Matches meaning as well as words" / "Exact keywords only, with counts".
  - Sort menu button: height 38 (44 phone), radius 10, 1px border. Options: Relevance / Newest / Oldest. Menu 180px wide, 40px rows, selected row `--tint` + ✓.
  - Year chip:
    - Unset: "Any year", pill, 1px border.
    - Set: "2015–2020 ×", fill `--tint`, border = `--accent` at 40%, text `--accent`.
    - The popover has From/To selects (44px), "Any year" and "Apply".
    - **Setting years writes `year:2015-2020` into the query box.**
  - `?` syntax help: 38px circle (44 phone). Opens a 340px popover listing the syntax rows from the brief §5. Esc closes it.
- Compact header (scrolled, phone): input only, plus a summary button ("Smart · Relevance · Any year ▾"). Shadow `0 4px 16px rgba(30,15,5,.10)`.

### Dense result card (`DenseResult.dc.html`) — the main list
- Card: `--surface`, 1px `--border`, radius 12, padding 12px 16px (12px 14px phone), inner gap 6px. List gap 8px.
- **Header row**:
  - Left: "Ep. 71" in `--accent` (tabular numerals), then " · " in `--muted`, then the title. 15px/650, line-height 1.3.
  - Right: date, 13px `--muted`, nowrap. When the episode has several hits, a "2 matches" label (600, `--text`) comes before the date.
- **Hit row**, repeated per hit; rows after the first get a 1px top rule and 10px top padding.
  - Desktop grid: `76px | 1fr`, gap 12px.
    - Left column is the timestamp link: 26px high, radius 6, `--tint` fill, `--accent` text, 13px/650 tabular, small ▶ icon. It plays at `playAt` (the brief's −7s offset). Hover fill `--skel`.
  - Phone: a single column, no timestamp column.
  - Excerpt:
    - Style: serif 16px, line-height 1.5, **clamped to 3 lines**.
    - Matched terms are `<mark>`.
    - **Clicking the excerpt opens the full passage, the same as "More transcript".** Ignore the click when the text selection isn't empty. Hover shows a light tint and the tooltip "Show full passage".
  - Actions row, gap 6, wraps:
    - Desktop: all platforms as 30px pills, 13px/650, order YouTube → Apple → Spotify. First pill filled `--accent`; the rest `--raised` with a 1.5px border. Hover border `--accent`.
    - Phone: **first platform only**, as a 44px pill reading "▶ YouTube 1:09:51". Other platforms move into ⋯.
    - ⓘ ads icon, 30px (44 phone), only when Apple or Spotify is visible. Tooltip "May start a bit early because of ads".
    - "+N nearby" text link, when the hit has folded nearby matches.
    - ⋯ menu button, 30px (44 phone), pushed to the right.
- **⋯ menu**: 240px wide, radius 12, `--shadow-pop`. Rows are 36px (44 phone).
  - Phone only, at the top: "Play on Apple" / "Play on Spotify", each with the sub-line "at 1:09:51 · may start early (ads)".
  - Then a divider, "More transcript", "Episode page", another divider, and "Report transcript error" in `--muted`.
- **Related hits** (Smart only):
  - Card: transparent background, **dashed** border (`--border` mixed 25% toward `--muted`), "Related" pill in the header, excerpt in `--muted`, all pills outlined (none filled).
  - Placement: folded after the keyword hits into one 52px button with a dashed border: "Show N related passages" (15px/650) above "Matched on meaning, not the exact words" (13px muted).
  - When expanded: the heading "Related passages" with a "Hide" link, then the related cards.
- Keyboard focus on a card: 3px `--focus` outline, offset 3px. ↑/↓ and j/k move between cards. Enter on a card does nothing special.

### Expanded transcript (roomy card `ResultCard.dc.html`, states 2e / 2i / 3p / 3u)
- "More transcript" shows ±90 s around the hit; "+N nearby" shows ±3 min.
- Each paragraph is a row: timestamp column 70px (58 phone), then serif text.
  - The hit paragraph gets a `--tint` background.
  - Folded nearby hits get a lighter tint, a "Nearby match" label (12px/650 caps, `--muted`) and a lighter mark (`--mark-bg` mixed 55% with `--surface`).
  - Sponsor reads get the label "Sponsor read" and `--muted` text.
- The nearby view ends with a "Search this episode `ep:71`" button (40px).

### Report transcript error (inline in the card, 2f / 3q–3s)
- Fields:
  - Quoted text: prefilled, 500-char counter.
  - Suggested correction: optional, 500-char counter.
  - Note: optional, 1000-char counter.
  - Turnstile slot: 300×65.
  - Send button (44px, accent) and Cancel.
- States:
  - Sending: the form drops to 70% opacity and the button reads "Sending…" and is disabled.
  - Sent: replaced by a success notice, "Thanks — we'll review it."
  - Error: an inline danger notice; **what the user typed is kept**.

### Send feedback (footer, 2j / 3w / 3x)
- The footer link opens an inline form: Message field (1000-char counter) with the helper "Search didn't find something? Have an idea? Tell us.", Turnstile, Send / Cancel.
- Sent state: "Thanks — we read every message."

### Notices
- Inline notice: radius 10, padding 10px 14px, 15px text, a 20px round icon in the tone colour.
  - Background: tone colour at 9% over `--surface`. Border: tone colour at 32%.
  - Tone colours: info `--info`, warning `--warning`, danger `--danger`.
- Uses:
  - Smart degraded → info: "Meaning search is unavailable right now; these are keyword matches." (or "…is paused; …").
  - Rate limited → warning, with a countdown (0:42) and Search disabled.
  - Error → danger: "Something went wrong." with a Retry button.
  - Truncated Exact → info, below the list: "Showing the best 200 of 1,000+ matches — add words, a "phrase" or a year to narrow it."
- Maintenance → a full-width `--warning` bar with `--bg` text above the header; Search disabled.

### Summary line and pager
- Summary: 14px `--muted`, `aria-live="polite"`. Smart shows "Smart search" with no count. Exact shows "**318 matches**" (bold `--text`), plus " · page N of M" on phone.
- Pager, 44px buttons, radius 10:
  - Smart: "← Previous" / "Next →" only.
  - Exact: numbered pages, max 10. The current page is filled `--accent` and has `aria-current="page"`. Phone hides the numbers.
  - Disabled buttons: `--skel` / `--muted`.

### Empty, loading and no-results
- Empty:
  - Heading "Find the moment it was said.", serif 36/28px, weight 600.
  - Below it, "TRY" (13px/650 caps), then 44px example chips: "hide glue", "split-top Roubo", "how do I sharpen a card scraper".
  - Last line: "625 episodes indexed through Sep 17, 2026".
- Loading: 3 skeleton cards in `--skel`, with `aria-busy`.
- No results:
  - Heading "Nothing found." (serif 26px), then 3 suggestions.
  - The first suggestion is a "Switch to Smart" button. Another is the `include:ads` hint.

### Footer
- Line: "**Unofficial** · made with the hosts' blessing".
- Links: Wood Talk on YouTube · Podcast · Website · Send feedback.
- Note: "Searches are logged anonymously to improve results."

## Interactions
- `/` focuses the search box. Esc closes popovers and menus.
- Hover/press colour changes take 120 ms ease-out. Expand and popovers take 200 ms ease-out (fade plus a 4px rise). Under `prefers-reduced-motion`, both durations drop to 0.
- No hover preview on results.
- Every interactive element gets a 3px `--focus` ring.

## State
`q`, `mode` (smart|exact), `sort`, `years` (kept in sync with `q`), `page`, and `status` (idle|loading|ok|empty|degraded|paused|ratelimited|error|maintenance).
- Per card: `expanded` (none|transcript|nearby), `menuOpen`, `reportState` (closed|open|sending|sent|error).
- Global: `relatedOpen`, `feedbackState`.
- Put `q`, `mode`, `sort`, `years` and `page` in the URL.

## Design tokens
All tokens are in `tokens.css`: light and dark colours, radii, motion, focus and `mark`. Contrast in both themes was checked against `--bg` (or the stated pair) and meets AA.
- Type: `--sans` for UI. Source Serif 4 (400/600, Google Fonts) only for excerpts and large headings.
- Type scale: 36 page title · 26 empty heading · 17/15 card titles · 18/16 excerpts · 14 small · 13 meta/labels.
- Spacing: 4 · 8 · 12 · 16 · 24 · 32 · 48.

## Open items
- **Why is this related?** Smart doesn't explain why a related hit matched. Consider a short per-card reason (e.g. "about turbine sprayers") if the backend can return one.
- In the mocks, episode titles, dates and excerpts other than eps. 71, 171, 608 and 615 are placeholders. So is the transcript around each hit.

## Assets
No images. The icons (search, play triangle, info, ×, chevron) are inline SVG and simple enough to redraw. The webfont is Source Serif 4 from Google Fonts.

## Files
- `Wood Talk Search.dc.html`: the canvas with every screen. Section 4 = dense (final list); 1 = tokens and components; 2 = desktop states; 3 = phone states.
- `DenseResult.dc.html`: the dense card.
- `ResultCard.dc.html`: the roomy card, including expanded transcript, nearby and report states.
- `SearchHeader.dc.html`: header, controls and popovers.
- `Screen.dc.html`: page shell and every state.
- `Components.dc.html`: component state sheet.
- `tokens.css`: tokens to drop into the app.
- `support.js`: needed only to open the mocks.
