// A review aid, not a test of pixels: a full-page capture of every state of fixtures.ts (spec
// §5.6, the open card, the forms and what opens over the page), plus loading, at a phone and a
// desktop width, light and dark, to hold beside the design's canvas
// (docs/design/system/Wood Talk Search.dc.html, sections 2–4). Run with `npm run e2e:shots`;
// the captures land in web/screenshots/ (not committed). A plain `npm run e2e` skips it.
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CONFIGS, STATES, stubInfo, stubSearch, type State } from "./fixtures";

const OUT = path.resolve(import.meta.dirname, "../screenshots");

const LOADING: State = {
  name: "loading",
  url: "/?q=glue",
  arrange: async (page) => {
    await stubInfo(page);
    await stubSearch(page, () => new Promise(() => {})); // never answers
  },
  ready: (page) => expect(page.locator("[aria-busy=true]").first()).toBeVisible(),
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

test.skip(!process.env.E2E_SHOTS, "captures are made by `npm run e2e:shots`");

for (const config of CONFIGS) {
  test.describe(`captures on a ${config.name}`, () => {
    test.use({ viewport: config.viewport, colorScheme: config.colorScheme });

    for (const state of [...STATES, LOADING]) {
      test(state.name, async ({ page }) => {
        await state.arrange(page);
        await page.goto(state.url);
        await state.ready(page);
        await state.after?.(page);
        await page.evaluate(() => document.fonts.ready);
        // A menu or popover fades in; wait for it (the skeleton's endless pulse is not waited for).
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
              .map((a) => a.finished),
          ),
        );
        await page.screenshot({
          path: path.join(OUT, slug(config.name), `${slug(state.name)}.png`),
          fullPage: true,
        });
      });
    }
  });
}
