# Round 2: phone layout, Exact / Related (beta)

Answers `docs/design/BRIEF-2-phone.md`. The reference screens are in `Wood Talk Search.dc.html` → section 5 (frames 5a–5r, light and dark); the component is `PhoneScreen2.dc.html` (prop `s`: start · exact · related · none · few · years · sheet · compact; `desktop`). Everything in `README.md` still holds unless this file says otherwise.

## New tokens (`tokens.css`)
These are the colours for Related: **weathered oak**, a grey-brown that is the coolest wood tone. It's meant to read as "a different mode" next to the warm walnut Exact cards, not as an error or a disabled state.

| token | light | dark | use |
|---|---|---|---|
| `--rel` | #5E584E | #BEB7AB | Related text, chip text, BETA tag (≥4.5:1 on `--bg` and `--rel-bg`) |
| `--rel-bg` | #EFECE6 | #1D1B18 | Related card fill, "See related" button |
| `--rel-border` | #CEC8BD | #3E3A34 | Related card border, BETA tag border |
| `--rel-tint` | #E2DDD4 | #2D2A25 | Related time chip, "≈ Related" pill |

## 1. Header, phone (360–430px)
- **Brand row:** "Wood Talk Search" 17px/750, then "Unofficial · fan-made" 13px muted.
- **Search row**, gap 8px:
  - Input: 50px tall, radius 12, clear button 40px.
  - Placeholder: `Search {N} episodes`, with N formatted (37, 1,234).
  - Search button: padding 0 16px.
- **Controls row:** one line, gap 8px, no wrapping.
  - **Mode switch** (role=radiogroup): `flex:1`, 44px tall, 3px padding, radius 12, track `--skel`. Each segment takes `flex:1`, radius 9px, text 15px/650.
    - Selected segment: `--bg` fill, shadow `0 1px 2px rgba(40,20,5,.18)`, text `--text`. Unselected: text `--muted`.
    - Labels: "Exact" and "Related" + BETA tag. Accessible name of the second: "Related, beta".
  - **Sort & years button:**
    - Size and type: 44px tall, padding 0 12px, radius 12, gap 7px, 14px/600, nowrap.
    - Contents: 16px sliders icon + year label ("Any year" / "2015–2020").
    - Year set: fill `--tint`, border `--accent` at 45%, text `--accent`.
    - Sort not Relevance: a 6px dot in the current text colour.
    - `aria-haspopup="dialog"`, `aria-label="Sort and years: Newest, 2015–2020"`.
  - Width at 358px with the year set: switch ≈ 234px, button ≈ 116px.
- **`?` help** moves out of the row and into the summary line as a "Tips ?" link (below).
- **Desktop (≥600px):** the switch is 280px wide, followed by a separate sort menu (38px) and year chip (38px pill). `?` is the same "Tips" link as on phone.

## Sort & years sheet (phone)
- Bottom sheet over a scrim of `rgba(15,8,3,.5)`.
- Sheet: fill `--raised`, radius 20 20 0 0, padding 8 16 28px, gap 18px, 36×5px grabber at the top.
- Title row: "Sort & years" 18px/700, "Done" on the right (accent, 44px).
- **Sort:** 13px caps label, then a 3-way segmented control (Relevance / Newest / Oldest), 44px, styled like the mode switch.
- **Years:** 13px caps label with an "Any year" reset link on the right. From / To selects, 48px, radius 12, 17px text, `--bg` fill.
- **"Show results":** full width, 50px, accent.
- The sheet still writes `year:2015-2020` into the query box. Esc and scrim tap close it. Focus is trapped inside while it's open.

## Compact header (phone, scrolled)
- Search row at 46px.
- Below it, a 40px summary button, 14px/600 `--muted`: "Exact · Relevance · Any year ▾".
  - In Related mode: "Related" in `--rel` plus the BETA tag.
  - A set year is shown in `--accent`.
- Tapping it scrolls back to the full header.
- Width check: "Related BETA · Newest · 2015–2020 ▾" ≈ 300px, which fits 358.

## Summary line
- Left side: 14px `--muted`.
  - Exact: "**57 matches** · page 1 of 3".
  - Related: "Related BETA · top results 1–20".
- Right side, gap 14px:
  - "How this works" (Related only, `--rel`).
  - "Tips ?" (`--accent`): a 14px/600 link plus an 18px outlined circle with "?". Both links are 44px tall to tap (12px vertical padding).

## 2. Start page
- **Heading:** "Find the moment it was said.", 24px serif 600, `white-space:nowrap`, so it's one line at 360px. Desktop: 36px.
- **TRY:** 13px caps label, then a **list**. Each row: 52px, 17px `--text`, a 16px → in `--accent` on the right, hairlines between rows and at the bottom.
- Examples: "hide glue", "split-top Roubo", "sharpening a card scraper".
- "37 episodes indexed through Oct 7, 2026", 14px muted.

## 3. Episode line and card
- **Episode line**, on the page background, padding 0 2px, gap 3px:
  - **Meta line:** 13px muted, nowrap, tabular numerals, min-height 22px, gap 6px.
    - Pieces in order: `Ep. 606` (or `Bonus`, `--accent`, 700) · date · `2 matches` (only when there's more than 1).
  - **Title:** 17px/650, line-height 1.3, `text-wrap:pretty`, clamped to 2 lines.
  - With this order, short and long titles, with or without "N matches", all keep the same shape.
- **Card:** radius 14px.
  - Keyword: `--surface` fill, `--border` border, `--shadow`.
  - Related mode (every card): `--rel-bg` fill, `--rel-border` border, no shadow.
  - Gap between episodes: 22px. Gap from the episode line to its card: 8px.
- **Hit row:** padding 12 14 14px, gap 8px. Rows after the first get a 1px top rule (`--border` or `--rel-border`).
  - Top line: **time chip** (36px tall, padding 0 12px, radius 8, 15px/700 tabular, ▶ icon) on the left, **⋯** (44×44, −10px right margin) on the right.
    - Keyword chip: `--tint` / `--accent`. Related chip: `--rel-tint` / `--rel`.
  - **Excerpt:** full card width, serif 17px, line-height 1.55, clamped to 3 lines, **`--text` for both kinds**. Tapping it opens the passage.
  - "+N nearby": 14px/600, underlined, 36px tall, in the chip colour.

## 4. Telling the two modes apart
Related (beta) lists **only** related (meaning) passages. They are never mixed with Exact results, so cards carry no per-card "Related" pill. The difference is mode-wide:
- Every card in Related mode uses the oak set: fill, border, time chip, and no shadow. Exact cards keep the warm surface and shadow.
- The excerpt is not muted and the border is not dashed, so nothing looks disabled or broken.
- The mode is also named in the switch, the summary line and the compact header. ≈ marks the "See related passages" button.

## BETA treatment
- One tag: "BETA", 10px/750, letter-spacing .06em, padding 2 4 1px, radius 4, 1px `--rel-border`, `--rel` text.
- Used in: the switch segment, the summary line, the compact header, and the "See related passages" button. Screen readers get "beta" in the accessible name, not the tag.

## Exact: few or no results
- **"See related passages" button:** full width, 50px, radius 12. `--rel-bg` fill, `--rel-border` border, `--rel` text 16px/650. Content: ≈ + "See related passages" + BETA.
- **Fewer than 5 matches:** below the list, "**Only 3 exact matches.** Related passages match the meaning, not just the words." (15px), then the button. No pager.
- **No results:**
  - "Nothing found." 28px serif.
  - "No passage has those exact words." 16px muted.
  - The button.
  - "Or use fewer words, or check the spelling." 15px muted.

## Episodes row (Exact title matches)
- "EPISODES" 13px caps label, then rows of 10px vertical padding with hairlines between.
- Each row:
  - Meta line: `Ep. 590 · May 30, 2023`.
  - Title: 16px/650, matched words in `<mark>`.
  - A 44×44 "Search this episode" icon button on the right (replaces the text link).
