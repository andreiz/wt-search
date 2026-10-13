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
| `keyword-and-related-results` | Related (beta): a keyword card, then two related ones (§2 items 3–4) |
| `exact-with-title-matches` | Exact: the "Episodes" row, a long title above a card (§2 item 3) |
| `exact-with-only-a-few-matches` | "Only 3 exact matches." and its button |
| `exact-with-a-year-range-set` | the controls row at its widest |
| `no-results-in-exact` | "Nothing found." and "See related passages (beta)" |

The maintainer's own iPhone screenshots show the same with the browser's bars and the keyboard.
(`cd web && npm run e2e:shots` makes these and every other state, into `web/screenshots/`.)

## 1. What changed since the first round

These are decided; design with them, not around them.

- **The modes are now Exact and Related (beta), and Exact is the default.** Exact lists the
  passages that contain the words, with a count. Related (beta) is what Smart was: keyword and
  meaning results in one ranked list, the meaning ones marked "Related". It is opt-in because
  the meaning results are still uneven. The switch reads **Exact | Related (beta)**, Exact
  first.
- **Exact offers the way across when it finds little.** With no result: "Nothing found." and a
  button "See related passages (beta)". With fewer than 5 matches: "Only N exact matches." and
  the same button, under the list.
- **The result card is not the first round's dense card any more** (spec §5.3): the episode
  line ("Ep. 616 · Should I Buy A Jointer?", then "3 matches · Oct 7, 2026") sits above the
  card on the page background; the card holds only hit rows; each row is a time chip that
  plays, the excerpt (3 lines, tap to open the passage), and ⋯. No row of platform pills.
  Related cards have a dashed border, a "Related" pill by the date and a muted excerpt.
- **The search box's placeholder** carries the real number of episodes, which is not always
  three digits ("Search 37 episodes", later "Search 1,234 episodes").

## 2. What does not work on a phone

The maintainer's words: "not a fan of all the wrapping. The option cards, the title, the
'try' stuff."

1. **The controls row does not fit.** Exact | Related (beta), the sort menu ("Relevance ▾"),
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
   long: "Ep. 606 · It's Tiny But It's Better Than Nothing" breaks, and "Related" and the
   date land on a line of their own beside or under it. It needs one arrangement that looks
   intended for a short title, a long title, with and without "Related", with and without
   "3 matches".
4. **Keyword and related results look too alike in one list.** In Related (beta) the two
   kinds are interleaved in rank order (that is fixed: folding the related ones away was
   tried and swallowed whole pages). A dashed border, a small pill and a slightly muted
   excerpt are not enough to tell them apart at a glance in dark mode. Wanted: a stronger but
   still calm difference, and nothing that reads as an error or as disabled.

## 3. Also wanted

- **"(beta)" as a treatment**, not only as text in a label: how it shows in the switch, in the
  summary line ("Related (beta) · top results 1–20"), and on the button that leads there from
  Exact.
- **The compact header** (phone, scrolled) shows the search row and one summary button
  ("Exact · Relevance · Any year ▾"); check it with "Related (beta)" and a set year.
- The start page's heading ("Find the moment it was said.") must stay on one line on a phone.

## 4. Deliverable

The phone screens (light and dark) for: the start page; Exact results with a long and a short
title; Related (beta) results with both kinds of card; no results in Exact; "Only 3 exact
matches."; the header with a year set; the compact header. Desktop only where the same
component changes. Measurements in the README's style, and updated `.dc.html` files if the
components change.
