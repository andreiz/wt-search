// The dense result cards in the built page under the real CSP (spec §5.3): the header above a
// two-hit card, the timestamp chip (the one play control) and the ⋯ menu at 1280 and 390 px, the
// interleaved keyword and related cards with no fold, a page with only related hits, and the
// phone layout.
import { expect, test, type Page } from "@playwright/test";

const YT = "https://www.youtube.com/watch?v=abc&t=4184s";
const AP = "https://podcasts.apple.com/us/podcast/x/id1?i=2&t=4184";
const SP = "https://open.spotify.com/episode/3?t=4184";
const PAGE = "https://example.com/ep/71";

const FIRST_TEXT = "All right, the great folks over at Highland Woodworking have the HVLP sprayer on sale.";
const SECOND_TEXT = "A second sprayer passage in the same episode.";

/** The `[start, end)` range of the first `word` in `text`. */
function at(text: string, word: string): [number, number] {
  const start = text.indexOf(word);
  return [start, start + word.length];
}

function hit(over: Record<string, unknown>) {
  return {
    episode: { id: 71, number: 71, title: "Welcome to the Three-Way", date: "2010-06-10", links: { youtube: YT, apple: AP, spotify: SP, page: PAGE } },
    chunk_id: 1,
    text: FIRST_TEXT,
    ranges: [at(FIRST_TEXT, "HVLP"), at(FIRST_TEXT, "sprayer")],
    hit_ms: 4_191_000,
    cue_s: { youtube: 4184, apple: 4184, spotify: 4184, page: 4184 },
    match: "keyword",
    more_in_episode: 0,
    folded: [],
    ...over,
  };
}

const keywordCards = [
  hit({ chunk_id: 1, folded: [9, 10], more_in_episode: 2 }),
  hit({ chunk_id: 2, text: SECOND_TEXT, ranges: [at(SECOND_TEXT, "sprayer")], hit_ms: 4_300_000, cue_s: { youtube: 4293, apple: 4293, spotify: 4293, page: 4293 } }),
  hit({
    episode: { id: 72, number: 72, title: "Spotify Only", date: "2011-01-02", links: { spotify: SP } },
    chunk_id: 3,
    text: "Only on one platform.",
    ranges: [],
  }),
];

const relatedCards = [
  hit({
    episode: { id: 90, number: 90, title: "About Finishes", date: "2012-03-04", links: { apple: AP, page: "https://example.com/ep/90" } },
    chunk_id: 4,
    text: "Related passage about spraying lacquer.",
    ranges: [],
    match: "related",
  }),
  hit({
    episode: { id: 91, number: null, title: "Bonus Chat", date: "2013-05-06", links: { page: "https://example.com/ep/91" } },
    chunk_id: 5,
    text: "Another related passage.",
    ranges: [],
    match: "related",
  }),
];

function body(results: unknown[]) {
  return { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results };
}

async function open(page: Page, results: unknown[]) {
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
  await page.route("**/api/search*", (route) => route.fulfill({ json: body(results) }));
  await page.goto("/?q=sprayer");
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  return async () => {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  };
}

const WIDTHS = [
  { name: "a desktop (1280 px)", width: 1280, height: 800 },
  { name: "a phone (390 px)", width: 390, height: 800 },
];

// The DOM is the same at every width, so every check here runs at both.
for (const { name, width, height } of WIDTHS) {
  test.describe(`the chip and ⋯ menu on ${name}`, () => {
    test.use({ viewport: { width, height } });

    test("the header sits above the card's box; the chip is the one play control", async ({ page }) => {
      const noViolations = await open(page, [...keywordCards, ...relatedCards]);
      const cards = page.getByRole("list", { name: "Results" }).getByRole("listitem");
      await expect(cards).toHaveCount(4);

      const first = cards.nth(0);
      await expect(first.getByRole("heading", { level: 3 })).toHaveText("Ep. 71 · Welcome to the Three-Way");
      await expect(first.getByText("2 matches")).toBeVisible();
      await expect(first.getByText("Jun 10, 2010")).toBeVisible();
      await expect(first.locator(".hit")).toHaveCount(2);
      await expect(first.locator("mark")).toHaveText(["HVLP", "sprayer", "sprayer"]);

      const headBox = (await first.locator(".result__head").boundingBox())!;
      const cardBox = (await first.locator(".result__card").boundingBox())!;
      expect(headBox.y + headBox.height).toBeLessThanOrEqual(cardBox.y + 0.5);
      // Header on the page background: no border or fill of its own.
      expect(await first.locator(".result__head").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      // Episodes are further apart than header and card.
      const nextBox = (await cards.nth(1).locator(".result__head").boundingBox())!;
      expect(nextBox.y - (cardBox.y + cardBox.height)).toBeGreaterThanOrEqual(24);

      const chip = first.locator(".hit").nth(0).locator("a.hit__time");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText("1:09:51");
      await expect(chip).toHaveAttribute("href", YT);
      await expect(chip).toHaveAttribute("target", "_blank");
      await expect(chip).toHaveAttribute("rel", /noopener/);
      await expect(chip).toHaveAccessibleName("Play on YouTube 1:09:51, starts at 1:09:44");
      await expect(first.locator("a.play, .ads-info")).toHaveCount(0);
      await expect(first.getByRole("button", { name: "+2 nearby" })).toBeVisible();

      // Three lines of the serif excerpt at most.
      const clamp = await first.locator(".hit__excerpt").first().evaluate((el) => getComputedStyle(el).webkitLineClamp);
      expect(clamp).toBe("3");

      // The Spotify-only episode has no play control for the chip: plain text.
      const second = cards.nth(1);
      await expect(second.locator("a.hit__time")).toHaveCount(0);
      await expect(second.locator("span.hit__time--text")).toHaveText("1:09:51");

      // Nothing runs off the screen.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await noViolations();
    });

    test("the menu, opened by keyboard, lists the other platforms", async ({ page }) => {
      const noViolations = await open(page, keywordCards);
      const first = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      const more = first.getByRole("button", { name: "More actions" }).first();
      await more.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Actions" });
      await expect(menu).toBeVisible();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      const rows = menu.getByRole("menuitem");
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(0)).toHaveAccessibleName("Show page plays from 1:09:51, may play an ad first");
      await expect(rows.nth(1)).toHaveAccessibleName("Play on Apple at 1:09:51 · may start minutes early, starts at 1:09:44");
      await expect(rows.nth(2)).toHaveAccessibleName("Play on Spotify at 1:09:51 · may start minutes early, starts at 1:09:44");
      await expect(rows.nth(3)).toHaveAccessibleName("More transcript");
      await expect(rows.nth(4)).toHaveAccessibleName("Report transcript error");
      await expect(rows.nth(0)).toContainText("Show page");
      await expect(rows.nth(1)).toContainText("Play on Apple");
      await expect(rows.nth(1)).toContainText("at 1:09:51 · may start minutes early");
      for (const [i, href] of [PAGE, AP, SP].entries()) {
        await expect(rows.nth(i)).toHaveAttribute("href", href);
        await expect(rows.nth(i)).toHaveAttribute("target", "_blank");
        await expect(rows.nth(i)).toHaveAttribute("rel", /noopener/);
      }
      // The first row has focus; the arrows wrap.
      await expect(rows.nth(0)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(rows.nth(4)).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(0)).toBeFocused();

      // The menu fits the screen.
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);

      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();
      await noViolations();
    });

    test("the Spotify-only episode's menu has no Show page and keeps Spotify", async ({ page }) => {
      await open(page, keywordCards);
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(1);
      await card.getByRole("button", { name: "More actions" }).click();
      const menu = page.getByRole("menu", { name: "Actions" });
      await expect(menu.getByRole("menuitem")).toHaveCount(3);
      await expect(menu.getByRole("menuitem", { name: /^Show page/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Play on Spotify/ })).toHaveAttribute("href", SP);
    });
  });
}

test.describe("on a desktop", () => {

  test("keyword and related cards are all there, interleaved in the API's order, with no fold", async ({ page }) => {
    const mixed = [keywordCards[0], relatedCards[0], keywordCards[2], relatedCards[1]];
    const noViolations = await open(page, mixed);
    const list = page.getByRole("list", { name: "Results" });
    const cards = list.getByRole("listitem");
    await expect(cards).toHaveCount(4);
    await expect(cards.locator(".hit__excerpt")).toHaveText([
      /over at Highland Woodworking have the HVLP sprayer on sale\./,
      "Related passage about spraying lacquer.",
      "Only on one platform.",
      "Another related passage.",
    ]);
    await expect(page.getByRole("button", { name: /related passage|Show|Hide/i })).toHaveCount(0);
    await expect(page.getByRole("list")).toHaveCount(1);
    // The summary names the results this page holds.
    await expect(page.getByText("Smart search · results 1–4")).toBeVisible();
    // A keyword hit is on the page, so no intro line.
    await expect(page.getByText("No exact matches")).toHaveCount(0);
    await expect(list.getByText("Related", { exact: true })).toHaveCount(2);
    // Dashed border on a related card's box; the header above it has none.
    const related = cards.nth(1);
    expect(await related.locator(".result__card").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    expect(await related.locator(".result__head").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("none");
    expect(await cards.nth(0).locator(".result__card").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
    // A related card has the chip (the page, as the episode has no YouTube) and the menu.
    await expect(cards.nth(3).locator("a.hit__time")).toHaveAccessibleName("Play on the show page 1:09:51, starts at 1:09:44, may play an ad first");
    await noViolations();
  });

  test("a page 1 with only related hits has the intro line", async ({ page }) => {
    const noViolations = await open(page, relatedCards);
    await expect(page.getByText("No exact matches — passages about similar things:")).toBeVisible();
    await expect(page.getByRole("list", { name: "Results" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /related passages|Hide/ })).toHaveCount(0);
    await noViolations();
  });

  test("j and k step over every card, related ones too: a two-hit card is one stop", async ({ page }) => {
    await open(page, [...keywordCards, ...relatedCards]);
    const cards = page.getByRole("list", { name: "Results" }).getByRole("listitem");
    await page.keyboard.press("j");
    await expect(cards.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press("j");
    await expect(cards.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(cards.nth(3)).toBeFocused();
    await page.keyboard.press("k");
    await expect(cards.nth(2)).toBeFocused();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("the chip is a 44 px touch target on its own row above the excerpt, ⋯ beside the excerpt", async ({ page }) => {
    await open(page, keywordCards);
    const row = page.getByRole("list", { name: "Results" }).getByRole("listitem").first().locator(".hit").first();
    const chip = (await row.locator("a.hit__time").boundingBox())!;
    expect(chip.height).toBeGreaterThanOrEqual(44);
    const excerpt = (await row.locator(".hit__excerpt").boundingBox())!;
    expect(excerpt.y).toBeGreaterThanOrEqual(chip.y + chip.height);
    const more = (await row.getByRole("button", { name: "More actions" }).boundingBox())!;
    expect(more.height).toBeGreaterThanOrEqual(44);
    expect(more.x).toBeGreaterThanOrEqual(excerpt.x + excerpt.width);
    const nearby = (await row.getByRole("button", { name: "+2 nearby" }).boundingBox())!;
    expect(nearby.y).toBeGreaterThanOrEqual(excerpt.y + excerpt.height);
    // The chip is no wider than its text and icon need, not a full row.
    expect(chip.width).toBeLessThan(120);
  });
});
