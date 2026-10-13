# Design brief 2 — the phone layout, and Exact / Related (beta)

For Claude Design: a second, small round on the design in `docs/design/system/`. The first
brief (`BRIEF.md`) and the system's `README.md` still hold except where this one says
otherwise; the engineering spec (`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`
§5) wins if they disagree. Written 2026-10-12, after the maintainer used the built site on an
iPhone (390 px wide).

**Attach the captures in `round-2/`** with this brief: the site as built on a 390 px phone,
dark and light, with test data. They are what to redesign; the first round's mocks no longer
show the site (§1).

| File (`phone-dark-…`, `phone-light-…`) | Shows |
|---|---|
| `before-any-search` | the controls row on two lines, the "Try" chips (§2 items 1–2) |
| `related-results` | Related (beta): its intro line and three cards, one with a long title (§2 items 3–4) |
| `no-results-in-related` | "No related passages." and "See exact matches" |
| `degraded-unavailable` | Related when meaning search is down: the notice and its button |
| `exact-with-title-matches` | Exact: the "Episodes" row, a long title above a card (§2 item 3) |
| `exact-with-only-a-few-matches` | "Only 3 exact matches." and its button |
| `exact-with-a-year-range-set` | the controls row at its widest |
| `no-results-in-exact` | "Nothing found." and "See related passages (beta)" |

The maintainer's own iPhone screenshots show the same with the browser's bars and the keyboard.
(`cd web && npm run e2e:shots` makes these and every other state, into `web/screenshots/`.)

## 1. What changed since the first round

These are decided; design with them, not around them.

- **The modes are now Exact and Related (beta), and Exact is the default.** Exact lists the
  passages that contain the words, with a count. Related (beta) lists passages about the same
  thing that do **not** contain all the words (some may contain one of them), best first,
  with no count; nothing appears in both.
  It is opt-in because the meaning results are still uneven. The switch reads **Exact |
  Related (beta)**, Exact first. (The first round's "Smart", one list mixing both kinds, is
  set aside.)
- **Related has its own empty and failed states.** Nothing to show: "No related passages." and
  a button "See exact matches". Meaning search down or paused: a notice, "Related search is
  unavailable right now." / "Related search is paused.", with the same button.
- **Exact offers the way across when it finds little.** With no result: "Nothing found." and a
  button "See related passages (beta)". With fewer than 5 matches: "Only N exact matches." and
  the same button, under the list.
- **The result card is not the first round's dense card any more** (spec §5.3): the episode
  line ("Ep. 616 · Should I Buy A Jointer?", then "3 matches · Oct 7, 2026") sits above the
  card on the page background; the card holds only hit rows; each row is a time chip that
  plays, the excerpt (3 lines, tap to open the passage), and ⋯. No row of platform pills.
  A card in Related looks like a card in Exact: the first round's dashed border, "Related"
  pill and muted excerpt are gone, since a list no longer holds both kinds. Related's first
  page opens with a line, "Passages about the same thing that don't contain all your words:".
- **The search box's placeholder** carries the real number of episodes, which is not always
  three digits ("Search 37 episodes", later "Search 1,234 episodes").

## 2. What does not work on a phone

The maintainer's words: "not a fan of all the wrapping. The option cards, the title, the
'try' stuff."

1. **The controls row does not fit.** Exact | Related (beta), the sort menu ("Best match ▾"),
   the year chip ("Any year", or "2015–2020 ×" when set) and the `?` help need about 390 px
   at the first round's sizes with "Smart"; a 390 px screen has 358. So `?` drops to a line of
   its own, and "Related (beta)" is a longer label than "Smart". The row needs a layout that
   holds at 360–430 px with the year set, with 44 px touch targets. Open to: `?` moving
   elsewhere, the sort becoming an icon or joining a menu, a shorter mode label on phones, a
   different control for the mode altogether.
2. **The "Try" examples wrap raggedly.** Three chips ("hide glue", "split-top Roubo", "how do
   I sharpen a card scraper") cannot share a row. Open to a list, a scrolling row, or
   something else; the examples themselves can change.
3. **The episode line above a card wraps into two or three uneven lines** when the title is
   long: "Ep. 606 · It's Tiny But It's Better Than Nothing" breaks, and the date lands on a
   line of its own beside or under it. It needs one arrangement that looks intended for a
   short title and a long title, with and without "3 matches".
4. **Which tab am I in?** The two tabs now show the same kind of card, so the switch, the
   summary line and Related's intro line are all that say whether these are exact matches or
   related passages. Wanted: a calm way to make a Related page read as Related at a glance
   (after scrolling too), and nothing that reads as an error or as disabled.

## 3. Also wanted

- **"(beta)" as a treatment**, not only as text in a label: how it shows in the switch, in the
  summary line ("Related (beta) · top results 1–20"), and on the button that leads there from
  Exact.
- **The compact header** (phone, scrolled) shows the search row and one summary button
  ("Exact · Best match · Any year ▾"); check it with "Related (beta)" and a set year.
- The start page's heading ("Find the moment it was said.") must stay on one line on a phone.

## 4. Deliverable

The phone screens (light and dark) for: the start page; Exact results with a long and a short
title; Related (beta) results; no results in Exact and in Related; Related unavailable; "Only
3 exact matches."; the header with a year set; the compact header. Desktop only where the same
component changes. Measurements in the README's style, and updated `.dc.html` files if the
components change.
