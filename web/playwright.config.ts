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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
