// A search in the built page under the real CSP (spec §5.1, §5.2): stubbed /api/search answers,
// the URL following the search, Back, and no CSP violation from the new styles.
import { expect, test } from "@playwright/test";

function answer(text: string, count = 1) {
  return {
    mode: "smart",
    sort: "relevance",
    page: 1,
    limit: 20,
    has_more: false,
    results: Array.from({ length: count }, (_, i) => ({
      episode: { id: i + 1, number: 71 + i, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
      chunk_id: i + 1,
      text,
      ranges: [],
      hit_ms: 0,
      cue_s: { youtube: 0, apple: 0, spotify: 0 },
      match: "keyword",
      more_in_episode: 0,
      folded: [],
    })),
  };
}

test("search, URL and Back, under the CSP", async ({ page }) => {
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
  await page.route("**/api/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    return route.fulfill({ json: answer(`Passage about ${q}`) });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Search the transcripts" }).fill("hvlp sprayer");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Passage about hvlp sprayer")).toBeVisible();
  await expect(page).toHaveURL(/\?q=hvlp\+sprayer$/);
  await expect(page.getByText("Smart search")).toBeVisible();

  await page.getByRole("radio", { name: "Exact" }).click();
  await expect(page).toHaveURL(/mode=exact/);

  await page.goBack();
  await expect(page).toHaveURL(/\?q=hvlp\+sprayer$/);
  await expect(page.getByRole("radio", { name: "Smart" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("textbox", { name: "Search the transcripts" }).blur();
  await page.keyboard.press("/");
  await expect(page.getByRole("textbox", { name: "Search the transcripts" })).toBeFocused();

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(problems).toEqual([]);
});

// The phone header compacts without moving the page: its box keeps its size, so the scroll
// position cannot be pushed back across the threshold.
test.describe("phone header compaction", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  async function search(page: import("@playwright/test").Page, count: number) {
    await page.route("**/api/search*", (route) => route.fulfill({ json: answer("A passage about glue and clamps.", count) }));
    await page.goto("/?q=glue");
    await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  }

  const compact = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.querySelector("header")?.classList.contains("site-header--compact") ?? false);

  test("on a long results page it compacts past the threshold, stays put, and opens at the top", async ({ page }) => {
    await search(page, 20);
    const height = () => page.evaluate(() => document.querySelector("header")?.getBoundingClientRect().height ?? 0);
    const before = await height();
    expect(await compact(page)).toBe(false);

    await page.evaluate(() => window.scrollTo(0, 130));
    await expect.poll(() => compact(page)).toBe(true);
    // Sample for about 500 ms: still compact, still at the same scroll position and header size.
    for (let i = 0; i < 6; i++) {
      expect(await compact(page)).toBe(true);
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(130);
      expect(await height()).toBe(before);
      await page.waitForTimeout(90);
    }
    // Compact: the controls are out of the way, the input and the summary button show.
    await expect(page.getByRole("radio", { name: "Smart" })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Search the transcripts" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Smart · Relevance · Any year/ })).toBeVisible();

    // The button is a toggle: open the controls, with nothing else moving.
    const toggle = page.getByRole("button", { name: /Smart · Relevance · Any year/ });
    const steady = async (expectCompact: boolean) => {
      for (let i = 0; i < 3; i++) {
        expect(await compact(page)).toBe(expectCompact);
        expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(130);
        expect(await height()).toBe(before);
        await page.waitForTimeout(100);
      }
    };
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("radio", { name: "Smart" })).toBeVisible();
    await expect(toggle).toBeVisible();
    await steady(false);
    // Esc closes them and puts focus on the button.
    await page.getByRole("radio", { name: "Smart" }).focus();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await steady(true);
    // A second press of the button closes them again.
    await toggle.click();
    await expect(page.getByRole("radio", { name: "Smart" })).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("radio", { name: "Smart" })).toBeHidden();
    await expect(toggle).toBeVisible();
    await steady(true);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => compact(page)).toBe(false);
    await expect(page.getByRole("radio", { name: "Smart" })).toBeVisible();
  });

  test("on a short results page it never compacts", async ({ page }) => {
    await search(page, 2);
    await page.mouse.wheel(0, 400);
    for (let i = 0; i < 4; i++) {
      expect(await compact(page)).toBe(false);
      await page.waitForTimeout(100);
    }
    await expect(page.getByRole("radio", { name: "Smart" })).toBeVisible();
  });
});
