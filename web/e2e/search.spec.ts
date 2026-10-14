// A search in the built page under the real CSP (spec §5.1, §5.2): stubbed /api/search answers,
// the URL following the search, Back, and no CSP violation from the new styles.
import { expect, test } from "@playwright/test";
import { stubInfo } from "./info";

function answer(text: string, count = 1, mode: "related" | "exact" = "related") {
  return {
    mode,
    sort: "relevance",
    page: 1,
    limit: 20,
    has_more: false,
    ...(mode === "exact" ? { total: count, total_capped: false, truncated: false } : {}),
    results: Array.from({ length: count }, (_, i) => ({
      episode: { id: i + 1, number: 71 + i, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
      chunk_id: i + 1,
      text,
      ranges: [],
      hit_ms: 0,
      cue_s: { youtube: 0, apple: 0, spotify: 0, page: 0 },
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
  await stubInfo(page);
  await page.route("**/api/search*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const mode = params.get("mode") === "related" ? "related" : "exact";
    return route.fulfill({ json: answer(`Passage about ${params.get("q") ?? ""}`, 1, mode) });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Search the transcripts" }).fill("hvlp sprayer");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Passage about hvlp sprayer")).toBeVisible();
  await expect(page).toHaveURL(/\?q=hvlp\+sprayer$/);
  await expect(page.getByText("1 match", { exact: true })).toBeVisible();

  await page.getByRole("radio", { name: "Related, beta" }).click();
  await expect(page).toHaveURL(/mode=related/);
  await expect(page.getByText("Top result 1")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?q=hvlp\+sprayer$/);
  await expect(page.getByRole("radio", { name: "Exact" })).toHaveAttribute("aria-checked", "true");

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
    await page.goto("/?q=glue&mode=related");
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
    await expect(page.getByRole("radio", { name: "Related, beta" })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Search the transcripts" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Related \(beta\) · Best match · Any year/ })).toBeVisible();

    // The button opens "Search options" (mode, sort, years) with nothing behind it moving.
    const opener = page.getByRole("button", { name: /Related \(beta\) · Best match · Any year/ });
    const steady = async () => {
      for (let i = 0; i < 3; i++) {
        expect(await compact(page)).toBe(true);
        expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(130);
        expect(await height()).toBe(before);
        await page.waitForTimeout(100);
      }
    };
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Search options" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Related, beta" })).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await steady();
    // Esc closes it and puts focus back on the button.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await steady();

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => compact(page)).toBe(false);
    await expect(page.getByRole("radio", { name: "Related, beta" })).toBeVisible();
  });

  test("on a short results page it never compacts", async ({ page }) => {
    // One card: with the footer's "Send feedback" (Task 13) a page of two can scroll past the mark.
    await search(page, 1);
    await page.mouse.wheel(0, 400);
    for (let i = 0; i < 4; i++) {
      expect(await compact(page)).toBe(false);
      await page.waitForTimeout(100);
    }
    await expect(page.getByRole("radio", { name: "Related, beta" })).toBeVisible();
  });
});
