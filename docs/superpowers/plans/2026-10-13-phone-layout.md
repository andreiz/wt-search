# Phone Layout, Round 2 — Implementation Plan (plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Claude Design's round 2 (the phone layout, and Related made recognisable) into `web/`, with the maintainer's calls.

**Architecture:** Frontend only; the Worker and the API don't change. Four new oak tokens; a `BetaTag` and two full-width "go across" buttons as small components; a new `SortYearsSheet` behind a phone-only button (desktop keeps `SortMenu` and `YearRange`, both stay in the DOM and CSS shows one set); `SyntaxHelp` gets a "Tips ?" trigger and moves out of the controls row; the card header becomes a two-line episode line; the phone hit-row grid changes; a `result-list--related` class turns every card oak.

**Tech Stack:** Preact, TypeScript, Vite, Vitest + Testing Library on happy-dom, Playwright (stubbed `/api/*` under the real CSP), axe.

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §5.2 "Round 2, the phone layout" (revised 2026-10-13; it wins over the older items of §5.2, §5.3, §5.6). **Design:** `docs/design/system/ROUND-2-phone.md` has every measurement; `PhoneScreen2.dc.html` and canvas section 5 of `Wood Talk Search.dc.html` show each screen (open them in Claude Design's viewer or a local HTTP server; `support.js` renders them with React, which says nothing about our stack).

## Global Constraints

- The constraints of `docs/superpowers/plans/2026-10-08-m1-frontend.md` ("Global Constraints") hold: no host in `web/`, the frontend never builds a play link, **no inline styles** (the CSP forbids `style` attributes), API types imported type-only from `worker/src/api-types`, accessibility in the component itself.
- Measurements come from `ROUND-2-phone.md`; where it says "Relevance", read **"Best match"** (URL and API value stay `sort=relevance`).
- Phone is below 600 px (`@media (max-width: 599.98px)`, the existing breakpoint).
- Touch targets stay ≥ 44 px; the time chip and "+N nearby" are drawn 36 px tall with a 44 px hit area (an absolutely positioned `::after`, `inset: -4px 0`).
- BETA is a visual tag only (`aria-hidden="true"`); accessible names carry "beta".
- Copy is the spec's, word for word.
- Commands: `cd web && npm test` (unit + build check), `npm run typecheck`, `npm run e2e`. All pass after every task.
- Files are changed with Edit/Write only. One commit per task, on `main`. No push without the maintainer's word.

## Review Focus

1. **The sheet applies sort and years in one search.** Changing both and pressing Show results must push one history entry and send one request, with `sort=` and the `year:` token together; Back returns to the state before both. (Task 2 test.)
2. **Esc inside the sheet while focus is on a `<select>`** must close the sheet without applying, and not also close the compact header's controls (the header's own Esc handler runs on bubbling). (Task 2 test.)
3. **A Related page reached from Exact's oak button, then the switch back to Exact,** must lose the oak styling immediately, also while the next answer is loading (the skeleton must not be oak, and the old cards must not flash oak). (Task 4 test.)
4. **An unnumbered episode** shows "Bonus" in the meta line, keeps the date and "N matches", and the card (labelled by its heading) still has a name holding the title. (Task 3 test.)
5. **"Tips ?" before any search** (no summary line): the start page's TRY row has it; the popover's example fills the box and focuses it, as the old `?` did. (Task 2 test.)

---

### Task 1: Oak tokens, the BETA tag, the mode switch

**Files:**
- Modify: `web/src/styles/tokens.css`, `web/src/styles/components.css`, `web/src/components/ModeSwitch.tsx`
- Create: `web/src/components/BetaTag.tsx`
- Test: `web/test/controls.test.tsx` (extend)

**Interfaces:**
- Produces: `BetaTag()` → `<span class="beta-tag" aria-hidden="true">BETA</span>`. CSS `.beta-tag`: 10px/750, letter-spacing .06em, padding 2px 4px 1px, radius 4px, 1px solid `--rel-border`, color `--rel`, `vertical-align: middle`, `white-space: nowrap`.
- Tokens (both copied from `docs/design/system/tokens.css`, which already has them): light `--rel:#5E584E; --rel-bg:#EFECE6; --rel-border:#CEC8BD; --rel-tint:#E2DDD4;` dark `--rel:#BEB7AB; --rel-bg:#1D1B18; --rel-border:#3E3A34; --rel-tint:#2D2A25;`, placed after `--tint`/`--skel` in each block.
- `ModeSwitch`: options become `{ mode: "exact", label: "Exact", name: "Exact" }` and `{ mode: "related", label: <>Related <BetaTag /></>, name: "Related, beta" }`; each radio gets `aria-label={name}`; tooltips unchanged. CSS per `ROUND-2-phone.md` §1 "Mode switch": track `--skel`, 3px padding, radius 12, 44px tall on phone (`--seg-h` stays for desktop, 38px), segments `flex:1`, radius 9, 15px/650; selected `--bg` fill, shadow `0 1px 2px rgba(40,20,5,.18)`, `--text`; unselected `--muted`. Phone: `.mode-switch { flex: 1 }`. Desktop: `width: 280px`.

- [ ] **Step 1: Write failing tests** in `controls.test.tsx`: the radios are named "Exact" and "Related, beta"; the BETA text is inside an `aria-hidden` element; arrow keys still move the choice; existing tests that look for the radio by name "Related (beta)" are updated to "Related, beta" (search `web/test` and `web/e2e` for `"Related (beta)"` used as a radio name: `grep -rn 'name: "Related (beta)"' web/test web/e2e`).
- [ ] **Step 2: Run** `cd web && npx vitest run test/controls.test.tsx` and confirm the new tests fail.
- [ ] **Step 3: Implement** tokens, `BetaTag`, `ModeSwitch`, CSS.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e`. Expected: all pass (update the e2e radio names found in Step 1).
- [ ] **Step 5: Commit** `web: oak tokens, BETA tag, the mode switch reads Related + BETA (plan 6, Task 1)`

---

### Task 2: The controls row, the Sort & years sheet, "Tips ?"

**Files:**
- Create: `web/src/components/SortYearsSheet.tsx`, `web/src/components/SortYearsButton.tsx`
- Modify: `web/src/app.tsx`, `web/src/use-search.ts`, `web/src/components/SyntaxHelp.tsx`, `web/src/components/EmptyState.tsx`, `web/src/styles/components.css`
- Test: create `web/test/sort-years-sheet.test.tsx`; extend `web/test/search.test.tsx`; create `web/e2e/sheet.spec.ts`

**Interfaces:**
- Consumes: `BetaTag` (Task 1); `sortLabel`, `SortOrder` (`SortMenu.tsx`, `lib/url.ts`); `rangeLabel`, `setRange`, `clearRange`, `START_YEAR`, `YearRange` type (`lib/years.ts`).
- Produces:
  - `use-search.ts`: `submit(q: string, sort?: SortOrder)`: with `sort`, the same commit carries both (one `pushState`, one request).
  - `SortYearsButton({ sort, range, open, onOpen, buttonRef })`: a `<button class="sort-years-button">` with `aria-haspopup="dialog"`, `aria-expanded`, `aria-label={\`Sort and years: ${sortLabel(sort)}, ${rangeLabel(range)}\`}`; content: 16px sliders icon (inline `<svg>`, three horizontal lines with knobs, `stroke="currentColor"`), the year label, and `<span class="sort-years-button__dot" aria-hidden="true">` when `sort !== "relevance"`. Classes `sort-years-button--set` when `range` is not null.
  - `SortYearsSheet({ sort, range, thisYear, onApply(sort, range | null), onClose })`: rendered only when open. A scrim `<div class="sheet-scrim">` (click → `onClose`) and `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby=…>`: grabber, title row ("Sort & years" + **Done**), "SORT" label + a 3-way radiogroup (Best match / Newest / Oldest, built like `ModeSwitch`, named "Sort"), "YEARS" label with an **Any year** text button on the right, From / To `<select>`s (reuse the `YearSelect` pattern from `YearRange.tsx`: set the value in a layout effect), **Show results**. Staged state starts from the props on each opening. Done and Show results call `onApply(stagedSort, stagedRange)` then `onClose`; Any year sets the staged range to null (the selects then show START_YEAR and `thisYear`, and applying with "any" clears). Esc anywhere in the sheet: `preventDefault()`, `stopPropagation()`, `onClose()`. Focus: the first radio (the checked one) on open; Tab and Shift+Tab wrap inside the sheet; on close focus returns to the button (the caller passes `buttonRef`).
  - `SyntaxHelp({ onPick, variant = "tips" })`: the trigger becomes a text button "Tips" followed by an 18px outlined circle with "?" (`<span class="tips__circle" aria-hidden="true">?</span>`), class `tips-button`, accessible name "Search tips"; 44px tall (12px vertical padding), 14px/600 `--accent`. The popover is unchanged.
- Layout in `app.tsx`:
  - `.controls` keeps `ModeSwitch`, then a `div.controls__desktop` with `SortMenu` + `YearRange`, then a `div.controls__phone` with `SortYearsButton`. CSS: `.controls__phone { display: none }` by default; below 600 px `.controls__desktop { display: none }` and `.controls__phone { display: contents }`. The `?`/spacer leave the row; `.controls` is `flex-wrap: nowrap; gap: 8px` on phone.
  - The sheet renders at the end of `.page` (outside the header, so the compact header's transforms don't move it) when open; `onApply(sort, range)` calls `searchFor(range ? setRange(text, range.from, range.to) : clearRange(text), sort)` when anything changed, nothing otherwise; `searchFor(raw, sort?)` passes `sort` through to `submit`.
  - "Tips ?" sits in `.summary-row` at the right (after `HowItWorks` when shown): `.summary-row { display:flex; align-items:center; gap:14px }`, the status grows. Before any search, `EmptyState` gets an `onTip(example)` prop and renders `SyntaxHelp` at the right of its TRY label row (Task 3 restyles that row; here only place it).
- CSS for the button and sheet: `ROUND-2-phone.md` §1 "Sort & years button" and "Sort & years sheet (phone)": button 44px tall, padding 0 12px, radius 12, gap 7px, 14px/600, nowrap, `--surface` fill, `--border` border, `--text`; set: `--tint` fill, border `color-mix(in srgb, var(--accent) 45%, transparent)`, `--accent` text; dot 6px circle `currentColor`. Sheet: fixed to the bottom, full width, `--raised` fill, radius 20px 20px 0 0, padding 8px 16px 28px (plus `env(safe-area-inset-bottom)`), gap 18px, grabber 36×5 radius 3 `--border`; scrim fixed full screen `rgba(15,8,3,.5)`; title 18px/700; Done 44px `--accent` text button; caps labels 13px/600 letter-spacing .06em `--muted`; sort segmented 44px styled like the mode switch; selects 48px radius 12 17px `--bg` fill `--border` border; Show results full width 50px radius 12 `--accent` fill `--on-accent` text 16px/650. `z-index` above the header (the header uses `z-index` in `components.css`: put the scrim and sheet above it). Motion: slide up 200ms `--ease` (none under reduced motion, which the tokens already zero).

- [ ] **Step 1: Write failing tests.**
  - `sort-years-sheet.test.tsx`: opens with the props' sort checked and the range in the selects; changing sort and years then Show results calls `onApply("newest", {from: 2015, to: 2020})` once; Done does the same; Esc and a scrim click call only `onClose`; Any year then Show results calls `onApply(sort, null)`; Tab from Show results wraps to the first focusable; the radios have names "Best match", "Newest", "Oldest"; the dialog is named "Sort & years".
  - `search.test.tsx` (the page): at a phone width (`window.innerWidth` doesn't matter in happy-dom; test the DOM): the button reads "Any year", has the name "Sort and years: Best match, Any year"; after choosing Newest and 2015–2020 in the sheet and Show results, `history.pushState` was called once and the stubbed fetch saw one request with `sort=newest` and `q=… year:2015-2020`; the box shows `year:2015-2020`; the button then has the dot and the `--set` class; focus returned to the button. "Tips" opens the syntax popover from the summary row and from the start page; picking an example fills the box and focuses it.
  - Review Focus 2: with the compact controls open (scrolled), Esc on a select inside the sheet closes only the sheet.
- [ ] **Step 2: Run** `npx vitest run test/sort-years-sheet.test.tsx test/search.test.tsx`; confirm the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: e2e** `web/e2e/sheet.spec.ts` at 390×844: the controls row is one line (the switch and the button share a `top` within 1 px) with "2015–2020" set; open the sheet, pick Oldest and a range, Show results → one request (count `page.on("request")` to `/api/search`), URL has `sort=oldest`; Back restores both; no CSP violation (the pattern in `e2e/search.spec.ts`). At 1000 px the sort menu and year chip show and the button doesn't.
- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run e2e`. Expected: all pass (update existing tests that click the `?` button "Search syntax help": it is now "Search tips").
- [ ] **Step 6: Commit** `web: one-line controls on phones, the Sort & years sheet, Tips (plan 6, Task 2)`

---

### Task 3: Start page and the episode line

**Files:**
- Modify: `web/src/components/EmptyState.tsx`, `web/src/components/ResultCard.tsx`, `web/src/components/TitleHits.tsx`, `web/src/styles/components.css`
- Test: extend `web/test/states.test.tsx`, `web/test/result-card.test.tsx`, `web/test/title-hits.test.tsx`

**Interfaces:**
- `EmptyState`: `EXAMPLES = ["hide glue", "split-top Roubo", "sharpening a card scraper"]`. Heading "Find the moment it was said." 24px serif 600, `white-space: nowrap` (desktop 36px). A row: "TRY" caps label (13px/600 .06em `--muted`) with `SyntaxHelp` at its right (Task 2), then `<ul class="try-list">` of `<li><button class="try-list__item">example<svg → 16px --accent aria-hidden/></button></li>`: rows 52px, 17px `--text`, hairline (`--border`) between rows and at the bottom, full width, left-aligned. The corpus line 14px `--muted`.
- `ResultCard` header: `<h3 class="result__title" id=…>` holds two lines:
  - `<span class="result__meta">`: `Ep. 606` (`result__ep`) — or `Bonus` (`result__bonus`, `--accent`, 700) when `number === null` — ` · ` date (`<time>`) and, with more than one hit, ` · 2 matches`. 13px `--muted`, nowrap, tabular numerals, min-height 22px, gap 6px (separators are `<span aria-hidden="true"> · </span>`, so the name reads "Ep. 606, May 6, 2026, 2 matches, Title"… keep the visible "·" for sighted users; the text content order is meta then title).
  - `<span class="result__name">` the display title: 17px/650, line-height 1.3, `text-wrap: pretty`, clamped to 2 lines (`display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden`).
  - The old right-hand `result__meta` span goes. Episode gap 22px, line-to-card 8px.
- `TitleHits` rows (Design §"Episodes row"): meta line `Ep. 590 · May 30, 2023` (13px muted) above the title (16px/650, the title link and its play icon as now; `<mark>` on matched words is out of scope: the API sends no title ranges), and a 44×44 icon button "Search this episode" (magnifier `<svg>`, accessible name unchanged) at the right in place of the text button. Rows 10px vertical padding, hairlines between.

- [ ] **Step 1: Write failing tests:** the start page has three buttons in a list with the new third example and the corpus line; clicking one searches it; `result-card.test.tsx`: a numbered card's heading text is "Ep. 606 · May 6, 2026 · 2 matches" then the title (order of text nodes), an unnumbered card's begins with "Bonus" (Review Focus 4), a one-hit card has no "matches"; the title element has class `result__name`; `title-hits.test.tsx`: the meta line holds the number and date, the search button is still named "Search this episode: Ep. 590" and fills the box.
- [ ] **Step 2: Run** the three test files; confirm the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e`. Expected: all pass (update e2e that read the old header text; `grep -rn "result__meta\|matches ·" web/e2e`).
- [ ] **Step 5: Commit** `web: start page list, the two-line episode line (plan 6, Task 3)`

---

### Task 4: The hit row on phones, and Related in oak

**Files:**
- Modify: `web/src/components/ResultList.tsx`, `web/src/components/Skeleton.tsx` (only if it shares the list class), `web/src/styles/components.css`
- Test: extend `web/test/result-list.test.tsx`; extend `web/e2e/result-cards.spec.ts`

**Interfaces:**
- `ResultList` already takes `related`; its `<ol>` (or wrapper) gets `result-list--related` when true. Nothing else in the DOM changes.
- CSS, all widths (`ROUND-2-phone.md` §3–4): `.result__card` radius 14px. `.result-list--related .result__card { background: var(--rel-bg); border-color: var(--rel-border); box-shadow: none; }`, `.result-list--related .hit--ruled { border-top-color: var(--rel-border) }`, `.result-list--related .hit__time { background: var(--rel-tint); color: var(--rel); }`, `.result-list--related .hit__nearby { color: var(--rel); }`. The excerpt keeps `--text` in both.
- CSS, phone (replace the `.hit` block in the `max-width: 599.98px` media query): `grid-template-columns: auto minmax(0, 1fr) 44px`; row 1: `.hit__time` (col 1, 36px tall, padding 0 12px, radius 8px, 15px/700 tabular, ▶ icon, 44px hit area per Global Constraints) and `.more-menu` (col 3, 44×44, `margin-right: -10px`); row 2: `.hit__excerpt` spanning `1 / -1` (serif 17px, line-height 1.55, 3-line clamp); row 3: `.hit__nearby` (`1 / -1`, 14px/600 underlined, 36px drawn, 44px hit area). Padding 12px 14px 14px, gap 8px. Keep `.hit__report` on row 4 and the open-state rules (`.hit--open …`) working: run the transcript tests.

- [ ] **Step 1: Write failing tests:** `result-list.test.tsx`: with `related` the list has `result-list--related`, without it doesn't; e2e `result-cards.spec.ts` at 390 px: the chip's and ⋯'s boxes share a row (tops within 2 px) and the excerpt's left edge equals the chip's (full width); in Related the card's computed background is the `--rel-bg` value (`getComputedStyle(...).backgroundColor` equals `rgb(239, 236, 230)` in light); then click the switch to Exact while the next answer is held (route that waits): the skeleton and the old cards are not oak (Review Focus 3: the class must follow the *answer's* mode, `view.data.mode`, which `app.tsx` already passes; check the skeleton doesn't sit inside the related list).
- [ ] **Step 2: Run** the unit test; confirm it fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e`. Expected: all pass, including `transcript.spec.ts` (the open view inside a row).
- [ ] **Step 5: Commit** `web: chip and ⋯ on one line on phones; Related cards in oak (plan 6, Task 4)`

---

### Task 5: Summary line, few and no results, the compact header

**Files:**
- Create: `web/src/components/AcrossButton.tsx`
- Modify: `web/src/components/Summary.tsx`, `web/src/components/EmptyState.tsx` (`NoResults`), `web/src/app.tsx`, `web/src/styles/components.css`
- Test: extend `web/test/summary-pagination.test.tsx`, `web/test/states.test.tsx`; extend `web/e2e/states.spec.ts`

**Interfaces:**
- Consumes: `BetaTag` (Task 1); "Tips" placement (Task 2).
- Produces: `AcrossButton({ to: "related" | "exact", onClick })`:
  - `to="related"`: `<button class="across across--related">` with `<span aria-hidden="true">≈</span> See related passages <BetaTag/>`, accessible name "See related passages (beta)". Full width, 50px, radius 12, `--rel-bg` fill, `--rel-border` border, `--rel` text 16px/650, gap 8px, centred.
  - `to="exact"`: `<button class="across across--exact">See exact matches</button>`: same shape, `--surface` fill, `--border` border, `--accent` text.
- `Summary`, Related: `<p class="summary"><span class="summary__rel">Related <BetaTag/></span>{range}</p>` with a visually hidden "(beta)" so the live region reads "Related (beta) · top results 1–20"; `.summary__rel` colour `--rel`. Exact unchanged (14px `--muted`, count bold).
- `NoResults` (copy from the spec block):
  - Exact: `<h2>` "Nothing found." (28px serif), `<p>` "No passage has those exact words." (16px muted), `AcrossButton to="related"`, `<p>` "Or use fewer words, or check the spelling." / with years "Or use fewer words, loosen the years, or check the spelling." (15px muted).
  - Related: "No related passages." / "Nothing about the same thing turned up without your words." / `AcrossButton to="exact"`. No third line.
- `app.tsx`:
  - few Exact: `<div class="few">` with `<p><strong>{`Only ${n} exact ${n === 1 ? "match" : "matches"}.`}</strong> Related passages match the meaning, not just the words.</p>` (15px) and `AcrossButton to="related"`; the Pagination is not rendered then (it has one page anyway).
  - Related degraded: keep the `Notice` text, drop its inline action, render `AcrossButton to="exact"` under it.
  - Compact header button: the label becomes three parts: `{mode === "exact" ? "Exact" : <span class="compact-summary__rel">Related <BetaTag/></span>}` · `sortLabel(sort)` · `<span class={range ? "compact-summary__year--set" : ""}>{rangeLabel(range)}</span>`, plus a visually hidden "(beta)"; accessible name e.g. "Related (beta) · Newest · 2015–2020". 40px tall, 14px/600 `--muted`; `--rel` and `--accent` as named. Behaviour unchanged.
- Remove now-unused CSS (`.nothing__list`, the old `.end-note` button styling for "See related passages (beta)", `.notice__button` if unused elsewhere: grep before deleting).

- [ ] **Step 1: Write failing tests:** summary text for Related reads "Related (beta) · top results 1–20" as accessible text and shows a BETA tag; Exact no results shows the four parts and the years variant; Related no results shows its three parts and "See exact matches" switches mode; few Exact shows the new sentence and the oak button named "See related passages (beta)"; the degraded notice has the exact button under it; the compact button's accessible name for Related, Newest, 2015–2020.
- [ ] **Step 2: Run** the two unit test files; confirm the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e`. Expected: all pass (update e2e states that click "See related passages (beta)" as a text button: the name is unchanged, the role is still button).
- [ ] **Step 5: Commit** `web: summary with BETA, the go-across buttons, few/no results, compact header label (plan 6, Task 5)`

---

### Task 6: Captures, accessibility, docs

**Files:**
- Modify: `web/e2e/a11y.spec.ts`, `web/e2e/screenshots.spec.ts` (only if a new state needs adding: the sheet open), `docs/design/BRIEF-2-phone.md` (a line at the top: answered by round 2, built in plan 6), `docs/HANDOFF.md`
- Refresh: `docs/design/round-2/` captures are the *before* set; leave them. New captures go to `web/screenshots/` (gitignored) via `npm run e2e:shots`.

- [ ] **Step 1:** Add the sheet-open state and the Related results state at 390 px, light and dark, to the axe run in `a11y.spec.ts` (the pattern there); run `npx playwright test e2e/a11y.spec.ts`. Expected: no violations (oak text is ≥ 4.5:1 per the design; if axe disagrees, report the pair and its ratio, don't change the token silently).
- [ ] **Step 2:** `npm run e2e:shots`, then look at `web/screenshots/phone-light/` and `phone-dark/` for: before any search, Exact with title matches, Related results, no results in each mode, only a few matches, a year range set, the sheet open, compact header. Compare with `PhoneScreen2.dc.html` (section 5 of the canvas). List differences in the handoff rather than fixing them in this task, unless one breaks a Global Constraint.
- [ ] **Step 3:** HANDOFF entry: what was built, the maintainer's calls (spec block), how to check it on staging (`cd worker && npm run deploy:staging`, then the phone pass).
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e`.
- [ ] **Step 5: Commit** `web: round 2 accessibility checks and handoff (plan 6, Task 6)`

---

### Checkpoint L (the maintainer, on an iPhone)

After `cd worker && npm run deploy:staging`:
1. Start page: heading on one line; the TRY list; Tips opens the syntax help.
2. Search `glue`: one-line controls; open Sort & years, set Newest and 2015–2020, Show results; the button shows the dot and the year; Back.
3. Related: the cards are oak; the summary says Related BETA; How this works and Tips sit at the right.
4. `zymurgy` in Exact: "Nothing found." and the oak button; in Related: "No related passages." and See exact matches.
5. Scroll a long result page: the compact header reads "Exact · Best match · Any year ▾" and opens the controls.
6. VoiceOver on the switch: "Related, beta".
