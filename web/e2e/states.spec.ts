// The states and notices in the built page under the real CSP (spec §5.6; brief §4.5), at a phone
// (390 x 844) and a desktop (1280 x 800), light and dark: the empty state and its example chips,
// loading, Related results with their intro line, no results (Exact and Related), the Exact truncation note (both wordings), the degraded
// notice (each reason), the maintenance banner, the rate limit's countdown, the error with Retry,
// pagination, and the "How this works" popover. Every /api answer is stubbed (fixtures.ts), and
// every test fails on a console error or warning or a CSP violation.
import { expect, test, type Page } from "@playwright/test";
import { CONFIGS, STATES, fixture, relatedFixture, stubInfo, stubSearch, watch } from "./fixtures";

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

const related = (results: unknown[], over: Record<string, unknown> = {}) => ({
  mode: "related",
  sort: "relevance",
  page: 1,
  limit: 20,
  has_more: false,
  results: results.map((r) => ({ ...(r as object), match: "related" })),
  episodes: [],
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

const box = (page: Page) => page.getByRole("textbox", { name: "Search the transcripts" });
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const config of CONFIGS) {
  const { width } = config.viewport;

  test.describe(`states on a ${config.name}`, () => {
    test.use({ viewport: config.viewport, colorScheme: config.colorScheme });

    // Every state of the list in fixtures.ts shows, fits the screen and logs nothing.
    for (const state of STATES) {
      test(`${state.name} shows and fits the screen`, async ({ page }) => {
        const clean = await watch(page);
        await state.arrange(page);
        await page.goto(state.url);
        await state.ready(page);
        await state.after?.(page);
        expect(await noOverflow(page)).toBe(true);
        await clean();
      });
    }

    test("the empty state: heading, examples, the info line, and a chip that searches", async ({ page }) => {
      const clean = await watch(page);
      await stubInfo(page);
      const asked = await stubSearch(page, () => ({ json: exact([hit(1)]) }));

      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Find the moment it was said." })).toBeVisible();
      await expect(page.getByText("625 episodes indexed through Sep 17, 2026")).toBeVisible();
      await expect(page.getByRole("button", { name: "hide glue" })).toBeVisible();
      await expect(page.getByRole("button", { name: "split-top Roubo" })).toBeVisible();

      await page.getByRole("button", { name: "sharpening a card scraper" }).click();
      await expect(box(page)).toHaveValue("sharpening a card scraper");
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page).toHaveURL(/\?q=sharpening\+a\+card\+scraper$/);
      expect(asked.map((url) => url.searchParams.get("q"))).toEqual(["sharpening a card scraper"]);
      await clean();
    });

    test("the empty state leaves the info line out when /api/info fails", async ({ page }) => {
      const clean = await watch(page);
      await page.route("**/api/info", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/episodes indexed/)).toHaveCount(0);
      await clean();
    });

    test("loading: skeleton cards while the controls stay usable, then the results replace them", async ({ page }) => {
      const clean = await watch(page);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await stubSearch(page, async () => {
        await held;
        return { json: exact([hit(1)]) };
      });
      try {
        await page.goto("/?q=glue");
        await expect(page.locator(".skeleton__card")).toHaveCount(3);
        await expect(page.getByRole("status")).toHaveText("Searching…");
        await expect(box(page)).toBeEnabled();
        await expect(page.getByRole("radio", { name: "Exact" })).toBeEnabled();
        await expect(page.getByRole("list", { name: "Results" })).toHaveCount(0);
        expect(await noOverflow(page)).toBe(true);
      } finally {
        release();
      }
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      await clean();
    });

    test("no results in Exact: suggestions, and See related passages searches in Related", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, (url) => ({
        json: url.searchParams.get("mode") === "exact" ? exact([]) : related([hit(1)]),
      }));
      await page.goto("/?q=zzzz");
      await expect(page.getByRole("heading", { name: "Nothing found." })).toBeVisible();
      await expect(page.getByText("No passage has those exact words.")).toBeVisible();
      await expect(page.getByText("Or use fewer words, or check the spelling.")).toBeVisible();
      await page.getByRole("button", { name: "See related passages (beta)" }).click();
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Related, beta" })).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\?q=zzzz&mode=related$/);
      expect(asked.map((url) => url.searchParams.get("mode"))).toEqual(["exact", "related"]);
      await clean();
    });

    test("no results in Related: See exact matches searches in Exact", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, (url) => ({
        json: url.searchParams.get("mode") === "exact" ? exact([hit(1)]) : related([]),
      }));
      await page.goto("/?q=zzzz&mode=related");
      await expect(page.getByRole("heading", { name: "No related passages." })).toBeVisible();
      await expect(page.getByText("Nothing found.")).toHaveCount(0);
      await expect(page.getByText("Nothing about the same thing turned up without your words.")).toBeVisible();
      await page.getByRole("button", { name: "See exact matches" }).click();
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Exact" })).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\?q=zzzz$/);
      expect(asked.map((url) => url.searchParams.get("mode"))).toEqual(["related", "exact"]);
      await clean();
    });

    test("Related, degraded: the notice's See exact matches searches in Exact, with no 'nothing found'", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, (url) => ({
        json:
          url.searchParams.get("mode") === "exact" ? exact([hit(1)]) : related([], { smart_degraded: "unavailable" }),
      }));
      await page.goto("/?q=glue&mode=related");
      await expect(page.getByText("Related search is unavailable right now.")).toBeVisible();
      await expect(page.getByText("No related passages.")).toHaveCount(0);
      await expect(page.getByText("Nothing found.")).toHaveCount(0);
      await page.getByRole("button", { name: "See exact matches" }).click();
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Exact" })).toHaveAttribute("aria-checked", "true");
      expect(asked.map((url) => url.searchParams.get("mode"))).toEqual(["related", "exact"]);
      await clean();
    });

    test("the intro line is on page 1 of Related, not on a later page and not in Exact", async ({ page }) => {
      const clean = await watch(page);
      const INTRO = "Passages about the same thing that don't contain all your words:";
      await stubSearch(page, (url) => ({
        json:
          url.searchParams.get("mode") === "exact"
            ? exact([hit(1)])
            : related([hit(1)], { page: Number(url.searchParams.get("page") ?? 1) }),
      }));
      await page.goto("/?q=glue&mode=related");
      await expect(page.getByText(INTRO)).toBeVisible();
      await page.goto("/?q=glue&mode=related&page=2");
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByText(INTRO)).toHaveCount(0);
      await page.goto("/?q=glue");
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByText(INTRO)).toHaveCount(0);
      await clean();
    });

    test("a legacy ?mode=smart link opens Related and asks for mode=related", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, () => ({ json: related([hit(1)]) }));
      await page.goto("/?q=glue&mode=smart");
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Related, beta" })).toHaveAttribute("aria-checked", "true");
      expect(asked.map((url) => url.searchParams.get("mode"))).toEqual(["related"]);
      await clean();
    });

    test("Related cards carry no pill and no dashed border", async ({ page }) => {
      const clean = await watch(page);
      await stubSearch(page, () => ({ json: related([hit(1), hit(2)]) }));
      await page.goto("/?q=glue&mode=related");
      const cards = page.getByRole("list", { name: "Results" }).getByRole("listitem");
      await expect(cards).toHaveCount(2);
      await expect(page.locator(".result__tag")).toHaveCount(0);
      await expect(page.getByRole("list", { name: "Results" }).getByText("Related", { exact: true })).toHaveCount(0);
      expect(await cards.first().locator(".result__card").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
      await clean();
    });

    test("the maintenance banner shows above the header, from the search", async ({ page }) => {
      const clean = await watch(page);
      await stubSearch(page, () => ({
        status: 503,
        json: { error: "maintenance", message: "Search is down for maintenance. Please try again later." },
      }));
      await page.goto("/?q=glue");
      const banner = page.getByRole("alert");
      await expect(banner).toHaveText("Search is down for maintenance. Please try again later.");
      const above = await page.evaluate(
        () =>
          document.querySelector("[role='alert']")!.getBoundingClientRect().bottom <=
          document.querySelector("header")!.getBoundingClientRect().top + 1,
      );
      expect(above).toBe(true);
      await clean();
    });

    test("the maintenance banner shows when /api/info answers maintenance on load", async ({ page }) => {
      const clean = await watch(page);
      await page.route("**/api/info", (route) => route.fulfill({ status: 503, json: { error: "maintenance", message: "Back soon." } }));
      await page.goto("/");
      await expect(page.getByRole("alert")).toHaveText("Back soon.");
      await clean();
    });

    test("rate limited: the countdown, Search disabled, then enabled with no automatic retry", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, () => ({ status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } }));
      await stubInfo(page);
      // The page's own timers need the clock to run (Preact runs effects from a timer), so it is
      // not stopped; fastForward jumps it ahead, so the countdown is not waited for.
      await page.clock.install();
      await page.goto("/?q=glue");
      await expect(page.getByText("Too many searches from here; try again in a minute.")).toBeVisible();
      const button = page.getByRole("button", { name: "Search", exact: true });
      await expect(button).toBeDisabled();
      const left = page.getByText(/Try again in \d+ s/);
      await expect(left).toBeVisible();
      const seconds = async () => Number(/\d+/.exec((await left.textContent()) ?? "")?.[0]);
      // The countdown's timer starts a moment after the notice shows, and time that passes before
      // it starts is not counted; so jump a second at a time until it has ticked.
      await expect
        .poll(async () => {
          await page.clock.fastForward(1000);
          return seconds();
        })
        .toBeLessThan(30);
      const before = await seconds();
      await page.clock.fastForward(10_000);
      await expect(button).toBeDisabled();
      await expect.poll(seconds).toBeLessThanOrEqual(before - 9);
      await page.clock.fastForward(30_000);
      await expect(button).toBeEnabled();
      await expect(left).toHaveCount(0);
      await expect(page.getByText("You can search again now.")).toBeVisible();
      // Time has passed and nothing has retried by itself.
      await page.clock.fastForward(60_000);
      expect(asked).toHaveLength(1);
      await clean();
    });

    test("an error: 'Something went wrong.' and Retry runs the same search again", async ({ page }) => {
      const clean = await watch(page);
      const asked: URL[] = await stubSearch(page, () =>
        asked.length === 1 ? { status: 500, json: { error: "boom" } } : { json: exact([hit(1)]) },
      );
      await page.goto("/?q=glue");
      await expect(page.getByText("Something went wrong.")).toBeVisible();
      const entries = await page.evaluate(() => history.length);
      await page.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page.getByText("Something went wrong.")).toHaveCount(0);
      expect(asked).toHaveLength(2);
      expect(asked[1]!.href).toBe(asked[0]!.href);
      expect(await page.evaluate(() => history.length)).toBe(entries);
      await clean();
    });

    test("pagination in Exact: page numbers on a desktop, 'page N of M' on a phone, Previous and Next", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, (url) => ({
        json: { ...fixture("exact"), page: Number(url.searchParams.get("page") ?? 1), episodes: [] },
      }));
      await page.goto("/?q=glue&mode=exact");
      const pager = page.getByRole("navigation", { name: "Pages" });
      await expect(pager).toBeVisible();
      await expect(pager.getByRole("button", { name: "Previous" })).toBeDisabled();
      if (width >= 800) {
        await expect(pager.getByRole("button", { name: /^Page \d$/ })).toHaveCount(3);
        await expect(pager.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
      } else {
        await expect(pager.getByRole("button", { name: "Page 1" })).toBeHidden();
        await expect(page.getByText("· page 1 of 3")).toBeVisible();
      }
      await pager.getByRole("button", { name: "Next" }).click();
      await expect(page).toHaveURL(/page=2/);
      await expect(page.getByText("· page 2 of 3")).toBeAttached();
      await expect(pager.getByRole("button", { name: "Previous" })).toBeEnabled();
      // The page change lands on the results heading, and the new page was asked for.
      await expect(page.getByRole("heading", { name: "Search results" })).toBeFocused();
      expect(asked.at(-1)!.searchParams.get("page")).toBe("2");
      await pager.getByRole("button", { name: "Previous" }).click();
      await expect(page).not.toHaveURL(/page=/);
      expect(await noOverflow(page)).toBe(true);
      await clean();
    });

    test("pagination in Related: Next while there is more, then the end note and no Next", async ({ page }) => {
      const clean = await watch(page);
      await stubSearch(page, (url) => {
        const n = Number(url.searchParams.get("page") ?? 1);
        return { json: { ...relatedFixture(), page: n, has_more: n < 2 } };
      });
      await page.goto("/?q=glue&mode=related");
      const pager = page.getByRole("navigation", { name: "Pages" });
      await pager.getByRole("button", { name: "Next" }).click();
      await expect(page).toHaveURL(/page=2/);
      await expect(page.getByText("That's the end of the related passages.")).toBeVisible();
      await expect(pager.getByRole("button", { name: "Next" })).toBeDisabled();
      await expect(pager.getByRole("button", { name: "Previous" })).toBeEnabled();
      await clean();
    });

    test("How this works opens inside the screen, Esc closes it, Switch to Exact searches Exact", async ({ page }) => {
      const clean = await watch(page);
      const asked = await stubSearch(page, (url) => ({
        json: url.searchParams.get("mode") === "exact" ? exact([hit(1)], { total: 1 }) : related([hit(1), hit(2)]),
      }));
      await page.goto("/?q=glue&mode=related");
      await expect(page.getByText(/Related.*top results 1–2/)).toBeVisible();

      const trigger = page.getByRole("button", { name: "How this works" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "How Related search works" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("There is no total");
      const rect = (await dialog.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(config.viewport.height);
      expect(await noOverflow(page)).toBe(true);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      await trigger.click();
      await dialog.getByRole("button", { name: "Switch to Exact" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("radio", { name: "Exact" })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("1 match")).toBeVisible();
      expect(asked.map((url) => url.searchParams.get("mode"))).toEqual(["related", "exact"]);
      await clean();
    });
  });
}
