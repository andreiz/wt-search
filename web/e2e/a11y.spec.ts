// Accessibility in the built page (spec §5.7), at a phone (390 x 844) and a desktop (1280 x 800),
// light and dark: axe at WCAG 2.1 AA on every state of fixtures.ts (the empty state, results,
// the expanded card, the report form open, each notice, maintenance), and a walk through the
// page by keyboard alone. Every /api answer is stubbed, Turnstile is faked (the real widget is a
// cross-origin iframe and is not part of the axe run), and every test fails on a console error or
// warning or a CSP violation.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { CONFIGS, STATES, fixture, stubContext, stubForms, stubSearch, watch } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** What axe found, as a readable list: the rule, the element, and the message (which holds the contrast ratio). */
async function violations(page: Page) {
  // A menu or popover fades in; measured mid-fade, its colours are blends that fail contrast.
  // (An endless animation, like the skeleton's, never finishes and is not waited for.)
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished),
    ),
  );
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((v) => ({
    rule: v.id,
    nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
  }));
}

for (const config of CONFIGS) {
  test.describe(`accessibility on a ${config.name}`, () => {
    test.use({ viewport: config.viewport, colorScheme: config.colorScheme });

    for (const state of STATES) {
      test(`axe: ${state.name}`, async ({ page }) => {
        const clean = await watch(page);
        await state.arrange(page);
        await page.goto(state.url);
        await state.ready(page);
        await state.after?.(page);
        // The theme under test is the one the page got.
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(config.colorScheme === "dark");
        expect(await violations(page)).toEqual([]);
        await clean();
      });
    }

    test("keyboard: / , typing, Enter, j and k, a play button's name, More transcript and Esc, the report form and Cancel", async ({
      page,
    }) => {
      const clean = await watch(page);
      const answer = fixture("smart");
      await stubForms(page);
      await stubSearch(page, () => ({ json: answer }));
      await stubContext(page, answer);

      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // `/` focuses the box from anywhere; typing and Enter search.
      const box = page.getByRole("textbox", { name: "Search the transcripts" });
      await page.keyboard.press("/");
      await expect(box).toBeFocused();
      await page.keyboard.type("hide glue");
      await expect(box).toHaveValue("hide glue");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
      await expect(page).toHaveURL(/\?q=hide\+glue$/);

      // Leave the box, then j and k move between the cards.
      await page.keyboard.press("Tab");
      await expect(box).not.toBeFocused();
      const cards = page.locator("[data-result]");
      await expect(cards).toHaveCount(3);
      await page.keyboard.press("j");
      await expect(cards.nth(0)).toBeFocused();
      await page.keyboard.press("j");
      await expect(cards.nth(1)).toBeFocused();
      await page.keyboard.press("k");
      await expect(cards.nth(0)).toBeFocused();

      // Tab from the card reaches its play button, which says where it plays and from when.
      await page.keyboard.press("Tab");
      const play = cards.nth(0).getByRole("link", { name: /^Play on YouTube/ });
      await expect(play).toBeFocused();
      await expect(play).toHaveAccessibleName("Play on YouTube 35:10, starts at 35:03");

      // ⋯ opens the menu by keyboard; More transcript opens the view; Esc closes it back to ⋯.
      await page.keyboard.press("Tab");
      const more = cards.nth(0).getByRole("button", { name: "More actions" });
      await expect(more).toBeFocused();
      await page.keyboard.press("Enter");
      const items = page.getByRole("menuitem");
      await expect(items.first()).toBeFocused();
      const names = await items.evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      const target = names.findIndex((n) => n.startsWith("More transcript"));
      expect(target).toBeGreaterThan(0);
      for (let i = 0; i < target; i++) await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "More transcript" })).toBeFocused();
      await page.keyboard.press("Enter");
      const region = cards.nth(0).getByRole("region", { name: /^Transcript around/ });
      await expect(region).toBeVisible();
      await expect(region).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(region).toHaveCount(0);
      await expect(more).toBeFocused();

      // The report form opens from ⋯; Esc leaves it open; Cancel closes it and focus returns to ⋯.
      await page.keyboard.press("Enter");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.getByRole("menuitem", { name: "Report transcript error" })).toBeFocused();
      await page.keyboard.press("Enter");
      const form = page.getByRole("form", { name: "Report a transcript error" });
      await expect(form.getByLabel("Quoted text")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(form).toBeVisible();
      await form.getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
      await expect(form).toBeHidden();
      await expect(more).toBeFocused();
      await clean();
    });
  });
}
