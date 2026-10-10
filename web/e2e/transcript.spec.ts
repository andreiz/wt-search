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
// the seven around it. Chunks 9 and 10 are the folded hits; both also say "sprayer", unmarked.
const IDS = [20, 21, 22, 1, 9, 23, 10, 24, 25];
function chunk(index: number, base = 4_100) {
  const id = IDS[index]!;
  const start = base + index * 30;
  const cue = start - 7;
  return {
    chunk_id: id,
    seq: index,
    start_ms: start * 1000,
    end_ms: (start + 30) * 1000,
    text: id === 1 ? FIRST_TEXT : id === 9 || id === 10 ? `Another word about the sprayer, chunk ${id}.` : `Plain talk in chunk ${id}.`,
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
      expect(regionBox.y).toBeGreaterThanOrEqual(nearbyBox.y + nearbyBox.height - 0.5);
      expect(regionBox.y).toBeGreaterThanOrEqual(moreBox.y + moreBox.height - 0.5);
      expect(moreBox.x).toBeGreaterThanOrEqual(nearbyBox.x + nearbyBox.width);
      expect(regionBox.y + regionBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
      expect(rowBox.y).toBeLessThanOrEqual(nearbyBox.y);
      expect(regionBox.width).toBeGreaterThanOrEqual(rowBox.width - 12 - 0.5);

      const rows = region.getByRole("listitem");
      await expect(rows).toHaveCount(9);
      // The hit's paragraph: on the tint, the result's highlights; no other paragraph is marked.
      const hit = region.locator(".passage--hit");
      await expect(hit).toHaveCount(1);
      await expect(hit.locator("mark")).toHaveText(["HVLP", "sprayer"]);
      await expect(region.locator("mark")).toHaveCount(2);
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
