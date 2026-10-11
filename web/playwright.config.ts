// Playwright runs against `vite preview` of a fresh build, which sends the real
// public/_headers (see vite-plugin-headers.ts), so the CSP under test is the shipped one.
import fs from "node:fs";
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
  projects: smoke
    ? [{ name: "smoke", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: SMOKE_URL } }]
    : [{ name: "chromium", testIgnore: "smoke.spec.ts", use: { ...devices["Desktop Chrome"] } }],
  webServer: smoke
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
