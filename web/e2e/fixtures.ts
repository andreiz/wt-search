// What the states and accessibility specs share: the real search fixtures (the ones the Worker's
// contract test and the unit tests read), a /api/context answer built around one of their hits,
// the fake Turnstile, the stubs for every /api route, and a watcher that fails a test on a
// console problem or a CSP violation. Every /api answer is stubbed; nothing reaches a Worker.
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { INFO, stubInfo } from "./info";

export { INFO, stubInfo };

const SEARCH_DIR = path.resolve(import.meta.dirname, "../../pipeline/tests/fixtures/search");

export type Answer = Record<string, any> & { results: Record<string, any>[] };

/** A fresh copy of a Python search fixture (`exact`, `smart`, `smart_degraded`, ...), so a test may change it. */
export function fixture(name: "exact" | "exact_truncated" | "smart" | "smart_degraded" | "empty"): Answer {
  return JSON.parse(fs.readFileSync(path.join(SEARCH_DIR, `${name}.json`), "utf8"));
}

/** The viewport and colour scheme every state is checked in. */
export const CONFIGS = [
  { name: "phone, light", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "phone, dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
  { name: "desktop, light", viewport: { width: 1280, height: 800 }, colorScheme: "light" },
  { name: "desktop, dark", viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
] as const;

// --- The fake Turnstile ---------------------------------------------------------------------

/**
 * Answer for the request to challenges.cloudflare.com: a script that defines `window.turnstile`
 * (render hands the callback a token, reset hands it a fresh one) and records its calls. The real
 * widget is a cross-origin iframe that needs a person, so it is on staging's checklist, not here.
 */
export const FAKE_TURNSTILE = `
window.__ts = { renders: [], resets: [], removes: [] };
var n = 0;
window.turnstile = {
  render: function (el, opts) {
    var id = "w" + (window.__ts.renders.length + 1);
    window.__ts.renders.push({ id: id, sitekey: opts.sitekey });
    el.textContent = "fake check";
    setTimeout(function () { opts.callback("fake-token-" + (++n)); }, 0);
    window.__ts.last = opts;
    return id;
  },
  reset: function (id) {
    window.__ts.resets.push(id);
    var opts = window.__ts.last;
    setTimeout(function () { opts.callback("fake-token-" + (++n)); }, 0);
  },
  remove: function (id) { window.__ts.removes.push(id); }
};
`;

export async function stubTurnstile(page: Page) {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: FAKE_TURNSTILE }),
  );
}

// --- /api/context ---------------------------------------------------------------------------

/**
 * A /api/context answer for a search hit: `radius` chunks on each side of it, 30 s apart, from
 * the hit's own episode. The hit's chunk is in the middle and says the hit's own text.
 */
export function contextAnswer(hit: Answer["results"][number], radius: number) {
  const cue = (n: number) => n * 30;
  const chunks = Array.from({ length: 2 * radius + 1 }, (_, i) => {
    const offset = i - radius;
    const start = Math.max(0, Math.round(hit.hit_ms / 1000) + offset * 30);
    const own = offset === 0;
    return {
      chunk_id: own ? hit.chunk_id : hit.chunk_id * 100 + i,
      seq: i,
      start_ms: start * 1000,
      end_ms: (start + 30) * 1000,
      text: own ? hit.text : `Plain talk, ${Math.abs(offset)} passage${Math.abs(offset) === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"}.`,
      ranges: own ? hit.ranges : [],
      boilerplate: false,
      cue_s: { youtube: cue(i), apple: cue(i), spotify: cue(i), page: cue(i) },
      links: hit.episode.links,
    };
  });
  return { chunk_id: hit.chunk_id, episode: hit.episode, chunks };
}

// --- Stubs ----------------------------------------------------------------------------------

type Reply = Parameters<Route["fulfill"]>[0];

/**
 * Answer every /api/search with `reply(url)` (a fulfill object, or a promise of one: a test holds
 * the answer open by returning a promise it resolves later). Returns the URLs asked so far.
 */
export async function stubSearch(page: Page, reply: (url: URL) => Reply | Promise<Reply>): Promise<URL[]> {
  const asked: URL[] = [];
  await page.route("**/api/search*", async (route) => {
    const url = new URL(route.request().url());
    asked.push(url);
    await route.fulfill(await reply(url));
  });
  return asked;
}

/** /api/context answers from `contextAnswer` for the hit of `answer` the request names. */
export async function stubContext(page: Page, answer: Answer) {
  await page.route("**/api/context*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const hit = answer.results.find((r) => String(r.chunk_id) === params.get("chunk")) ?? answer.results[0]!;
    return route.fulfill({ json: contextAnswer(hit, Number(params.get("radius") ?? 3)) });
  });
}

/** /api/info with a Turnstile site key (the forms need one) and the fake Turnstile script. */
export async function stubForms(page: Page) {
  await stubTurnstile(page);
  await page.route("**/api/info", (route) => route.fulfill({ json: { ...INFO, turnstile_site_key: "SITE-KEY" } }));
  await page.route("**/api/report", (route) => route.fulfill({ json: { ok: true } }));
}

// --- Failing on problems --------------------------------------------------------------------

/**
 * Collect console errors and warnings, uncaught errors and CSP violations; the returned function
 * fails the test if there were any. The browser logs an answer the test provoked (a 429, a 503)
 * as a console error, so those are filtered by status.
 */
export async function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if ((msg.type() === "error" || msg.type() === "warning") && !/status of (400|403|429|500|503)/.test(msg.text())) {
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
  return async () => {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  };
}

// --- The states -----------------------------------------------------------------------------

/**
 * Each state of spec §5.6 (and the open card and form), as the stubs that bring it about, the
 * address to open, and what to wait for before looking at the page. Both the states spec and the
 * accessibility spec walk this list.
 */
export interface State {
  name: string;
  url: string;
  /** Set up the stubs. */
  arrange(page: Page): Promise<void>;
  /** Wait until the state is on screen. */
  ready(page: Page): Promise<void>;
  /** Do more after `ready` (open a menu, a form). */
  after?(page: Page): Promise<void>;
}

const text = (page: Page, t: string | RegExp) => expect(page.getByText(t)).toBeVisible();
const results = (page: Page) => expect(page.getByRole("list", { name: "Results" })).toBeVisible();

const degraded = (reason: "unavailable" | "budget" | "off"): State => ({
  name: `degraded, ${reason}`,
  url: "/?q=glue&mode=related",
  arrange: async (page) => {
    await stubSearch(page, () => ({ json: { ...fixture("smart_degraded"), smart_degraded: reason } }));
  },
  ready: (page) =>
    text(
      page,
      reason === "unavailable"
        ? "Meaning search is unavailable right now; these are keyword matches."
        : "Meaning search is paused; these are keyword matches.",
    ),
});

/** A results page with one of its menus or popovers opened by `open`. */
const popup = (name: string, open: (page: Page) => Promise<void>): State => ({
  name,
  url: "/?q=glue&mode=related",
  arrange: async (page) => {
    await stubSearch(page, () => ({ json: fixture("smart") }));
  },
  ready: results,
  after: open,
});

export const STATES: State[] = [
  {
    name: "before any search",
    url: "/",
    arrange: (page) => stubInfo(page),
    ready: (page) => text(page, "625 episodes indexed through Sep 17, 2026"),
  },
  {
    name: "keyword and related results",
    url: "/?q=glue&mode=related",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: fixture("smart") }));
    },
    ready: async (page) => {
      await results(page);
      await text(page, "Related (beta) · top results 1–3");
    },
  },
  {
    name: "only related hits on page 1",
    url: "/?q=glue&mode=related",
    arrange: async (page) => {
      const answer = fixture("smart");
      answer.results = answer.results.filter((r) => r.match === "related");
      await stubSearch(page, () => ({ json: answer }));
    },
    ready: async (page) => {
      await results(page);
      await text(page, "No exact matches — passages about similar things:");
    },
  },
  {
    name: "Exact with title matches",
    url: "/?q=glue&mode=exact",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: fixture("exact") }));
    },
    ready: async (page) => {
      await results(page);
      await text(page, "57 matches");
    },
  },
  {
    name: "Exact with only a few matches",
    url: "/?q=glue",
    arrange: async (page) => {
      const answer = fixture("exact");
      await stubSearch(page, () => ({ json: { ...answer, total: answer.results.length, episodes: [] } }));
    },
    ready: async (page) => {
      await results(page);
      await text(page, /^Only \d exact match/);
      await expect(page.getByRole("button", { name: "See related passages (beta)" })).toBeVisible();
    },
  },
  {
    name: "Exact with a year range set",
    url: "/?q=glue+year%3A2015-2020",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: fixture("exact") }));
    },
    ready: async (page) => {
      await results(page);
      await expect(page.getByRole("button", { name: /^Year range: 2015–2020/ })).toBeVisible();
    },
  },
  {
    name: "no results in Exact",
    url: "/?q=zzzz&mode=exact",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: fixture("empty") }));
    },
    ready: (page) => expect(page.getByRole("heading", { name: "Nothing found." })).toBeVisible(),
  },
  {
    name: "Exact truncated, 1,000+",
    url: "/?q=glue&mode=exact&page=10",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: fixture("exact_truncated") }));
    },
    ready: (page) =>
      text(page, 'Showing the best 200 of 1,000+ matches — add words, a "phrase" or a year to narrow it.'),
  },
  {
    name: "Exact truncated, a count",
    url: "/?q=glue&mode=exact&page=10",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: { ...fixture("exact_truncated"), total: 318, total_capped: false } }));
    },
    ready: (page) => text(page, 'Showing the best 200 of 318 matches — add words, a "phrase" or a year to narrow it.'),
  },
  degraded("unavailable"),
  degraded("budget"),
  degraded("off"),
  {
    name: "maintenance",
    url: "/?q=glue",
    arrange: async (page) => {
      await stubSearch(page, () => ({
        status: 503,
        json: { error: "maintenance", message: "Search is down for maintenance. Please try again later." },
      }));
    },
    ready: (page) => text(page, "Search is down for maintenance. Please try again later."),
  },
  {
    name: "rate limited",
    url: "/?q=glue",
    arrange: async (page) => {
      await stubInfo(page);
      await stubSearch(page, () => ({ status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } }));
    },
    ready: (page) => text(page, /Too many searches from here/),
  },
  {
    name: "error",
    url: "/?q=glue",
    arrange: async (page) => {
      await stubSearch(page, () => ({ status: 500, json: { error: "boom" } }));
    },
    ready: async (page) => {
      await text(page, "Something went wrong.");
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    },
  },
  {
    name: "second page of Exact",
    url: "/?q=glue&mode=exact&page=2",
    arrange: async (page) => {
      await stubSearch(page, () => ({ json: { ...fixture("exact"), page: 2, episodes: [] } }));
    },
    ready: async (page) => {
      await results(page);
      // Phones hide the page numbers with CSS; the button is still in the page.
      await expect(page.getByRole("button", { name: "Page 2", includeHidden: true })).toHaveAttribute("aria-current", "page");
    },
  },
  {
    name: "expanded card",
    url: "/?q=glue&mode=related",
    arrange: async (page) => {
      const answer = fixture("smart");
      await stubSearch(page, () => ({ json: answer }));
      await stubContext(page, answer);
    },
    ready: results,
    after: async (page) => {
      const card = page.getByRole("list", { name: "Results" }).getByRole("listitem").first();
      await card.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "More transcript" }).click();
      await expect(card.getByRole("region", { name: /^Transcript around/ })).toBeVisible();
      await expect(card.getByText("Plain talk, 1 passage before.")).toBeVisible();
    },
  },
  {
    name: "report form open",
    url: "/?q=glue&mode=related",
    arrange: async (page) => {
      await stubForms(page);
      await stubSearch(page, () => ({ json: fixture("smart") }));
    },
    ready: results,
    after: async (page) => {
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Report transcript error" }).click();
      const form = page.getByRole("form", { name: "Report a transcript error" });
      await expect(form.getByLabel("Quoted text")).toBeFocused();
      await expect(form.getByText("fake check")).toBeVisible();
    },
  },
  {
    name: "feedback form open",
    url: "/",
    arrange: (page) => stubForms(page),
    ready: (page) => text(page, "625 episodes indexed through Sep 17, 2026"),
    after: async (page) => {
      await page.getByRole("button", { name: "Send feedback" }).click();
      const form = page.getByRole("form", { name: "Send feedback" });
      await expect(form.getByLabel("Message")).toBeFocused();
      await expect(form.getByText("fake check")).toBeVisible();
    },
  },
  // What opens over the page: each is a place where a name or a role is easily missed.
  popup("⋯ menu open", async (page) => {
    await page.getByRole("button", { name: "More actions" }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
  }),
  popup("sort menu open", async (page) => {
    await page.getByRole("button", { name: "Sort: Relevance" }).click();
    await expect(page.getByRole("menu", { name: "Sort by" })).toBeVisible();
  }),
  popup("year range open", async (page) => {
    await page.getByRole("button", { name: "Year range: Any year" }).click();
    await expect(page.getByRole("dialog", { name: "Year range" })).toBeVisible();
  }),
  popup("search syntax help open", async (page) => {
    await page.getByRole("button", { name: "Search syntax help" }).click();
    await expect(page.getByRole("dialog", { name: "Search syntax" })).toBeVisible();
  }),
  popup("How this works open", async (page) => {
    await page.getByRole("button", { name: "How this works" }).click();
    await expect(page.getByRole("dialog", { name: "How Related search works" })).toBeVisible();
  }),
];
