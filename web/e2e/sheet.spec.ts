// The phone's controls row and Sort & years sheet in the built page under the real CSP (spec
// §5.2 "Round 2"): one line, one request and one history entry for sort and years together, and
// the desktop keeps the sort menu and the year chip.
import { expect, test, type Page } from "@playwright/test";
import { stubInfo } from "./info";

const answer = {
  mode: "exact",
  sort: "relevance",
  page: 1,
  limit: 20,
  has_more: false,
  total: 1,
  total_capped: false,
  truncated: false,
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
  const requests: string[] = [];
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(msg.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/search") requests.push(request.url());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective);
    });
  });
  await stubInfo(page);
  await page.route("**/api/search*", (route) => route.fulfill({ json: answer }));
  return { requests, problems };
}

const csp = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one-line controls, and the sheet applies sort and years in one search", async ({ page }) => {
    const { requests, problems } = await setUp(page);
    await page.goto("/?q=glue+year%3A2015-2020");
    await expect(page.getByText("A passage about glue.")).toBeVisible();

    // The switch and the button share a line.
    const button = page.getByRole("button", { name: "Sort and years: Best match, 2015–2020" });
    await expect(button).toHaveText("Sort & years");
    const modeBox = await page.getByRole("radiogroup", { name: "Search mode" }).boundingBox();
    const buttonBox = await button.boundingBox();
    expect(Math.abs(modeBox!.y - buttonBox!.y)).toBeLessThanOrEqual(1);
    expect(buttonBox!.x).toBeGreaterThan(modeBox!.x + modeBox!.width - 1);
    // The desktop pair is not shown.
    await expect(page.getByRole("button", { name: /^Sort: / })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Year range: / })).toBeHidden();

    const before = requests.length;
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Sort & years" });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole("radio", { name: "Best match" })).toBeFocused();
    await page.getByRole("radio", { name: "Oldest" }).click();
    await page.getByRole("combobox", { name: "From" }).selectOption("2010");
    await page.getByRole("combobox", { name: "To" }).selectOption("2012");
    await page.getByRole("button", { name: "Show results" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/sort=oldest/);
    expect(requests.length - before).toBe(1);
    const last = new URL(requests.at(-1)!).searchParams;
    expect(last.get("sort")).toBe("oldest");
    expect(last.get("q")).toBe("glue year:2010-2012");
    await expect(page.getByRole("textbox", { name: "Search the transcripts" })).toHaveValue("glue year:2010-2012");
    const applied = page.getByRole("button", { name: "Sort and years: Oldest, 2010–2012" });
    await expect(applied).toBeFocused();

    // Back restores both with one step.
    await page.goBack();
    await expect(page).not.toHaveURL(/sort=oldest/);
    await expect(page).toHaveURL(/year%3A2015-2020|year:2015-2020/);
    await expect(page.getByRole("button", { name: "Sort and years: Best match, 2015–2020" })).toBeVisible();

    expect(await csp(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("Esc closes the sheet without applying", async ({ page }) => {
    const { requests } = await setUp(page);
    await page.goto("/?q=glue");
    await expect(page.getByText("A passage about glue.")).toBeVisible();
    const before = requests.length;
    await page.getByRole("button", { name: /^Sort and years:/ }).click();
    await page.getByRole("radio", { name: "Newest" }).click();
    await page.getByRole("combobox", { name: "From" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Sort & years" })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Sort and years:/ })).toBeFocused();
    expect(requests.length).toBe(before);
  });
});

test("desktop keeps the sort menu and the year chip, not the phone button", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await setUp(page);
  await page.goto("/?q=glue");
  await expect(page.getByText("A passage about glue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort: Best match" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Year range: Any year" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sort and years:/ })).toBeHidden();
});
