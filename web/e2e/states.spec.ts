// The states and notices in the built page under the real CSP (spec §5.6; brief §4.5): the empty
// state and its example chips, no results, the degraded and truncated notices, the maintenance
// banner, the rate limit's countdown, the error with Retry, and the "How this works" popover at
// 1280 and 390 px. Every /api answer is stubbed.
import { expect, test, type Page } from "@playwright/test";
import { stubInfo } from "./info";

function hit(n: number, over: Record<string, unknown> = {}) {
  return {
    episode: { id: n, number: 70 + n, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
    chunk_id: n,
    text: `A passage about glue number ${n}.`,
    ranges: [],
    hit_ms: 0,
    cue_s: { youtube: 0, apple: 0, spotify: 0, page: 0 },
    match: "keyword",
    more_in_episode: 0,
    folded: [],
    ...over,
  };
}

const smart = (results: unknown[], over: Record<string, unknown> = {}) => ({
  mode: "smart",
  sort: "relevance",
  page: 1,
  limit: 20,
  has_more: false,
  results,
  ...over,
});

const exact = (results: unknown[], over: Record<string, unknown> = {}) => ({
  mode: "exact",
  sort: "relevance",
  total: results.length,
  total_capped: false,
  truncated: false,
  page: 1,
  limit: 20,
  has_more: false,
  results,
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

test("the empty state: heading, examples, the info line, and a chip that searches", async ({ page }) => {
  const clean = await watch(page);
  await stubInfo(page);
  const queries: string[] = [];
  await page.route("**/api/search*", (route) => {
    queries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ json: smart([hit(1)]) });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Find the moment it was said." })).toBeVisible();
  await expect(page.getByText("625 episodes indexed through Sep 17, 2026")).toBeVisible();
  await expect(page.getByRole("button", { name: "hide glue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "split-top Roubo" })).toBeVisible();

  await page.getByRole("button", { name: "how do I sharpen a card scraper" }).click();
  await expect(box(page)).toHaveValue("how do I sharpen a card scraper");
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  await expect(page).toHaveURL(/\?q=how\+do\+I\+sharpen\+a\+card\+scraper$/);
  expect(queries).toEqual(["how do I sharpen a card scraper"]);
  await clean();
});

test("the empty state leaves the info line out when /api/info fails", async ({ page }) => {
  await page.route("**/api/info", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/episodes indexed/)).toHaveCount(0);
});

test("no results in Exact: suggestions, and Switch to Smart searches in Smart", async ({ page }) => {
  const clean = await watch(page);
  const modes: string[] = [];
  await page.route("**/api/search*", (route) => {
    const mode = new URL(route.request().url()).searchParams.get("mode") ?? "";
    modes.push(mode);
    return route.fulfill({ json: mode === "exact" ? exact([]) : smart([hit(1)]) });
  });
  await page.goto("/?q=zzzz&mode=exact");
  await expect(page.getByRole("heading", { name: "Nothing found." })).toBeVisible();
  await expect(page.getByText("Use fewer words")).toBeVisible();
  await page.getByRole("button", { name: "Switch to Smart" }).click();
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Smart" })).toHaveAttribute("aria-checked", "true");
  expect(modes).toEqual(["exact", "smart"]);
  await clean();
});

test("the degraded notice and the truncated note", async ({ page }) => {
  const clean = await watch(page);
  await page.route("**/api/search*", (route) => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    return route.fulfill({
      json:
        mode === "exact"
          ? exact([hit(1)], { total: 1000, total_capped: true, truncated: true, page: 10 })
          : smart([hit(1)], { smart_degraded: "budget" }),
    });
  });
  await page.goto("/?q=glue");
  await expect(page.getByText("Meaning search is paused; these are keyword matches.")).toBeVisible();
  await page.goto("/?q=glue&mode=exact&page=10");
  await expect(
    page.getByText('Showing the best 200 of 1,000+ matches — add words, a "phrase" or a year to narrow it.'),
  ).toBeVisible();
  await clean();
});

test("the maintenance banner shows above the header, from the search", async ({ page }) => {
  await watch(page);
  await page.route("**/api/search*", (route) =>
    route.fulfill({ status: 503, json: { error: "maintenance", message: "Search is down for maintenance. Please try again later." } }),
  );
  await page.goto("/?q=glue");
  const banner = page.getByRole("alert");
  await expect(banner).toHaveText("Search is down for maintenance. Please try again later.");
  const above = await page.evaluate(
    () => document.querySelector("[role='alert']")!.getBoundingClientRect().bottom <= document.querySelector("header")!.getBoundingClientRect().top + 1,
  );
  expect(above).toBe(true);
  // The browser logs a 503 as a console error, so only the CSP is checked here.
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

test("the maintenance banner shows when /api/info answers maintenance on load", async ({ page }) => {
  await page.route("**/api/info", (route) => route.fulfill({ status: 503, json: { error: "maintenance", message: "Back soon." } }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText("Back soon.");
});

test("rate limited: the countdown, Search disabled, then enabled with no automatic retry", async ({ page }) => {
  let searches = 0;
  await page.route("**/api/search*", (route) => {
    searches++;
    return route.fulfill({ status: 429, headers: { "retry-after": "3" }, json: { error: "rate_limited" } });
  });
  await stubInfo(page);
  await page.goto("/?q=glue");
  await expect(page.getByText("Too many searches from here; try again in a minute.")).toBeVisible();
  const button = page.getByRole("button", { name: "Search", exact: true });
  await expect(button).toBeDisabled();
  await expect(page.getByText(/Try again in [123] s/)).toBeVisible();
  await expect(button).toBeEnabled({ timeout: 6000 });
  await expect(page.getByText(/Try again in \d s/)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(searches).toBe(1);
});

test("an error: 'Something went wrong.' and Retry runs the same search again", async ({ page }) => {
  const urls: string[] = [];
  await page.route("**/api/search*", (route) => {
    urls.push(route.request().url());
    return urls.length === 1 ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.fulfill({ json: smart([hit(1)]) });
  });
  await page.goto("/?q=glue");
  await expect(page.getByText("Something went wrong.")).toBeVisible();
  const entries = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  await expect(page.getByText("Something went wrong.")).toHaveCount(0);
  expect(urls).toHaveLength(2);
  expect(urls[1]).toBe(urls[0]);
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

for (const [name, width, height] of [
  ["a desktop (1280 px)", 1280, 800],
  ["a phone (390 px)", 390, 800],
] as const) {
  test.describe(`How this works on ${name}`, () => {
    test.use({ viewport: { width, height } });

    test("opens inside the screen, Esc closes it, Switch to Exact searches Exact", async ({ page }) => {
      const clean = await watch(page);
      const modes: string[] = [];
      await page.route("**/api/search*", (route) => {
        const mode = new URL(route.request().url()).searchParams.get("mode") ?? "";
        modes.push(mode);
        return route.fulfill({ json: mode === "exact" ? exact([hit(1)], { total: 1 }) : smart([hit(1), hit(2)]) });
      });
      await page.goto("/?q=glue");
      await expect(page.getByText("Smart search · top results 1–2")).toBeVisible();

      const trigger = page.getByRole("button", { name: "How this works" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "How Smart search works" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("There is no total");
      const rect = (await dialog.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      await trigger.click();
      await dialog.getByRole("button", { name: "Switch to Exact" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("radio", { name: "Exact" })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("1 match")).toBeVisible();
      expect(modes).toEqual(["smart", "exact"]);
      await clean();
    });
  });
}
