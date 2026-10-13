// The smoke run: the built page against the real Worker (`wrangler dev --env e2e`, local D1
// seeded by seed.sql), with no /api stub anywhere. It checks what the stubbed specs cannot: that
// the Worker serves the assets with the shipped CSP, that the frontend and the API agree on
// every link, and that a report goes through the real Turnstile test widget into D1.
// Run it with `npm run e2e:smoke`, which builds the page and the database first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { watch } from "./fixtures";

const WORKER_DIR = path.resolve(import.meta.dirname, "../../worker");
const HEADERS_FILE = path.resolve(import.meta.dirname, "../public/_headers");

type Result = { episode: { title: string; links: Record<string, string> }; chunk_id: number; text: string };

const searchBox = (page: Page) => page.getByRole("textbox", { name: "Search the transcripts" });
const cards = (page: Page) => page.getByRole("list", { name: "Results" }).getByRole("listitem");

/** Type a query and press Enter; resolves with the /api/search answer the page received. */
async function search(page: Page, q: string) {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/search");
  await searchBox(page).fill(q);
  await page.keyboard.press("Enter");
  return answered;
}

test("the page loads from the Worker's assets under the shipped CSP", async ({ page }) => {
  const check = await watch(page);
  const response = await page.goto("/");
  // The expected policy is read from public/_headers, the file the Worker's assets are built with.
  const shipped = /^\s*Content-Security-Policy: (.+)$/m.exec(fs.readFileSync(HEADERS_FILE, "utf8"))![1]!.trim();
  expect(response!.headers()["content-security-policy"]).toBe(shipped);
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  // The footer's line comes from the real /api/info over the seeded episodes.
  await expect(page.getByText("3 episodes indexed through Sep 10, 2022")).toBeVisible();
  await check();
});

test("/robots.txt comes from the Worker and disallows everything", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
});

test("an unknown path under /api/ answers the Worker's JSON 404", async ({ request }) => {
  const response = await request.get("/api/nope");
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
});

test("search shows results and says meaning search is unavailable", async ({ page }) => {
  const check = await watch(page);
  // Related is not the default, so the page is opened in it (the typed search keeps the mode).
  await page.goto("/?mode=related");
  const answer = await (await search(page, "glue")).json();
  expect(answer.mode).toBe("smart");
  expect(answer.smart_degraded).toBe("unavailable");
  await expect(page).toHaveURL(/\?q=glue&mode=related$/);
  await expect(page.getByText("Meaning search is unavailable right now; these are keyword matches.")).toBeVisible();
  // One card for each of the three episodes that say "glue".
  await expect(cards(page)).toHaveCount(3);
  await check();
});

test("changing the sort runs the search again", async ({ page }) => {
  const check = await watch(page);
  await page.goto("/?q=glue&mode=related");
  await expect(cards(page)).toHaveCount(3);

  const titles = () => cards(page).locator(".result__title").allTextContents();
  const sorted = async (label: "Newest" | "Oldest", sort: string, first: string) => {
    const again = page.waitForResponse((r) => new URL(r.url()).searchParams.get("sort") === sort);
    await page.getByRole("button", { name: /^Sort:/ }).click();
    await page.getByRole("menuitemradio", { name: label }).click();
    expect((await again).status()).toBe(200);
    await expect(page.getByRole("button", { name: `Sort: ${label}` })).toBeVisible();
    await expect.poll(async () => (await titles())[0]).toContain(first);
  };
  await sorted("Newest", "newest", "Squeeze Out and Scrapers");
  await sorted("Oldest", "oldest", "Hide Glue and Hot Pots");
  await check();
});

test("More transcript opens and shows the neighbouring passages", async ({ page }) => {
  const check = await watch(page);
  await page.goto("/?q=workbench&mode=related");
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).first();
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "More transcript" }).click();
  const region = card.getByRole("region", { name: /^Transcript around/ });
  await expect(region).toBeVisible();
  // The hit is the first chunk of its episode, so radius 3 gives it and the three after it.
  await expect(region.getByText("Some people prefer a router sled")).toBeVisible();
  await expect(region.getByText("This week we compare PVA glue")).toBeVisible();
  await expect(region.getByText("The consensus is that PVA is fine indoors")).toBeVisible();
  await expect(region.locator(".passage")).toHaveCount(4);
  await check();
});

test("every play link on the page is the one /api/search returned", async ({ page }) => {
  const check = await watch(page);
  await page.goto("/?mode=related");
  const url = (await search(page, "glue")).url();
  await expect(cards(page)).toHaveCount(3);
  // Ask the API again, apart from the page, for what it says each link is.
  const results = ((await (await page.request.get(url)).json()) as { results: Result[] }).results;
  expect(results.length).toBeGreaterThan(1);

  // The page shows one row for each result, in the API's order.
  const rows = page.locator(".hit");
  await expect(rows).toHaveCount(results.length);
  // Each link the seed gives is seen at least once, so an empty comparison cannot pass.
  const seen = new Set<string>();

  for (const [i, result] of results.entries()) {
    const links = result.episode.links;
    const row = rows.nth(i);
    // The chip is YouTube, or else the show page (lib/platforms.ts primaryPlay), which every
    // episode has: the Worker builds it from the guid.
    const chip = links.youtube ?? links.page ?? null;
    const chipLink = row.locator("a.hit__time");
    if (chip === null) await expect(chipLink).toHaveCount(0);
    else await expect(chipLink).toHaveAttribute("href", chip);

    // The other platforms are in the row's menu.
    await row.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: "Actions" });
    // Esc is heard in the menu, so wait for the opening focus to land there before pressing it.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    const hrefs = await menu.getByRole("menuitem").evaluateAll((items) => items.map((m) => m.getAttribute("href")).filter((h) => h !== null));
    // So is the show's own page (Episode page), when the feed's link is not the Acast page.
    const others = [links.page, links.apple, links.spotify, links.notes].filter((h): h is string => !!h && h !== chip);
    expect(hrefs.sort()).toEqual(others.sort());
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    for (const key of Object.keys(links)) if (links[key]) seen.add(key);
  }
  expect([...seen].sort()).toEqual(["apple", "notes", "page", "spotify", "youtube"]);
  await check();
});

// Needs outbound access: the browser loads the real widget from challenges.cloudflare.com and the
// Worker calls Turnstile's siteverify. Where that is blocked, run with `--grep-invert report`.
test("a report goes through the real Turnstile test widget into D1", async ({ page }) => {
  test.setTimeout(90_000);
  const problems: string[] = [];
  page.on("console", (msg) => {
    // The widget is Cloudflare's code in its own frame and may log what it likes; our page may not.
    if ((msg.type() === "error" || msg.type() === "warning") && !msg.location().url.startsWith("https://challenges.cloudflare.com/")) {
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

  // The site key is the one /api/info gives, which is the test key in wrangler.jsonc env.e2e.
  const info = await (await page.request.get("/api/info")).json();
  expect(info.turnstile_site_key).toBe("1x00000000000000000000AA");

  await page.goto("/?q=workbench&mode=related");
  await expect(cards(page)).toHaveCount(1);
  await page.getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "Report transcript error" }).click();
  const form = page.getByRole("form", { name: "Report a transcript error" });
  // Opening moves focus to the first field; typing before that lands would go nowhere.
  await expect(form.getByLabel("Quoted text")).toBeFocused();
  const note = `smoke ${Date.now()}`;
  await form.getByLabel("Note").fill(note);
  // The always-pass widget hands over a token on its own; Send waits for it.
  const send = form.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(form.getByRole("status")).toHaveText(/Thanks — we'll review it\./);

  // The row is in the local D1 the Worker writes to (same --persist-to as playwright.config.ts).
  const out = execFileSync(
    "npx",
    [
      "wrangler", "d1", "execute", "DB", "--env", "e2e", "--local", "--persist-to", ".wrangler/e2e-state", "--json",
      "--command", `SELECT chunk_id, status, note FROM reports WHERE note = '${note}'`,
    ],
    { cwd: WORKER_DIR, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const rows = (JSON.parse(out) as { results: { chunk_id: number; status: string; note: string }[] }[])[0]!.results;
  expect(rows).toEqual([{ chunk_id: 201, status: "open", note }]);

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(problems).toEqual([]);
});
