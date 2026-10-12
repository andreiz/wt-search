// Playwright runs against `vite preview` of a fresh build, which sends the real
// public/_headers (see vite-plugin-headers.ts), so the CSP under test is the shipped one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The cloud sandbox preinstalls one Chromium build (PLAYWRIGHT_BROWSERS_PATH) that may differ
// from the one this Playwright version pins, and never downloads another. Use it when it is
// there; elsewhere (the maintainer's Mac) Playwright uses its own install.
const sandboxChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = fs.existsSync(sandboxChromium) ? sandboxChromium : undefined;

const PORT = 4173;
// The smoke project runs against the real Worker (`wrangler dev --env e2e`), not vite preview.
// The port clashes with none of 4173 (preview), 5173 (vite dev) or 8787 (wrangler's default).
const SMOKE_PORT = Number(process.env.E2E_SMOKE_PORT ?? 8799);
const SMOKE_URL = `http://127.0.0.1:${SMOKE_PORT}`;

// A Playwright web server belongs to the whole run, not to a project, so `npm run e2e:smoke`
// sets E2E_SMOKE and starts only wrangler; a plain `npm run e2e` never starts it. The database
// it serves is built beforehand by the script (package.json), into the same --persist-to.
const smoke = !!process.env.E2E_SMOKE;

// The review project drives `wts review` (the Python tool in ../pipeline) on 127.0.0.1. Like
// smoke, it owns the run's one web server. Its home (state.db, transcript, audio, a copy of
// corrections.yaml) is built by e2e/review-home.py. It lives in the OS temp dir, not under
// test-results/, because Playwright empties outputDir when a run starts, after nothing of ours
// has run but before the web server may be up. The spec finds it through the same variable.
const review = !!process.env.E2E_REVIEW;
// E2E_REVIEW_PORT is for a sandbox that lets a browser reach only certain ports.
const REVIEW_PORT = Number(process.env.E2E_REVIEW_PORT ?? 8797);
const REVIEW_URL = `http://127.0.0.1:${REVIEW_PORT}`;
const REVIEW_HOME = process.env.E2E_REVIEW_HOME ?? path.join(os.tmpdir(), "wts-review-e2e-home");
process.env.E2E_REVIEW_HOME = REVIEW_HOME;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  // Only one of the two is defined per run, so a bare `playwright test` can neither start wrangler
  // nor run the smoke spec against a server that is not there.
  projects: review
    ? [{ name: "review", testMatch: "review.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: REVIEW_URL } }]
    : smoke
      ? [{ name: "smoke", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: SMOKE_URL } }]
      : [{ name: "chromium", testIgnore: ["smoke.spec.ts", "review.spec.ts"], use: { ...devices["Desktop Chrome"] } }],
  webServer: review
    ? {
        // The home is rebuilt, then the real `wts review` serves it. The token is fixed for the test.
        command:
          `uv run --project ../pipeline python e2e/review-home.py "${REVIEW_HOME}" && ` +
          `uv run --project ../pipeline wts review 1 --no-open --port ${REVIEW_PORT}`,
        env: {
          WTS_HOME: REVIEW_HOME,
          WTS_CORRECTIONS_FILE: path.join(REVIEW_HOME, "corrections.yaml"),
          WTS_REVIEW_TOKEN: "e2e-review-token",
        },
        url: REVIEW_URL,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : smoke
    ? {
        command: `npx wrangler dev --env e2e --local --ip 127.0.0.1 --port ${SMOKE_PORT} --persist-to .wrangler/e2e-state`,
        cwd: "../worker",
        env: { WRANGLER_SEND_METRICS: "false" },
        url: SMOKE_URL,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : {
        command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
