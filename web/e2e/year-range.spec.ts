// The year range chip and the syntax help in the built page under the real CSP (spec §5.2):
// Apply writes year:A-B into the box and the URL; an example lands in the box without a search;
// both dialogs fit a phone screen.
import { expect, test, type Page } from "@playwright/test";

const answer = {
  mode: "smart",
  sort: "relevance",
  page: 1,
  limit: 20,
  has_more: false,
  results: [
    {
      episode: { id: 1, number: 71, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
      chunk_id: 1,
      text: "A passage about glue.",
      ranges: [],
      hit_ms: 0,
      cue_s: { youtube: 0, apple: 0, spotify: 0, page: 0 },
      match: "keyword",
      more_in_episode: 0,
      folded: [],
    },
  ],
};

async function setUp(page: Page) {
  const queries: string[] = [];
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
    queries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ json: answer });
  });
  return { queries, problems };
}

const csp = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const box = (page: Page) => page.getByRole("textbox", { name: "Search the transcripts" });

test("the year chip writes year:A-B into the box and the URL, and × takes it out", async ({ page }) => {
  const { queries, problems } = await setUp(page);
  await page.goto("/?q=glue");
  await expect(page.getByText("A passage about glue.")).toBeVisible();

  await page.getByRole("button", { name: "Year range: Any year" }).click();
  const dialog = page.getByRole("dialog", { name: "Year range" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("combobox", { name: "From" })).toBeFocused();
  await page.getByRole("combobox", { name: "From" }).selectOption("2015");
  await page.getByRole("combobox", { name: "To" }).selectOption("2020");
  await dialog.getByRole("button", { name: "Apply" }).click();

  await expect(box(page)).toHaveValue("glue year:2015-2020");
  await expect(page).toHaveURL(/\?q=glue\+year%3A2015-2020$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Year range: 2015–2020" })).toBeFocused();
  await expect.poll(() => queries.at(-1)).toBe("glue year:2015-2020");

  // Esc closes the dialog and returns to the chip; the box is untouched.
  await page.getByRole("button", { name: "Year range: 2015–2020" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Year range: 2015–2020" })).toBeFocused();

  await page.getByRole("button", { name: "Clear years" }).click();
  await expect(box(page)).toHaveValue("glue");
  await expect(page).toHaveURL(/\?q=glue$/);
  await expect(page.getByRole("button", { name: "Year range: Any year" })).toBeFocused();
  await expect.poll(() => queries.at(-1)).toBe("glue");

  // Back brings the range, and the chip, back.
  await page.goBack();
  await expect(page.getByRole("button", { name: "Year range: 2015–2020" })).toBeVisible();
  await expect(box(page)).toHaveValue("glue year:2015-2020");

  expect(await csp(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a syntax example lands in the box without a search", async ({ page }) => {
  const { queries, problems } = await setUp(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Search syntax help" }).click();
  const dialog = page.getByRole("dialog", { name: "Search syntax" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "year:2015-2020" }).click();
  await expect(box(page)).toHaveValue("year:2015-2020");
  await expect(box(page)).toBeFocused();
  await expect(dialog).toBeHidden();
  expect(queries).toEqual([]);
  await expect(page).toHaveURL(/\/$/);

  // Enter searches it, and the chip follows.
  await page.keyboard.press("Enter");
  await expect(page.getByText("A passage about glue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Year range: 2015–2020" })).toBeVisible();
  expect(queries).toEqual(["year:2015-2020"]);

  // Esc closes the help and returns to the "?".
  await page.getByRole("button", { name: "Search syntax help" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Search syntax help" })).toBeFocused();

  expect(await csp(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("both dialogs stay inside the screen", async ({ page }) => {
    await setUp(page);
    await page.goto("/?q=glue");
    await expect(page.getByText("A passage about glue.")).toBeVisible();
    const inside = async (name: string) => {
      const box = await page.getByRole("dialog", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    };

    await page.getByRole("button", { name: "Year range: Any year" }).click();
    await inside("Year range");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Search syntax help" }).click();
    await inside("Search syntax");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
