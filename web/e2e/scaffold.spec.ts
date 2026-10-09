// The built shell under the real _headers CSP (spec §5.1, §5.7; plan 3 Review Focus 1): no
// console errors, no CSP violations, the self-hosted serif loads, nothing leaves the site.
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

test("the page loads clean: no console errors, no CSP violations, nothing third-party", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;
  const consoleProblems: string[] = [];
  const pageErrors: string[] = [];
  const requests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") consoleProblems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("request", (req) => requests.push(req.url()));

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });

  const response = await page.goto("/");
  // The preview server sent the real file's headers.
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("font-src 'self'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");

  await expect(page.getByRole("banner")).toContainText("Wood Talk Search");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expect(consoleProblems).toEqual([]);
  expect(pageErrors).toEqual([]);
  for (const url of requests) {
    expect(new URL(url).origin, `request to ${url}`).toBe(origin);
  }
});

test("Source Serif 4 is served from /assets/ as woff2 and applies to the heading", async ({ page }) => {
  const fontResponses: string[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith(".woff2")) fontResponses.push(`${new URL(res.url()).pathname} ${res.status()}`);
  });

  await page.goto("/");
  // The heading is weight 600 and is real shell content; 400 (excerpts later) is loaded on demand.
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('600 36px "Source Serif 4"'))).toBe(true);
  await page.evaluate(() => document.fonts.load('400 16px "Source Serif 4"'));
  expect(await page.evaluate(() => document.fonts.check('16px "Source Serif 4"'))).toBe(true);

  expect(fontResponses.length).toBeGreaterThanOrEqual(2);
  for (const r of fontResponses) {
    expect(r).toMatch(/^\/assets\/source-serif-4-latin-(400|600)-normal-[\w-]+\.woff2 200$/);
  }
  const family = await page.getByRole("heading", { level: 1 }).evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain("Source Serif 4");
});

test("hashed assets are immutable and index.html is not", async ({ page }) => {
  const assets: Record<string, string> = {};
  page.on("response", (res) => {
    const p = new URL(res.url()).pathname;
    if (p.startsWith("/assets/")) assets[p] = res.headers()["cache-control"] ?? "";
  });
  const html = await page.goto("/");
  expect(html?.headers()["cache-control"] ?? "").not.toContain("immutable");
  await page.evaluate(() => document.fonts.ready);
  const names = Object.keys(assets);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(assets[name], name).toContain("immutable");
});

test("it works on a phone-width screen with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
