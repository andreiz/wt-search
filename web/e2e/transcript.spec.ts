// More transcript and "+N nearby" in the built page under the real CSP (spec §5.4), with
// /api/search and /api/context stubbed: opening from "+N nearby" and from ⋯, the hit's paragraph
// emphasised, folded ones labelled "Nearby match", collapsing with focus back on the opener, and
// no overflow at 1280 and 390 px.
import { expect, test, type Page } from "@playwright/test";

const FIRST_TEXT = "All right, the great folks over at Highland Woodworking have the HVLP sprayer on sale.";
const EPISODE_LINKS = {
  youtube: "https://www.youtube.com/watch?v=abc&t=4184s",
  apple: "https://podcasts.apple.com/us/podcast/x/id1?i=2&t=4184",
  spotify: "https://open.spotify.com/episode/3?t=4184",
  page: "https://example.com/ep/71",
};
const EPISODE = { id: 71, number: 71, title: "Welcome to the Three-Way", date: "2010-06-10", links: EPISODE_LINKS };

/** The `[start, end)` range of the first `word` in `text`. */
function at(text: string, word: string): [number, number] {
  const start = text.indexOf(word);
  return [start, start + word.length];
}

const result = {
  episode: EPISODE,
  chunk_id: 1,
  text: FIRST_TEXT,
  ranges: [at(FIRST_TEXT, "HVLP"), at(FIRST_TEXT, "sprayer")],
  hit_ms: 4_191_000,
  cue_s: { youtube: 4184, apple: 4184, spotify: 4184, page: 4184 },
  match: "keyword",
  more_in_episode: 2,
  folded: [9, 10],
};

// Nine chunks 30 s apart, ending at the hit's neighbourhood; the hit is the fourth. Radius 3 gives
// the seven around it. Chunks 9 and 10 are the folded hits; both also say "sprayer", which the
// answer marks (the endpoint marks the query's words in every chunk).
const IDS = [20, 21, 22, 1, 9, 23, 10, 24, 25];
function chunk(index: number, base = 4_100) {
  const id = IDS[index]!;
  const start = base + index * 30;
  const cue = start - 7;
  const text =
    id === 1 ? FIRST_TEXT : id === 9 || id === 10 ? `Another word about the sprayer, chunk ${id}.` : `Plain talk in chunk ${id}.`;
  return {
    chunk_id: id,
    seq: index,
    start_ms: start * 1000,
    end_ms: (start + 30) * 1000,
    text,
    ranges: id === 9 || id === 10 ? [at(text, "sprayer")] : id === 1 ? result.ranges : [],
    boilerplate: false,
    cue_s: { youtube: cue, apple: cue, spotify: cue, page: cue },
    links: { ...EPISODE_LINKS, youtube: `https://www.youtube.com/watch?v=abc&t=${cue}s` },
  };
}
function context(radius: number, base = 4_100) {
  const hit = 3;
  const chunks = IDS.map((_, i) => i)
    .filter((i) => Math.abs(i - hit) <= radius)
    .map((i) => chunk(i, base));
  return { chunk_id: 1, episode: EPISODE, chunks };
}

async function open(page: Page, base = 4_100) {
  // The hit is the fourth chunk, 90 s on from the first; its time is 1 s into it (4191 s, 1:09:51, at the default base).
  const hitResult = { ...result, hit_ms: (base + 91) * 1000 };
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(msg.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective);
    });
  });
  const radii: string[] = [];
  await page.route("**/api/search*", (route) =>
    route.fulfill({ json: { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results: [hitResult] } }),
  );
  await page.route("**/api/context*", (route) => {
    const radius = new URL(route.request().url()).searchParams.get("radius")!;
    radii.push(radius);
    return route.fulfill({ json: context(Number(radius), base) });
  });
  await page.goto("/?q=sprayer");
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  return {
    radii,
    async clean() {
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
      expect(problems).toEqual([]);
    },
  };
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

const WIDTHS = [
  { name: "a desktop (1280 px)", width: 1280, height: 800 },
  { name: "a phone (390 px)", width: 390, height: 800 },
];

for (const { name, width, height } of WIDTHS) {
  test.describe(`the expanded transcript on ${name}`, () => {
    test.use({ viewport: { width, height } });

    test("'+2 nearby' opens the wider view under the row: the hit emphasised, folded ones labelled", async ({ page }) => {
      const { radii, clean } = await open(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      const nearby = card.getByRole("button", { name: "+2 nearby" });
      await expect(nearby).toHaveAttribute("aria-expanded", "false");
      await nearby.click();

      const region = card.getByRole("region", { name: "Transcript around 1:09:51" });
      await expect(region).toBeVisible();
      await expect(region).toBeFocused();
      await expect(nearby).toHaveAttribute("aria-expanded", "true");
      expect(radii).toEqual(["6"]);

      // It replaces the hit's chip and excerpt (the hit's text shows once, in its own row), takes
      // the row's width, and sits inside the card's box under "+2 nearby" and ⋯.
      await expect(card.locator(".hit__excerpt")).toHaveCount(0);
      await expect(card.locator(".hit__time")).toHaveCount(0);
      const rowBox = (await card.locator(".hit").boundingBox())!;
      const regionBox = (await region.boundingBox())!;
      const cardBox = (await card.locator(".result__card").boundingBox())!;
      const nearbyBox = (await nearby.boundingBox())!;
      const moreBox = (await card.getByRole("button", { name: "More actions" }).boundingBox())!;
      // The strip is pinned under the site header, so the view's top may be scrolled above it: the
      // order is the strip's DOM position (the view follows it), not their boxes' tops.
      expect(await card.locator(".hit__strip").evaluate((el) => el.nextElementSibling?.classList.contains("transcript"))).toBe(true);
      expect(moreBox.x).toBeGreaterThanOrEqual(nearbyBox.x + nearbyBox.width);
      expect(regionBox.y + regionBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
      expect(rowBox.y).toBeLessThanOrEqual(nearbyBox.y);
      expect(regionBox.width).toBeGreaterThanOrEqual(rowBox.width - 12 - 0.5);

      const rows = region.getByRole("listitem");
      await expect(rows).toHaveCount(9);
      // The hit's paragraph: on the tint, the result's highlights. The nearby paragraphs that
      // have the query's word are marked too (lighter), the plain ones are not.
      const hit = region.locator(".passage--hit");
      await expect(hit).toHaveCount(1);
      await expect(hit.locator("mark")).toHaveText(["HVLP", "sprayer"]);
      await expect(region.locator("mark")).toHaveCount(4);
      await expect(region.locator(".passage--fold mark")).toHaveText(["sprayer", "sprayer"]);
      await expect(region.locator(".passage:not(.passage--fold):not(.passage--hit) mark")).toHaveCount(0);
      const hitMarkBg = await hit.locator("mark").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      const nearMarkBg = await region.locator(".passage--fold mark").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(nearMarkBg).not.toBe(hitMarkBg);
      const hitBg = await hit.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hitBg).toBe("rgb(243, 230, 218)");
      // The folded ones: a lighter tint and the label.
      const folded = region.locator(".passage--fold");
      await expect(folded).toHaveCount(2);
      await expect(folded.getByText("Nearby match")).toHaveCount(2);
      await expect(region.getByText("Nearby match")).toHaveCount(2);
      const foldBg = await folded.first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(foldBg).not.toBe(hitBg);
      expect(foldBg).not.toBe("rgba(0, 0, 0, 0)");
      // The others have no fill.
      expect(await rows.first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

      // Timestamp labels play on YouTube from the chunk's own link, named around the visible time.
      const label = rows.nth(3).getByRole("link");
      await expect(label).toHaveText("1:09:50");
      await expect(label).toHaveAccessibleName("Play on YouTube 1:09:50, starts at 1:09:43");
      await expect(label).toHaveAttribute("href", /watch\?v=abc&t=4183s/);
      await expect(label).toHaveAttribute("target", "_blank");

      // Numbered episode: the search button is there.
      await expect(region.getByRole("button", { name: "Search this episode ep:71" })).toBeVisible();

      expect(await noOverflow(page)).toBe(true);
      const regionRight = (await region.boundingBox())!.x + (await region.boundingBox())!.width;
      expect(regionRight).toBeLessThanOrEqual(width);

      // Collapse: back to the excerpt, focus on "+2 nearby".
      await region.getByRole("button", { name: "Show less" }).click();
      await expect(region).toHaveCount(0);
      await expect(nearby).toHaveAttribute("aria-expanded", "false");
      await expect(nearby).toBeFocused();
      // The excerpt and the chip are back.
      await expect(card.locator(".hit__excerpt")).toHaveCount(1);
      await expect(card.locator("a.hit__time")).toHaveCount(1);
      await clean();
    });

    test("More transcript in ⋯ opens the narrower view by keyboard; Esc in the menu closes the menu, Esc in the view collapses it to ⋯", async ({ page }) => {
      const { radii, clean } = await open(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      const more = card.getByRole("button", { name: "More actions" });
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem").first()).toBeFocused();
      // Show page, Apple, Spotify, then More transcript.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const item = page.getByRole("menuitem", { name: "More transcript" });
      await expect(item).toBeFocused();
      await page.keyboard.press("Enter");

      const region = card.getByRole("region", { name: "Transcript around 1:09:51" });
      await expect(region).toBeFocused();
      expect(radii).toEqual(["3"]);
      await expect(region.getByRole("listitem")).toHaveCount(7);
      await expect(region.locator(".passage--hit mark")).toHaveText(["HVLP", "sprayer"]);
      // The folded chunks sit in the radius 3 range but are only marked in the wider view.
      await expect(region.getByText("Nearby match")).toHaveCount(0);
      expect(await noOverflow(page)).toBe(true);

      // The menu says the view is open.
      await more.click();
      await expect(page.getByRole("menuitem", { name: "More transcript" })).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();

      // Tab on from ⋯ reaches "+2 nearby", then the labels and the buttons in the view.
      await page.keyboard.press("Tab");
      await expect(card.getByRole("button", { name: "+2 nearby" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(card.getByRole("button", { name: "Show less transcript" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(region.getByRole("link").first()).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(region).toHaveCount(0);
      await expect(more).toBeFocused();
      await clean();
    });

    test("reopening the same view does not fetch again; the wider one fetches once more", async ({ page }) => {
      const { radii } = await open(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      const excerpt = card.locator(".hit__excerpt");
      await excerpt.click();
      const region = card.getByRole("region");
      await expect(region.getByRole("listitem")).toHaveCount(7);
      await region.getByRole("button", { name: "Show less" }).click();
      await excerpt.click();
      await expect(region.getByRole("listitem")).toHaveCount(7);
      await card.getByRole("button", { name: "+2 nearby" }).click();
      await expect(region.getByRole("listitem")).toHaveCount(9);
      expect(radii).toEqual(["3", "6"]);
    });
  });
}

test.describe("the timestamp labels on a phone (390 px)", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  // 1:09:50 (an hour-long show) and 10:00:00 and later (the longest label there is).
  for (const base of [4_100, 36_000]) {
    test(`fit their column and stay clear of the text (first chunk at ${base} s)`, async ({ page }) => {
      await open(page, base);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      await card.getByRole("button", { name: "+2 nearby" }).click();
      const region = card.getByRole("region");
      await expect(region.getByRole("listitem")).toHaveCount(9);
      const labels = region.locator(".passage__time");
      await expect(labels).toHaveCount(9);
      const first = await labels.first().textContent();
      expect(first).toBe(base === 36_000 ? "10:00:00" : "1:08:20");
      for (let i = 0; i < 9; i++) {
        const label = labels.nth(i);
        const fits = await label.evaluate((el) => el.scrollWidth <= el.clientWidth);
        expect(fits, `label ${i} fits`).toBe(true);
        const labelBox = (await label.boundingBox())!;
        const textBox = (await region.getByRole("listitem").nth(i).locator(".passage__body").boundingBox())!;
        expect(labelBox.x + labelBox.width, `label ${i} clear of the text`).toBeLessThanOrEqual(textBox.x);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
});

// Keeping the reader's place: a results page tall enough to scroll (eight cards), and a stubbed
// context with long paragraphs, so opening puts a lot above the hit's paragraph.
const LONG = "Talking about the sprayer and the finish and how long it takes to dry in a cold shop, ".repeat(3);
function tallResult(i: number) {
  return {
    ...result,
    episode: { ...EPISODE, id: 100 + i, number: 100 + i },
    chunk_id: i * 100,
    text: `Result number ${i}. ${FIRST_TEXT}`,
    ranges: [],
    folded: [i * 100 + 1],
    more_in_episode: 1,
  };
}
function tallContext(hit: number, radius: number) {
  const chunks = [];
  for (let id = hit - radius; id <= hit + radius; id++) {
    const start = 4_100 + (id - hit + radius) * 30;
    const cue = start - 7;
    chunks.push({
      chunk_id: id,
      seq: id - hit + radius,
      start_ms: start * 1000,
      end_ms: (start + 30) * 1000,
      text: id === hit ? tallResult(hit / 100).text : `Chunk ${id}. ${LONG}`,
      boilerplate: false,
      ranges: [],
      cue_s: { youtube: cue, apple: cue, spotify: cue, page: cue },
      links: EPISODE_LINKS,
    });
  }
  return { chunk_id: hit, episode: EPISODE, chunks };
}

/** Two animation frames and a bit more, so a scroll and the correction on the next frame are done. */
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))),
  );

async function openTall(page: Page) {
  await page.route("**/api/search*", (route) =>
    route.fulfill({
      json: { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results: [1, 2, 3, 4, 5, 6, 7, 8].map(tallResult) },
    }),
  );
  await page.route("**/api/context*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: tallContext(Number(params.get("chunk")), Number(params.get("radius"))) });
  });
  await page.goto("/?q=sprayer");
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
}

for (const { name, width, height } of WIDTHS) {
  test.describe(`keeping the reader's place on ${name}`, () => {
    test.use({ viewport: { width, height } });

    test("the matched text stays where it was on open and on collapse (top Show less)", async ({ page }) => {
      await openTall(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(4);
      const excerpt = card.locator(".hit__excerpt");
      await excerpt.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      const before = (await excerpt.boundingBox())!.y;

      // A click on the excerpt: the narrower view, three paragraphs above the hit's.
      await excerpt.click();
      const hit = card.locator(".passage--hit");
      await expect(hit).toBeVisible();
      await settle(page);
      const opened = (await hit.boundingBox())!.y;
      expect(Math.abs(opened - before)).toBeLessThanOrEqual(2);

      // The strip is pinned under the header, so Show less is right there: no scrolling to it.
      await card.getByRole("button", { name: "Show less transcript" }).click();
      await expect(card.locator(".transcript")).toHaveCount(0);
      await settle(page);
      const after = (await excerpt.boundingBox())!.y;
      expect(Math.abs(after - opened)).toBeLessThanOrEqual(2);
      await expect(card.getByRole("button", { name: "More actions" })).toBeFocused();
    });

    test("opening a hit collapses the view open above it, and the matched text still stays put", async ({ page }) => {
      await openTall(page);
      // By attribute: with a view open, its paragraphs are list items of the results list too.
      const cards = page.locator("[data-result]");
      const above = cards.nth(1);
      await above.getByRole("button", { name: "+1 nearby" }).click();
      await expect(above.locator(".passage--hit")).toBeVisible();
      await settle(page);

      const card = cards.nth(4);
      const excerpt = card.locator(".hit__excerpt");
      await excerpt.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      const before = (await excerpt.boundingBox())!.y;

      await excerpt.click();
      const hit = card.locator(".passage--hit");
      await expect(hit).toBeVisible();
      await settle(page);
      await expect(page.locator(".transcript")).toHaveCount(1);
      await expect(above.locator(".hit__excerpt")).toBeVisible();
      expect(Math.abs((await hit.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
    });

    test("a page still moving when the passage arrives: the matched text lands where its excerpt would be", async ({ page }) => {
      await openTall(page);
      // The answer is held, as on a real connection, and the page moves meanwhile (a flick settling).
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      await page.route("**/api/context*", async (route) => {
        const params = new URL(route.request().url()).searchParams;
        await held;
        return route.fulfill({ json: tallContext(Number(params.get("chunk")), Number(params.get("radius"))) });
      });
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(4);
      const excerpt = card.locator(".hit__excerpt");
      await excerpt.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      const before = (await excerpt.boundingBox())!.y;

      await excerpt.click();
      await expect(card.locator(".transcript")).toBeVisible();
      await page.evaluate(() => window.scrollBy(0, 60));
      await settle(page);
      release();
      const hit = card.locator(".passage--hit");
      await expect(hit).toBeVisible();
      await settle(page);
      expect(Math.abs((await hit.boundingBox())!.y - (before - 60))).toBeLessThanOrEqual(2);
    });

    /** The bottom edge of what the site header covers now (a phone's compact header shows only its search row). */
    const headerEdge = (page: Page) =>
      page.evaluate(() => {
        const header = document.querySelector(".site-header")!;
        const compactPhone = header.classList.contains("site-header--compact") && matchMedia("(max-width: 599.98px)").matches;
        if (!compactPhone) return header.getBoundingClientRect().bottom;
        // Compact: the search row and the summary button hung under it.
        return Math.max(
          header.querySelector(".search-sticky")!.getBoundingClientRect().bottom,
          header.querySelector(".compact-summary")!.getBoundingClientRect().bottom,
        );
      });

    test("the strip stays pinned under the header while the long view is on screen: Show less and ⋯ are in reach", async ({ page }) => {
      await openTall(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(4);
      const excerpt = card.locator(".hit__excerpt");
      await excerpt.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      const before = (await excerpt.boundingBox())!.y;
      const nearby = card.getByRole("button", { name: "+1 nearby" });
      await nearby.click();
      const hit = card.locator(".passage--hit");
      await expect(hit).toBeVisible();
      await settle(page);
      const opened = (await hit.boundingBox())!.y;
      expect(Math.abs(opened - before)).toBeLessThanOrEqual(2);

      // Six paragraphs are above the hit's: the strip would be off screen if it scrolled with them.
      const less = card.getByRole("button", { name: "Show less transcript" });
      const strip = card.locator(".hit__strip");
      await expect(strip).toBeInViewport({ ratio: 1 });
      const edge = await headerEdge(page);
      const stripBox = (await strip.boundingBox())!;
      expect(stripBox.y).toBeGreaterThanOrEqual(edge - 1);
      expect(stripBox.y).toBeLessThan(height / 2);
      // The matched paragraph is not under it.
      expect(opened).toBeGreaterThanOrEqual(stripBox.y + stripBox.height - 1);
      await expect(less).toBeInViewport({ ratio: 1 });

      // ⋯ opens from the stuck strip, and its menu is whole and on screen.
      await card.getByRole("button", { name: "More actions" }).click();
      const menu = card.locator(".more-menu__list");
      await expect(menu).toBeVisible();
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.y).toBeGreaterThanOrEqual(edge);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(height);
      await expect(page.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      // Show less, without scrolling to it first: the excerpt is where the paragraph was.
      const beforeCollapse = (await hit.boundingBox())!.y;
      await less.click();
      await expect(card.locator(".transcript")).toHaveCount(0);
      await settle(page);
      expect(Math.abs((await excerpt.boundingBox())!.y - beforeCollapse)).toBeLessThanOrEqual(2);
      await expect(nearby).toBeFocused();
    });

    test("the strip leaves with the view: scrolled far past the card it is off screen and never in the next card", async ({ page }) => {
      await openTall(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(2);
      await card.getByRole("button", { name: "+1 nearby" }).click();
      await expect(card.locator(".passage--hit")).toBeVisible();
      await settle(page);
      const strip = card.locator(".hit__strip");
      await expect(strip).toBeInViewport();
      await page.evaluate(() => {
        const bottom = document.querySelectorAll("[data-result]")[2]!.getBoundingClientRect().bottom;
        window.scrollBy(0, bottom + 300);
      });
      await settle(page);
      await expect(strip).not.toBeInViewport();
      await expect(page.locator(".hit__strip").first()).toBeAttached();
    });

    test("a hit just under the header, opened by keyboard, ends fully visible below the header", async ({ page }) => {
      await openTall(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      const excerpt = card.locator(".hit__excerpt");
      // Scroll so the top of the excerpt is 10 px under the header's bottom edge.
      await page.evaluate(() => {
        const header = document.querySelector(".site-header")!.getBoundingClientRect().bottom;
        const top = document.querySelector(".hit__excerpt")!.getBoundingClientRect().top;
        window.scrollBy(0, top - header + 10);
      });
      await settle(page);
      await card.getByRole("button", { name: "+1 nearby" }).focus();
      await page.keyboard.press("Enter");
      const hit = card.locator(".passage--hit");
      await expect(hit).toBeVisible();
      await settle(page);
      const headerBottom = await headerEdge(page);
      const box = (await hit.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(headerBottom - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
      await expect(excerpt).toHaveCount(0);
    });

    test("the strip above the view has '+1 nearby' at the left, then Show less, then ⋯, with no overflow", async ({ page }) => {
      await openTall(page);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      await card.getByRole("button", { name: "+1 nearby" }).click();
      await expect(card.locator(".passage--hit")).toBeVisible();
      const nearby = (await card.getByRole("button", { name: "+1 nearby" }).boundingBox())!;
      const less = (await card.getByRole("button", { name: "Show less transcript" }).boundingBox())!;
      const more = (await card.getByRole("button", { name: "More actions" }).boundingBox())!;
      expect(nearby.x + nearby.width).toBeLessThanOrEqual(less.x + 0.5);
      expect(less.x + less.width).toBeLessThanOrEqual(more.x + 0.5);
      expect(Math.abs(less.y - nearby.y)).toBeLessThanOrEqual(8);
      expect(await noOverflow(page)).toBe(true);
    });
  });
}

test("Search this episode puts ep:71 in the box, replacing an old one, and searches", async ({ page }) => {
  await page.route("**/api/search*", (route) =>
    route.fulfill({ json: { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results: [result] } }),
  );
  await page.route("**/api/context*", (route) => route.fulfill({ json: context(3) }));
  await page.goto("/?q=sprayer+ep%3A12");
  const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
  await card.locator(".hit__excerpt").click();
  const searched = page.waitForRequest((request) => request.url().includes("/api/search") && request.url().includes("ep%3A71"));
  await card.getByRole("button", { name: "Search this episode ep:71" }).click();
  const request = await searched;
  expect(new URL(request.url()).searchParams.get("q")).toBe("sprayer ep:71");
  await expect(page.getByLabel("Search the transcripts")).toHaveValue("sprayer ep:71");
  expect(new URL(page.url()).searchParams.get("q")).toBe("sprayer ep:71");
});
