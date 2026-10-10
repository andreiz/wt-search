# Card Actions and Show Page Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each hit has one play control that lands at the right moment (YouTube, else the show page at an offset), Apple and Spotify move into the ⋯ menu, and the episode header sits above its card.

**Architecture:** The Worker's one link builder (`worker/src/links.ts`) adds `seek=<cue>` to an Acast show page link and reports the cue as `cue_s.page`; the pipeline's `wts links` mirrors it. The web card (plan 3 Task 9) drops its pill row: the timestamp chip is the play link, the ⋯ menu holds the other platforms at every width, and the header moves out of the card's box.

**Tech Stack:** As plan 3 (`docs/superpowers/plans/2026-10-08-m1-frontend.md`): Worker in TypeScript with Vitest in the Workers runtime; pipeline in Python with pytest; web in Preact + TypeScript with Vitest/happy-dom and Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §4.5 (the show page cue), §4.6 (the show page link, "Which link the card plays"), §5.3 (the four items under "Revised after the first look on staging"), §5.4. Mock: `docs/design/card-separation-options.html`, **option A** (option B is a recorded alternative, not built).

This plan slots in **between plan 3's Task 9 and Task 10**. Task 10 (More transcript) then uses `primaryPlay` from Task B for its timestamp links.

## Global Constraints

- Plan 3's Global Constraints all apply to `web/`: no host in `web/`, the frontend never builds a play link, no inline `style=`/`style={}`, types imported type-only from `worker/src/api-types` and nowhere else, accessibility in the same task, copy from the spec.
- Accessible names contain the control's visible text, in order (WCAG 2.5.3; spec §5.3).
- Copy, exactly: menu rows "Show page" / "plays from 29:01, may play an ad first"; "Play on Apple" / "at 29:01 · may start minutes early" (same for Spotify); "More transcript"; "Report transcript error". Chip names: "Play on YouTube 29:01, starts at 28:54"; "Play on the show page 29:01, starts at 28:54, may play an ad first".
- Worker rules from plan 2: test-first; `cd worker && npm test && npx tsc --noEmit`; check the test count after each run.
- Implementers do not commit; the main session reviews, runs every suite and commits on `main`, one commit per task.

## Review Focus

1. **A `page_url` that is not an Acast show page** (older episodes, another host, a malformed URL): the link is passed through unchanged, never broken by a stray `seek`. Task A tests pin it.
2. **A `page_url` that already has a query or a fragment:** `seek` is added to the query, not appended after the fragment. Task A.
3. **An episode with no YouTube and no page:** the chip is plain text, the menu still opens, nothing throws. Task B.
4. **An episode whose only link is the page:** the chip plays the page and the menu does not list "Show page" a second time. Task B.
5. **Keyboard and screen reader on the new row:** the chip, "+N nearby" and ⋯ are reachable in that order, and the header outside the card's box still names the list item. Task B.

---

### Task A: Show page link with an offset (Worker and pipeline)

**Files:**
- Modify: `worker/src/api-types.ts` (`CueTimes`), `worker/src/links.ts`, `worker/test/links.test.ts`
- Modify: `pipeline/src/wts/links.py`, its tests in `pipeline/tests/` (the file that tests `episode_links`), `pipeline/tests/fixtures/search/*.json` (each `cue_s` gains `page`; a result whose `links.page` is an Acast URL gains `seek`)
- Modify: `docs/deep-links.md` (a "Show page" entry: the format, tried on WT616 on 2026-10-09 in a desktop browser, an ad may play first)
- Check, and update where they assert on `cue_s` keys or page links: `worker/test/search-contract.test.ts`, `worker/test/context.test.ts`, `worker/test/search-*.test.ts`, `web/test/` fixtures (they are typed with `satisfies`, so `tsc` finds them)

**Interfaces:**
- Produces: `CueTimes` is `{ youtube: number; apple: number; spotify: number; page: number }`. `cueTimes(episode, hitMs).page === cueSeconds(hitMs, 0)`. `deepLinks(episode, hitMs).page` is `pageLink(episode.page_url, cueSeconds(hitMs, 0))`.
- `pageLink(pageUrl: string, cue: number): string` (exported from `links.ts`): when `new URL(pageUrl).hostname === "shows.acast.com"`, the same URL with the query parameter `seek` set to `cue` (replacing an existing `seek`, keeping other parameters and any fragment); otherwise, and when `pageUrl` does not parse, `pageUrl` unchanged.
- Pipeline: `episode_links(row, at_s)` adds `seek=<at_s>` to an Acast page the same way when `at_s` is given (no lead-in and no offset, like its other links); `at_s=None` leaves the page bare.

- [ ] **Step 1: Write the failing Worker tests** in `worker/test/links.test.ts`:

```ts
describe("pageLink", () => {
  it("adds seek to an Acast show page", () => {
    expect(pageLink("https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616", 1734)).toBe(
      "https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616?seek=1734",
    );
  });
  it("keeps other parameters and the fragment, and replaces an existing seek", () => {
    expect(pageLink("https://shows.acast.com/woodtalk/episodes/x?a=1&seek=5#notes", 90)).toBe(
      "https://shows.acast.com/woodtalk/episodes/x?a=1&seek=90#notes",
    );
  });
  it("passes any other host through unchanged", () => {
    expect(pageLink("https://example.com/ep/612", 90)).toBe("https://example.com/ep/612");
    expect(pageLink("https://shows.acast.com.evil.example/x", 90)).toBe("https://shows.acast.com.evil.example/x");
  });
  it("passes a URL that does not parse through unchanged", () => {
    expect(pageLink("not a url", 90)).toBe("not a url");
  });
  it("seeks to 0 at the start", () => {
    expect(pageLink("https://shows.acast.com/woodtalk/episodes/x", 0)).toBe(
      "https://shows.acast.com/woodtalk/episodes/x?seek=0",
    );
  });
});
```

Also: in `cueTimes`, `page` is `cueSeconds(hitMs, 0)` whatever the platform offsets are; in `deepLinks`, an Acast `page_url` carries `seek=<hit − 7>` and is not shifted by `offset_apple_s`; replace the existing "passes the page URL as is" test with the non-Acast case.

- [ ] **Step 2: Run and confirm they fail.** `cd worker && npx vitest run test/links.test.ts` — `pageLink` is not exported.

- [ ] **Step 3: Implement** in `worker/src/links.ts`:

```ts
/** The host whose episode pages take `?seek=<seconds>` (spec §4.6; tried on WT616, 2026-10-09). */
const ACAST_SHOW_HOST = "shows.acast.com";

/** The show page at the cue: `seek` added to an Acast show page, any other URL unchanged. */
export function pageLink(pageUrl: string, cue: number): string {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return pageUrl;
  }
  if (url.hostname !== ACAST_SHOW_HOST) return pageUrl;
  url.searchParams.set("seek", String(cue));
  return url.toString();
}
```

`cueTimes` gains `page: cueSeconds(hitMs, 0)`; `deepLinks` sets `links.page = pageLink(episode.page_url, cueSeconds(hitMs, 0))`. Add `page: number` to `CueTimes` in `api-types.ts` with the comment "the show page plays the show's own timeline: the lead-in, no offset". Update the file's header comment where it says the page has no cue.

- [ ] **Step 4: Fix what the type change breaks.** `cd worker && npx tsc --noEmit` and `cd web && npm run typecheck`: add `page` to every `cue_s` literal in tests and fixtures the compiler names. Update `pipeline/tests/fixtures/search/*.json` so each `cue_s` has `page` (the contract test compares key sets).

- [ ] **Step 5: Pipeline, test-first.** Add tests beside the existing `episode_links` tests: an Acast page with `at_s=1741` ends `?seek=1741`; with `at_s=None` it is bare; a non-Acast page is unchanged with or without a time. Then implement in `pipeline/src/wts/links.py` with `urllib.parse` (`urlsplit`, `parse_qsl`, `urlencode`, `urlunsplit`), matching `pageLink` (replace an existing `seek`, keep the rest and the fragment). Update the module docstring.

- [ ] **Step 6: Run everything.** `cd worker && npm test && npx tsc --noEmit` (count was 485; expect it to rise by the new tests); `cd pipeline && uv run pytest -q && uv run ruff check .`; `cd web && npm test && npm run typecheck`.

- [ ] **Step 7: Commit** (main session). `worker, pipeline: the show page link plays from the cue (seek) and has a cue time`

---

### Task B: One play control per hit; the header above the card

**Files:**
- Modify: `web/src/lib/platforms.ts`, `web/src/components/{HitRow,MoreMenu,ResultCard}.tsx`, `web/src/styles/components.css`
- Delete: `web/src/components/PlayButtons.tsx` (move `PlayIcon` into `HitRow.tsx`)
- Modify tests: `web/test/result-card.test.tsx`, `web/test/result-list.test.tsx`, `web/e2e/result-cards.spec.ts`, and any fixture or helper they share

**Interfaces:**
- Consumes (Task A): `SearchResult.cue_s.page: number`; `episode.links.page` already carries `seek` when it can.
- Produces, in `web/src/lib/platforms.ts`:
  - `type PlayKey = "youtube" | "page" | "apple" | "spotify"`.
  - `interface PlayLink { key: PlayKey; name: string; href: string; cue: string }` (`name`: "YouTube", "the show page", "Apple", "Spotify"; `cue` is `timestamp(hit.cue_s[key])`).
  - `primaryPlay(hit: SearchResult): PlayLink | null` — the YouTube link when the episode has one, else the page link, else `null`. **Task 10 uses this for the transcript's timestamp links.**
  - `menuPlays(hit: SearchResult): PlayLink[]` — in order: the page (left out when `primaryPlay` is the page), Apple, Spotify; only those in `episode.links`.
  - `chipName(play: PlayLink, time: string): string` — "Play on YouTube 29:01, starts at 28:54"; for the page, "Play on the show page 29:01, starts at 28:54, may play an ad first". The ", starts at …" part is left out when `play.cue === time`.
  - `menuName(play: PlayLink, time: string): string` — the row's visible words in order: "Show page plays from 29:01, may play an ad first"; "Play on Apple at 29:01 · may start minutes early"; with ", starts at 28:20" added when the cue differs from `time`.
  - `hitTime(hit)` stays. `platformsOf`, `playName` and the `Shown` type are removed.
- `MoreMenu` props become `{ plays: PlayLink[]; time: string; onMore: () => void; onReport: () => void }` (`extra` and `pageHref` go).
- `HitRow` loses its `phone` prop if nothing else in it needs it; `ResultCard` and `ResultList` stop passing it, and `lib/use-phone.ts` is deleted if it has no caller left (say which in the report).

**Layout (spec §5.3; mock option A):**
- `ResultCard`: the `<li class="result" data-result>` stays the list item, the keyboard stop and the labelled element. Inside it: the header (`.result__head`, on the page background, `padding: 0 4px 8px`, title 16 px) and then a new `<div class="result__card">` holding the hit rows, which takes the surface, border, radius (`--r-dense`) and `12px 14px` padding the `<li>` has today. `.results` gap becomes 26 px. A related card keeps its dashed border and muted excerpt on `.result__card`; the "Related" tag stays in the header.
- `HitRow` desktop: a three-column grid, `68px minmax(0, 1fr) 30px`: chip, excerpt, ⋯ (aligned to the excerpt's first line). "+N nearby" is on a second grid row under the excerpt, only when `hit.folded.length > 0`. No `.hit__actions` row, no pills, no ⓘ, no ads note.
- `HitRow` phone (below 600 px, by CSS media query on the same DOM): two columns, `minmax(0, 1fr) 30px`; the chip on its own first row at its natural width, then the excerpt, then "+N nearby". The chip is at least 44 px tall on a phone (touch target).
- The chip is an `<a class="hit__time" target="_blank" rel="noopener">` with `href`, `aria-label` and `title` from `primaryPlay`/`chipName`; with no play link it is `<span class="hit__time hit__time--text">`.
- Menu rows: each play link is `<a role="menuitem" target="_blank" rel="noopener">` with the visible words from the copy constraint and `aria-label={menuName(…)}`; a rule after the play links when there are any; then More transcript and Report as now. Focus returns to ⋯ after any choice, as now.
- Delete the CSS for `.play`, `.play--primary`, `.play__time`, `.ads-info`, `.hit__note`, `.hit__actions`, `.hit__links` and anything else left without a user.

- [ ] **Step 1: Write the failing tests.**
  - `platforms` (a new `web/test/lib/platforms.test.ts`): `primaryPlay` for an episode with YouTube and a page (YouTube), with a page only (the page), with Apple only (`null`), with nothing (`null`); `menuPlays` for the same four (page + Apple + Spotify; Apple + Spotify without the page; Apple; empty); `chipName` and `menuName` for each key with a differing and an equal cue; every name contains its visible words in order.
  - `result-card.test.tsx`: the chip is a link named "Play on YouTube 1:09:51, starts at 1:09:44" with the YouTube `href`, `target="_blank"`, `rel="noopener"`; with a page only it is named "Play on the show page …, may play an ad first" and has the page `href`; with neither it is text and not a link; no element has the classes `play` or `ads-info`; the menu lists Show page, Play on Apple, Play on Spotify, More transcript, Report transcript error in that order with the sub-lines from the copy constraint; with a page-only episode the menu has no "Show page"; with no links at all the menu still opens with More transcript and Report; the header is outside `.result__card` and the `<li>` is labelled by it; "+2 nearby" is present only when `folded` is non-empty.
  - Replace the Task 9 tests that asserted pills, the ⓘ and phone-versus-desktop DOM differences; do not keep a weakened copy.
  - e2e (`web/e2e/result-cards.spec.ts`, under the real CSP): at 1280 px and at 390 px the chip is visible and links to the fixture's play URL; the menu, opened by keyboard, has the same rows at both widths; at 390 px nothing overflows the viewport (`scrollWidth <= clientWidth` on `documentElement`) and the chip's box is at least 44 px tall; no CSP violation.
- [ ] **Step 2: Run and confirm they fail.** `cd web && npx vitest run test/lib/platforms.test.ts test/result-card.test.tsx`.
- [ ] **Step 3: Implement** `platforms.ts`, then `MoreMenu`, `HitRow`, `ResultCard`, then the CSS; delete `PlayButtons.tsx`.
- [ ] **Step 4: Run** `cd web && npm test && npm run typecheck && npm run e2e`.
- [ ] **Step 5: Commit** (main session). `web: one play control per hit, other platforms in the menu, episode header above the card`

---

## After both tasks

- Update `docs/HANDOFF.md` (what changed in the card, the new `cue_s.page`, that plan 3 Task 10 uses `primaryPlay`), and plan 3's Task 9/10 text where it describes pills and "the first platform".
- Deploy to staging (`cd worker && npm run deploy:staging`, the maintainer's call) and check on a phone: the chip's link lands at the passage on YouTube and on the show page, and the menu's rows fit.
