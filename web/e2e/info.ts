// A GET /api/info answer for the specs that open the empty state (it asks /api/info once; with no
// route the preview server answers 502, and the browser logs that as a console error).
import type { Page } from "@playwright/test";

export const INFO = { episodes: 625, latest_episode_date: "2026-09-17", corpus_version: "v1", turnstile_site_key: null };

export async function stubInfo(page: Page) {
  await page.route("**/api/info", (route) => route.fulfill({ json: INFO }));
}
