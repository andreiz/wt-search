// The "Episodes" row in the built page under the real CSP (spec §5.2 "Episodes whose title
// matches"): it fits at 1280 and 390 px, its title plays the episode from the start with the link
// the API sent, and "Search this episode" fills the box without a request. Every /api answer is
// stubbed.
import { expect, test, type Page } from "@playwright/test";

const YOUTUBE = "https://www.youtube.com/watch?v=abc123";

const answer = (over: Record<string, unknown> = {}) => ({
  mode: "smart",
  sort: "relevance",
  page: 1,
  limit: 20,
  has_more: false,
  results: [
    {
      episode: { id: 1, number: 71, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
      chunk_id: 1,
      text: "A passage about a kregger.",
      ranges: [],
      hit_ms: 0,
      cue_s: { youtube: 0, apple: 0, spotify: 0, page: 0 },
      match: "keyword",
      more_in_episode: 0,
      folded: [],
    },
  ],
  episodes: [
    { id: 613, number: 613, title: "Shove a Kregger in the Hole", date: "2026-08-19", links: { youtube: YOUTUBE, page: "https://example.test/613" } },
    { id: 600, number: 600, title: "Wood Talk 600 | A Rather Long Title About Kreggers and Other Shop Tools", date: "2026-05-02", links: { page: "https://example.test/600" } },
  ],
  ...over,
});

/** Fails the test (through the returned check) on a console error or warning or a CSP violation. */
async function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(err.message));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective);
    });
  });
  return async () => {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  };
}

const box = (page: Page) => page.getByRole("textbox", { name: "Search the transcripts" });

for (const [name, width, height] of [
  ["desktop", 1280, 800],
  ["phone", 390, 800],
] as const) {
  test(`the Episodes row fits at ${name} width, and its title plays from the start`, async ({ page }) => {
    const clean = await watch(page);
    await page.setViewportSize({ width, height });
    await page.route("**/api/search*", (route) => route.fulfill({ json: answer() }));
    await page.goto("/?q=kregger");

    const row = page.getByRole("region", { name: "Episodes with a matching title" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Episodes", { exact: true })).toBeVisible();
    const entries = row.getByRole("listitem");
    await expect(entries).toHaveCount(2);

    const play = row.getByRole("link", { name: /play episode 613 from the start on YouTube/ });
    await expect(play).toHaveAttribute("href", YOUTUBE);
    await expect(play).toHaveAttribute("target", "_blank");
    await expect(play).toHaveText("Shove a Kregger in the Hole");
    await expect(row.getByRole("link", { name: /play episode 600 from the start on the show page/ })).toHaveAttribute(
      "href",
      "https://example.test/600",
    );
    await expect(entries.first()).toContainText("Aug 19, 2026");

    // Nothing runs past the viewport, in the row or the page, and the buttons stay on screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const entry of await entries.all()) {
      const rect = (await entry.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    }
    for (const button of await row.getByRole("button").all()) {
      const rect = (await button.boundingBox())!;
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    }
    await clean();
  });
}

test("Search this episode puts ep:613 in the box and sends no request", async ({ page }) => {
  const clean = await watch(page);
  let searches = 0;
  await page.route("**/api/search*", (route) => {
    searches += 1;
    return route.fulfill({ json: answer() });
  });
  await page.goto("/?q=kregger");
  await expect(page.getByRole("button", { name: "Search this episode: Ep. 613" })).toBeVisible();
  expect(searches).toBe(1);

  await page.getByRole("button", { name: "Search this episode: Ep. 613" }).click();
  await expect(box(page)).toHaveValue("ep:613");
  await expect(box(page)).toBeFocused();
  await expect(page).toHaveURL(/\?q=kregger$/);
  await page.waitForTimeout(300);
  expect(searches).toBe(1);

  // Enter then searches it, as for any query.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?q=ep%3A613$/);
  expect(searches).toBe(2);
  await clean();
});

test("title hits without passages show the row and not 'Nothing found.'", async ({ page }) => {
  await page.route("**/api/search*", (route) => route.fulfill({ json: answer({ results: [] }) }));
  await page.goto("/?q=kregger");
  await expect(page.getByRole("region", { name: "Episodes with a matching title" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing found." })).toHaveCount(0);
});
