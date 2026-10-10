// The dense result cards in the built page under the real CSP (spec §5.3): a two-hit card, play
// links, the ⋯ menu by keyboard, the related fold closed / opened / hidden, a page with only
// related hits, and the single play button on a phone.
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
    cue_s: { youtube: 4184, apple: 4184, spotify: 4184 },
    match: "keyword",
    more_in_episode: 0,
    folded: [],
    ...over,
  };
}

const keywordCards = [
  hit({ chunk_id: 1, folded: [9, 10], more_in_episode: 2 }),
  hit({ chunk_id: 2, text: SECOND_TEXT, ranges: [at(SECOND_TEXT, "sprayer")], hit_ms: 4_300_000, cue_s: { youtube: 4293, apple: 4293, spotify: 4293 } }),
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

test.describe("on a desktop", () => {
  test("a two-hit card, its marks and its play links", async ({ page }) => {
    const noViolations = await open(page, [...keywordCards, ...relatedCards]);
    const cards = page.getByRole("list", { name: "Results" }).getByRole("listitem");
    await expect(cards).toHaveCount(2);

    const first = cards.nth(0);
    await expect(first.getByRole("heading", { level: 3 })).toHaveText("Ep. 71 · Welcome to the Three-Way");
    await expect(first.getByText("2 matches")).toBeVisible();
    await expect(first.getByText("Jun 10, 2010")).toBeVisible();
    await expect(first.locator(".hit")).toHaveCount(2);
    await expect(first.locator("mark")).toHaveText(["HVLP", "sprayer", "sprayer"]);
    await expect(first.locator(".hit").nth(0).locator(".hit__time")).toHaveText("1:09:51");

    // Every platform, YouTube first and filled; links from the API, in a new tab.
    const pills = first.locator(".hit").nth(0).locator("a.play");
    await expect(pills).toHaveCount(3);
    await expect(pills.nth(0)).toHaveAccessibleName("Play on YouTube, starts at 1:09:44");
    await expect(pills.nth(1)).toHaveAccessibleName("Play on Apple, starts at 1:09:44");
    await expect(pills.nth(2)).toHaveAccessibleName("Play on Spotify, starts at 1:09:44");
    await expect(first.locator(".hit").nth(0).locator("a.hit__time")).toHaveAccessibleName("Play on YouTube 1:09:51, starts at 1:09:44");
    for (const [i, href] of [YT, AP, SP].entries()) {
      await expect(pills.nth(i)).toHaveAttribute("href", href);
      await expect(pills.nth(i)).toHaveAttribute("target", "_blank");
      await expect(pills.nth(i)).toHaveAttribute("rel", /noopener/);
    }
    await expect(first.locator(".hit").nth(0).locator("a.hit__time")).toHaveAttribute("href", YT);
    await expect(pills.nth(0)).toHaveClass(/play--primary/);
    await expect(pills.nth(1)).not.toHaveClass(/play--primary/);
    await expect(first.getByRole("button", { name: "+2 nearby" })).toBeVisible();
    await expect(first.getByRole("button", { name: /may start a bit early because of ads/ })).toHaveCount(2);

    // Three lines of the serif excerpt at most.
    const clamp = await first.locator(".hit__excerpt").first().evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(clamp).toBe("3");

    // The Spotify-only card has one pill, which is not filled-YouTube: it is the first, so it is.
    const second = cards.nth(1);
    await expect(second.locator("a.play")).toHaveCount(1);
    await expect(second.locator("a.play")).toHaveAccessibleName("Play on Spotify, starts at 1:09:44");

    await noViolations();
  });

  test("the related fold is closed, opens, and hides again", async ({ page }) => {
    const noViolations = await open(page, [...keywordCards, ...relatedCards]);
    const show = page.getByRole("button", { name: /Show 2 related passages/ });
    await expect(show).toBeVisible();
    await expect(show).toContainText("Matched on meaning, not the exact words");
    await expect(page.getByText("Related passage about spraying lacquer.")).toHaveCount(0);

    await show.click();
    const related = page.getByRole("list", { name: "Related results" });
    await expect(related.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByText("Related passage about spraying lacquer.")).toBeVisible();
    await expect(related.getByText("Related", { exact: true })).toHaveCount(2);
    await expect(related.locator(".play--primary")).toHaveCount(0);
    const hide = page.getByRole("button", { name: "Hide" });
    await expect(hide).toBeFocused();
    // Dashed border on a related card.
    expect(await related.getByRole("listitem").first().evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");

    await hide.click();
    await expect(related).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Show 2 related passages/ })).toBeFocused();
    await noViolations();
  });

  test("a page with only related hits shows them open", async ({ page }) => {
    const noViolations = await open(page, relatedCards);
    await expect(page.getByText("No exact matches — passages about similar things:")).toBeVisible();
    await expect(page.getByRole("list", { name: "Results" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /related passages|Hide/ })).toHaveCount(0);
    await noViolations();
  });

  test("the ⋯ menu works by keyboard", async ({ page }) => {
    const noViolations = await open(page, keywordCards);
    const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
    const more = card.getByRole("button", { name: "More actions" }).first();
    await more.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Actions" });
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem", { name: "More transcript" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const episodePage = menu.getByRole("menuitem", { name: "Episode page, jump to 1:09:51" });
    await expect(episodePage).toBeFocused();
    await expect(episodePage).toHaveAttribute("href", PAGE);
    await expect(episodePage).toHaveAttribute("target", "_blank");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Report transcript error" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "More transcript" })).toBeFocused();
    // Not on a desktop: the other platforms are pills already.
    await expect(menu.getByRole("menuitem", { name: /^Play on/ })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await noViolations();
  });

  test("j and k step over cards: a two-hit card is one stop", async ({ page }) => {
    await open(page, [...keywordCards, ...relatedCards]);
    const cards = page.getByRole("list", { name: "Results" }).getByRole("listitem");
    await page.keyboard.press("j");
    await expect(cards.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(cards.nth(0)).toBeFocused();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("only the first platform shows, as a 44 px pill with the time; the others are in ⋯", async ({ page }) => {
    const noViolations = await open(page, keywordCards);
    const row = page.getByRole("list", { name: "Results" }).getByRole("listitem").first().locator(".hit").first();
    await expect(row.locator(".hit__time")).toHaveCount(0);
    const pills = row.locator("a.play");
    await expect(pills).toHaveCount(1);
    await expect(pills).toHaveText("YouTube1:09:51");
    await expect(pills).toHaveAccessibleName("Play on YouTube 1:09:51, starts at 1:09:44");
    const box = (await pills.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);

    // ⋯ stays on the same line as the pill, at the right.
    const more = row.getByRole("button", { name: "More actions" });
    const moreBox = (await more.boundingBox())!;
    expect(moreBox.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(moreBox.y - box.y)).toBeLessThan(8);
    expect(moreBox.x).toBeGreaterThan(box.x + box.width);

    await more.click();
    const menu = page.getByRole("menu", { name: "Actions" });
    const apple = menu.getByRole("menuitem", { name: "Play on Apple at 1:09:51 · may start early (ads), starts at 1:09:44" });
    await expect(apple).toContainText("at 1:09:51 · may start early (ads)");
    await expect(apple).toHaveAttribute("href", AP);
    await expect(apple).toHaveAttribute("target", "_blank");
    await expect(apple).toHaveAttribute("rel", /noopener/);
    await expect(menu.getByRole("menuitem", { name: /^Play on Spotify/ })).toHaveAttribute("href", SP);
    // The menu fits the screen.
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(375);
    await noViolations();
  });

  test("a Spotify-first card shows the ads note button", async ({ page }) => {
    await open(page, keywordCards);
    const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").nth(1);
    await expect(card.locator("a.play")).toHaveText("Spotify1:09:51");
    await expect(card.getByRole("button", { name: /Spotify may start a bit early because of ads/ })).toBeVisible();
  });
});
