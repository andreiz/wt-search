// The report and feedback forms in the built page under the real CSP (spec §5.5, §4.4): opened
// from ⋯ under a hit and from the footer, at 1280 and 390 px. Turnstile is faked: the request to
// https://challenges.cloudflare.com is answered with a small script that defines
// `window.turnstile` (render hands the callback a token, reset hands it a fresh one) and records
// its calls. Every /api answer is stubbed. The real widget needs a person on staging.
import { expect, test, type Page } from "@playwright/test";
import { FAKE_TURNSTILE } from "./fixtures";
import { INFO } from "./info";

const hit = {
  episode: { id: 71, number: 71, title: "Welcome to the Three-Way", date: "2010-06-10", links: {} },
  chunk_id: 77,
  text: "All right, the great folks over at Highland Woodworking have the HVLP sprayer on sale.",
  ranges: [],
  hit_ms: 0,
  cue_s: { youtube: 0, apple: 0, spotify: 0, page: 0 },
  match: "keyword",
  more_in_episode: 0,
  folded: [],
};

interface Seen {
  reports: unknown[];
  scriptRequests: number;
  infoRequests: number;
}

/** Stub the API and Turnstile; fail the test on a console problem or a CSP violation (via `check`). */
async function setup(page: Page, opts: { siteKey?: string | null; reportAnswers?: { status: number; json: unknown }[] } = {}) {
  const siteKey = opts.siteKey === undefined ? "SITE-KEY" : opts.siteKey;
  const answers = [...(opts.reportAnswers ?? [])];
  const seen: Seen = { reports: [], scriptRequests: 0, infoRequests: 0 };
  const problems: string[] = [];
  page.on("console", (msg) => {
    // The browser logs a refused answer (a 403 the test provokes) as a console error; that is not a problem.
    if ((msg.type() === "error" || msg.type() === "warning") && !/status of (400|403|429)/.test(msg.text())) {
      problems.push(msg.text());
    }
  });
  page.on("pageerror", (err) => problems.push(err.message));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await page.route("https://challenges.cloudflare.com/**", (route) => {
    seen.scriptRequests += 1;
    return route.fulfill({ contentType: "application/javascript", body: FAKE_TURNSTILE });
  });
  await page.route("**/api/info", (route) => {
    seen.infoRequests += 1;
    return route.fulfill({ json: { ...INFO, turnstile_site_key: siteKey } });
  });
  await page.route("**/api/search*", (route) =>
    route.fulfill({ json: { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results: [hit], episodes: [] } }),
  );
  await page.route("**/api/report", (route) => {
    seen.reports.push(route.request().postDataJSON());
    const next = answers.shift() ?? { status: 200, json: { ok: true } };
    return route.fulfill({ status: next.status, json: next.json });
  });
  const check = async () => {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  };
  return { seen, check };
}

const turnstile = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ts?: { renders: unknown[]; resets: string[]; removes: string[] } }).__ts);

async function openReport(page: Page) {
  await page.goto("/?q=glue");
  await expect(page.getByText("HVLP sprayer on sale")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Report transcript error" }).click();
  return page.getByRole("form", { name: "Report a transcript error" });
}

async function insideScreen(page: Page, form: ReturnType<Page["getByRole"]>) {
  const box = (await form.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test(`report from ⋯: opens in the card, sends, thanks (${name})`, async ({ page }) => {
      const { seen, check } = await setup(page);
      const form = await openReport(page);
      await expect(form).toBeVisible();
      await expect(form.getByLabel("Quoted text")).toBeFocused();
      await expect(form.getByLabel("Quoted text")).toHaveValue(hit.text);
      await expect(form.getByText("fake check")).toBeVisible();
      await insideScreen(page, form);
      expect(seen.scriptRequests).toBe(1);
      expect(seen.infoRequests).toBe(1);

      const send = form.getByRole("button", { name: "Send", exact: true });
      await expect(send).toBeEnabled();
      // 44 px touch targets.
      expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await form.getByRole("button", { name: "Cancel" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await form.getByLabel("Suggested correction").fill("HVLP sprayers");
      await send.click();
      await expect(form.getByRole("status")).toHaveText(/Thanks — we'll review it\./);
      expect(seen.reports).toEqual([
        { chunk_id: 77, quoted_text: hit.text, suggested_text: "HVLP sprayers", turnstile_token: "fake-token-1" },
      ]);
      await insideScreen(page, form);
      // The widget is removed in the effect's cleanup, which runs a moment after the form changes.
      await expect.poll(async () => (await turnstile(page))?.removes).toEqual(["w1"]);
      await check();
    });

    test(`a refused report keeps the text, resets the widget and can be sent again (${name})`, async ({ page }) => {
      const { seen, check } = await setup(page, {
        reportAnswers: [{ status: 403, json: { error: "forbidden", message: "The check didn't pass. Please try again." } }],
      });
      const form = await openReport(page);
      // Opening moves focus to the first field; typing before that lands would go nowhere.
      await expect(form.getByLabel("Quoted text")).toBeFocused();
      await form.getByLabel("Note").fill("heard it twice");
      const send = form.getByRole("button", { name: "Send", exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(form.getByRole("alert")).toContainText("The check didn't pass. Please try again.");
      await expect(form.getByLabel("Note")).toHaveValue("heard it twice");
      await insideScreen(page, form);
      // The widget was reset and gave a new token; Send works again.
      await expect.poll(async () => (await turnstile(page))?.resets).toEqual(["w1"]);
      await expect(send).toBeEnabled();
      await send.click();
      await expect(form.getByRole("status")).toHaveText(/Thanks — we'll review it\./);
      expect(seen.reports.map((r) => (r as { turnstile_token: string }).turnstile_token)).toEqual([
        "fake-token-1",
        "fake-token-2",
      ]);
      await check();
    });

    test(`Esc keeps the report form and its text; Cancel closes it and returns focus to ⋯ (${name})`, async ({ page }) => {
      const { check } = await setup(page);
      const form = await openReport(page);
      await expect(form.getByText("fake check")).toBeVisible();
      await expect(form.getByLabel("Quoted text")).toBeFocused();
      await form.getByLabel("Note").fill("heard it twice");
      await page.keyboard.press("Escape");
      await expect(form.getByLabel("Note")).toHaveValue("heard it twice");
      await expect(form.getByLabel("Note")).toBeFocused();
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toBeHidden();
      await expect(page.getByRole("button", { name: "More actions" })).toBeFocused();
      // The widget is removed in the effect's cleanup, which runs a moment after the form changes.
      await expect.poll(async () => (await turnstile(page))?.removes).toEqual(["w1"]);
      await check();
    });

    test(`feedback from the footer posts only the message (${name})`, async ({ page }) => {
      const { seen, check } = await setup(page);
      await page.goto("/");
      await expect(page.getByText("625 episodes indexed")).toBeVisible();
      const opener = page.getByRole("button", { name: "Send feedback" });
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const form = page.getByRole("form", { name: "Send feedback" });
      await expect(form.getByLabel("Message")).toBeFocused();
      await expect(form.getByText("Search didn't find something? Have an idea? Tell us.")).toBeVisible();
      await expect(form.getByText("fake check")).toBeVisible();
      await form.getByLabel("Message").fill("Searched milk paint and found nothing.");
      await insideScreen(page, form);
      await form.getByRole("button", { name: "Send", exact: true }).click();
      await expect(form.getByRole("status")).toHaveText(/Thanks — we read every message\./);
      expect(seen.reports).toEqual([{ note: "Searched milk paint and found nothing.", turnstile_token: "fake-token-1" }]);
      expect(seen.infoRequests).toBe(1);
      await check();
    });

    test(`feedback: Esc keeps the message; Cancel returns focus to the button (${name})`, async ({ page }) => {
      const { check } = await setup(page);
      await page.goto("/");
      const opener = page.getByRole("button", { name: "Send feedback" });
      await opener.click();
      const form = page.getByRole("form", { name: "Send feedback" });
      await expect(form.getByLabel("Message")).toBeFocused();
      await form.getByLabel("Message").fill("an idea");
      await page.keyboard.press("Escape");
      await expect(form.getByLabel("Message")).toHaveValue("an idea");
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toBeHidden();
      await expect(opener).toBeFocused();
      await check();
    });

    test(`no site key: both forms say reporting is unavailable and load nothing (${name})`, async ({ page }) => {
      const { seen, check } = await setup(page, { siteKey: null });
      const form = await openReport(page);
      await expect(form.getByText("Reporting is unavailable right now. Please try again later.")).toBeVisible();
      await expect(form.getByRole("textbox")).toHaveCount(0);
      await expect(form.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      await insideScreen(page, form);
      await form.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Send feedback" }).click();
      const feedback = page.getByRole("form", { name: "Send feedback" });
      await expect(feedback.getByText("Reporting is unavailable right now. Please try again later.")).toBeVisible();
      expect(seen.scriptRequests).toBe(0);
      expect(seen.reports).toEqual([]);
      expect(seen.infoRequests).toBe(1);
      await check();
    });
  });
}
