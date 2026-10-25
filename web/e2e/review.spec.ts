// The review page of `wts review` (pipeline/src/wts/review/static), in a real browser against the
// real Python server. `npm run e2e:review` builds a throwaway WTS_HOME with e2e/review-home.py
// (one episode: 40 words in three sentences at 0 s, 38 s and 80 s, so three chunks; the words
// "sets" and "Then" have probability 0.2; the audio is 90 s of silence) and starts `wts review`
// on it.
// Nothing is stubbed. Every test fails on a console problem or a CSP violation, as the other
// specs do.
//
// Order: the tests that save something (Reviewed, the correction) change what the server holds
// for the rest of the run, so this file runs serially, in order, with those two last. The others
// only read, or open the edit dialog and leave without saving.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { watch } from "./fixtures";

test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-review-token";
const HOME = process.env.E2E_REVIEW_HOME ?? path.join(os.tmpdir(), "wts-review-e2e-home");
const CORRECTIONS = path.join(HOME, "corrections.yaml");

const WORDS = 40;
const LOW_INDEX = 25; // "sets": 14 words in sentence 1, then Honestly a tight bond is what you want when the glue sets
const LOW_START_S = 45.15; // 38 s + 11 * 0.65 s
const CHUNK_STARTS_S = [0, 38, 80];

const words = (page: Page) => page.locator("#transcript span[data-i]");
const word = (page: Page, i: number) => page.locator(`#transcript span[data-i="${i}"]`);
const audioTime = (page: Page) => page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).currentTime);
const audioPaused = (page: Page) => page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).paused);

/** Open the page the way `wts review` would, and wait until the transcript is drawn. */
async function open(page: Page, query = "") {
  await page.goto(`/?t=${TOKEN}&episode=1${query}`);
  await expect(words(page)).toHaveCount(WORDS);
  // The audio is attached after the payload arrives; wait for its metadata.
  await expect.poll(() => page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1);
}

/** The data-i of the first word spans with this text. */
async function indexOf(page: Page, text: string) {
  const found = await page.locator("#transcript span[data-i]", { hasText: new RegExp(`^${text}$`) }).first().getAttribute("data-i");
  return Number(found);
}

/** Select words `from`..`to` with a DOM Range, as a person's selection would leave it. */
async function selectWords(page: Page, from: number, to: number) {
  await page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(`#transcript [data-i="${a}"]`)!;
      const last = document.querySelector(`#transcript [data-i="${b}"]`)!;
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    [from, to] as const,
  );
}

/** Select two neighbouring words by dragging the mouse across them. */
async function dragSelect(page: Page, from: number, to: number) {
  const a = (await word(page, from).boundingBox())!;
  const b = (await word(page, to).boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Fix a transcript mistake" });

test("the episode loads", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("1. The review test episode");
  await expect(page.locator("#meta")).toHaveText("2020-01-01");
  await expect(words(page)).toHaveCount(WORDS);
  await expect(page.locator("#transcript .low")).toHaveCount(1);
  await expect(word(page, LOW_INDEX)).toHaveText("sets");
  await expect(word(page, LOW_INDEX)).toHaveClass(/\blow\b/);
  // "Then" is as doubtful to Whisper, but a small word at the start of a sentence is not marked.
  await expect(word(page, await indexOf(page, "Then"))).not.toHaveClass(/\blow\b/);
  await expect(page.locator("#transcript .para .time")).toHaveText(["0:00", "0:38", "1:20"]);
  await expect(page.locator("#flags li")).toHaveText(["wpm_low"]);
  // Only the first minute has 20 words or more (28), one of them unsure: 1/28.
  await expect(page.locator("#worst-list button")).toHaveText(["0:00 · 4%"]);
  const duration = await page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).duration);
  expect(duration).toBeGreaterThan(89.9);
  expect(duration).toBeLessThan(90.1);
  await expect(page.locator("#transcript .now")).toHaveCount(1);
  await expect(word(page, 0)).toHaveClass(/\bnow\b/);
  expect(await audioPaused(page)).toBe(true);
  await done();
});

test("clicking a word seeks to its start", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const target = await indexOf(page, "bond");
  const start = 38 + 3 * 0.65; // the fourth word of sentence 2
  // Record where the player is when the seek completes: the click also starts playback, which
  // moves currentTime on afterwards.
  await page.evaluate(() => {
    const w = window as unknown as { __seeked: number[] };
    w.__seeked = [];
    const audio = document.getElementById("player") as HTMLAudioElement;
    audio.addEventListener("seeked", () => w.__seeked.push(audio.currentTime));
  });
  await word(page, target).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __seeked: number[] }).__seeked.length)).toBeGreaterThan(0);
  const seeked = await page.evaluate(() => (window as unknown as { __seeked: number[] }).__seeked[0]!);
  expect(Math.abs(seeked - start)).toBeLessThan(0.05);
  await expect(word(page, target)).toHaveClass(/\bnow\b/);
  await page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).pause());
  await done();
});

test("n jumps to the next unsure word", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  await page.keyboard.press("n");
  await expect(word(page, LOW_INDEX)).toHaveClass(/\bnow\b/);
  await expect(page.locator("#transcript .now")).toHaveCount(1);
  expect(Math.abs((await audioTime(page)) - LOW_START_S)).toBeLessThan(0.05);
  expect(await audioPaused(page)).toBe(true);
  await page.keyboard.press("n");
  await expect(page.locator("#status")).toContainText("No more unsure words");
  // Shift-n goes back: from further on to the unsure word, and from there nowhere.
  await page.keyboard.press("]");
  await expect.poll(() => audioTime(page)).toBeCloseTo(80, 1);
  await page.keyboard.press("Shift+N");
  await expect(word(page, LOW_INDEX)).toHaveClass(/\bnow\b/);
  expect(Math.abs((await audioTime(page)) - LOW_START_S)).toBeLessThan(0.05);
  await page.keyboard.press("Shift+N");
  await expect(page.locator("#status")).toContainText("No unsure words before this point");
  await expect(word(page, LOW_INDEX)).toHaveClass(/\bnow\b/);
  await done();
});

test("e with nothing selected edits the current word, so n then e fixes an unsure word", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  await page.keyboard.press("n");
  await expect(word(page, LOW_INDEX)).toHaveClass(/\bnow\b/);
  await page.keyboard.press("e");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("Wrong text")).toHaveValue("sets");
  await expect(page.getByLabel("Right text")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await done();
});

test("shift-click selects a word without seeking, and a second one stretches the selection", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const selected = () => page.evaluate(() => window.getSelection()!.toString());
  const tight = await indexOf(page, "tight");
  await word(page, tight).click({ modifiers: ["Shift"] });
  expect(await selected()).toBe("tight");
  await expect(page.getByRole("button", { name: "Edit selection" })).toBeVisible();
  await word(page, tight + 3).click({ modifiers: ["Shift"] });
  expect(await selected()).toBe("tight bond is what");
  await word(page, tight - 2).click({ modifiers: ["Shift"] });
  expect(await selected()).toBe("Honestly a tight bond is what");
  // None of it moved the player or started it.
  expect(await audioTime(page)).toBe(0);
  expect(await audioPaused(page)).toBe(true);
  await expect(word(page, 0)).toHaveClass(/\bnow\b/);
  await page.keyboard.press("e");
  // The wrong text is offered in lower case, whatever the transcript's capitals.
  await expect(page.getByLabel("Wrong text")).toHaveValue("honestly a tight bond is what");
  await page.keyboard.press("Escape");
  await done();
});

test("] and [ move between chunk starts", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const at = async (s: number) => expect.poll(() => audioTime(page)).toBeCloseTo(s, 1);
  await page.keyboard.press("]");
  await at(CHUNK_STARTS_S[1]!);
  await page.keyboard.press("]");
  await at(CHUNK_STARTS_S[2]!);
  await page.keyboard.press("]"); // already on the last one
  await at(CHUNK_STARTS_S[2]!);
  await page.keyboard.press("[");
  await at(CHUNK_STARTS_S[1]!);
  await page.keyboard.press("[");
  await at(CHUNK_STARTS_S[0]!);
  await done();
});

test("the page's keys still work with focus on the player, a button or the speed menu", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const at = async (s: number) => expect.poll(() => audioTime(page)).toBeCloseTo(s, 1);
  // A click on the player's Play button leaves focus on the <audio> element.
  await page.locator("#player").focus();
  await page.keyboard.press("]");
  await at(38);
  // So does a click on Reviewed (focused here, not pressed: it would write).
  await page.locator("#reviewed").focus();
  await page.keyboard.press("]");
  await at(80);
  // Choosing a speed hands the keys back to the page.
  await page.locator("#speed").selectOption("1.5");
  expect(await page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).playbackRate)).toBe(1.5);
  await page.keyboard.press("[");
  await at(38);
  await page.keyboard.press("n");
  await at(LOW_START_S);
  await done();
});

test("a boost keeps playing, hands the keys back and is remembered for the episode", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const boost = page.locator("#boost");
  await expect(boost).toHaveValue("1");
  await boost.selectOption("4");
  // The sound now runs through an audio graph; a suspended one would leave the player silent.
  await page.keyboard.press(" ");
  await expect.poll(() => audioTime(page)).toBeGreaterThan(0.2);
  expect(await page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).paused)).toBe(false);
  await page.keyboard.press(" ");
  await page.reload();
  await expect(boost).toHaveValue("4");
  // Remembered and applied before any click: the player still plays.
  await page.keyboard.press(" ");
  await expect.poll(() => audioTime(page)).toBeGreaterThan(0.2);
  await boost.selectOption("1");
  await page.reload();
  await expect(boost).toHaveValue("1");
  await done();
});

test("Space plays and pauses",async ({ page }) => {
  const done = await watch(page);
  await open(page);
  expect(await audioPaused(page)).toBe(true);
  await page.keyboard.press("Space");
  // Headless Chromium has no audio device to pace the clock, so starting can take a while on a
  // busy machine (one failure in about 20 runs, not reproduced): give it room.
  await expect.poll(() => audioPaused(page), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.2); // it is really running
  await page.keyboard.press("Space");
  await expect.poll(() => audioPaused(page)).toBe(true);
  await done();
});

test("?at=5000 opens at 5 s, in view, not playing", async ({ page }) => {
  const done = await watch(page);
  await open(page, "&at=5000");
  const fifth = 8; // 8 * 0.625 s = 5.0 s
  await expect(word(page, fifth)).toHaveClass(/\bnow\b/);
  await expect(word(page, fifth)).toBeInViewport({ ratio: 1 });
  await expect.poll(() => audioTime(page)).toBeCloseTo(5, 1);
  // Still not playing a moment later.
  await page.waitForTimeout(300);
  expect(await audioPaused(page)).toBe(true);
  expect(await audioTime(page)).toBeCloseTo(5, 1);
  await done();
});

test("?at scrolls the word into view below the sticky header", async ({ page }) => {
  const done = await watch(page);
  await page.setViewportSize({ width: 1280, height: 300 });
  await open(page, "&at=85400");
  const now = page.locator("#transcript .now");
  await expect(now).toHaveText("clamps"); // 80 s + 9 * 0.6 s
  await expect(now).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => (await now.boundingBox())!.y).toBeGreaterThan((await page.locator("#bar").boundingBox())!.height);
  await done();
});

test("the episode menu lists the transcribed episodes and opens one from its start", async ({ page }) => {
  const done = await watch(page);
  await open(page, "&at=5000");
  const menu = page.getByLabel("Open another episode");
  await expect(menu.locator("option")).toHaveText([
    "Open another episode…",
    "2. The second test episode (2020-02-01, flagged)",
    "1. The review test episode (2020-01-01, flagged)", // wpm_low, from the chunker's guards
  ]);
  await expect(menu.locator("option").nth(2)).toBeDisabled(); // the one open now
  await menu.selectOption({ label: "2. The second test episode (2020-02-01, flagged)" });
  await expect(page.locator("#title")).toHaveText("2. The second test episode");
  await expect(words(page)).toHaveCount(8);
  const url = new URL(page.url());
  expect(url.searchParams.get("episode")).toBe("2");
  expect(url.searchParams.get("t")).toBe(TOKEN);
  expect(url.searchParams.has("at")).toBe(false);
  await done();
});

test("a wrong token shows the page's message", async ({ page }) => {
  // The browser logs the 401 itself as a console error; that is the point of the test.
  const problems: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !/status of 401/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/?t=not-the-token&episode=1");
  await expect(page.locator("#message")).toContainText("This link's token is wrong or missing");
  await expect(words(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("Edit selection opens the dialog with the selected words, and Cancel leaves the transcript alone", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const before = await page.locator("#transcript").innerText();
  const button = page.getByRole("button", { name: "Edit selection" });
  await expect(button).toBeHidden();
  const tight = await indexOf(page, "tight");
  await selectWords(page, tight, tight + 1);
  await expect(button).toBeVisible();
  await button.click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("Wrong text")).toHaveValue("tight bond");
  await expect(page.getByLabel("Right text")).toBeFocused();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.getByLabel("Right text").fill("Titebond");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("#edit-preview .count")).toHaveText("1 sentence changes");
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toBeHidden();
  expect(await page.locator("#transcript").innerText()).toBe(before);
  await done();
});

test("Esc closes the edit dialog and leaves the transcript unchanged", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const before = await page.locator("#transcript").innerText();
  const tight = await indexOf(page, "tight");
  await selectWords(page, tight, tight + 1);
  await page.keyboard.press("e");
  await expect(dialog(page)).toBeVisible();
  await page.getByLabel("Right text").fill("Titebond");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(words(page)).toHaveCount(WORDS);
  expect(await page.locator("#transcript").innerText()).toBe(before);
  expect(fs.readFileSync(CORRECTIONS, "utf8")).not.toContain("Titebond");
  await done();
});

// From here on the tests write. They come last, and each copes with the other having run.

const testDialog = (page: Page) => page.getByRole("dialog", { name: "Add a test search" });
const QUERIES = path.join(HOME, "queries.yaml");

test("t adds a test search for the selected passage to queries.yaml", async ({ page }) => {
  const done = await watch(page);
  fs.rmSync(QUERIES, { force: true });
  await open(page);
  const tight = await indexOf(page, "tight");
  await selectWords(page, tight, tight + 1);
  await page.keyboard.press("t");
  await expect(testDialog(page)).toBeVisible();
  await expect(page.locator("#test-where")).toHaveText("Episode 1 at 0:39");
  await expect(page.locator("#test-passage")).toHaveText("tight bond");
  await expect(page.getByLabel("What you'd search for")).toBeFocused();

  // The kind is guessed from the words: said nearby is exact, otherwise paraphrase; "not return
  // it" is a negative, asked of Related.
  const query = page.getByLabel("What you'd search for");
  await query.fill("glue sets");
  await expect(page.getByLabel("Kind")).toHaveValue("exact");
  await query.fill("strong joint");
  await expect(page.getByLabel("Kind")).toHaveValue("paraphrase");
  // Stems, as Exact search matches them: "setting" is the "sets" said here.
  await query.fill("glue setting");
  await expect(page.getByLabel("Kind")).toHaveValue("exact");
  await query.fill("strong joint");
  await expect(page.getByLabel("Kind")).toHaveValue("paraphrase");
  await page.getByLabel("Not return it").check();
  await expect(page.getByLabel("Kind")).toHaveValue("negative");
  await expect(page.getByLabel("Tabs")).toHaveValue("related");
  await page.getByLabel("Find this passage").check();
  await expect(page.getByLabel("Tabs")).toHaveValue("both");

  // This home has no run_env, so Check says so; saving still works.
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator("#test-error")).toContainText("Checking needs run_env");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(testDialog(page)).toBeHidden();
  await expect(page.locator("#status")).toContainText("Added the test search strong-joint");
  expect(fs.readFileSync(QUERIES, "utf8")).toBe(
    '- id: strong-joint\n  query: strong joint\n  tag: paraphrase\n  expect: [{episode: 1, at: "0:39"}]\n',
  );
  // Closed, the page's keys work again.
  await page.keyboard.press("n");
  await expect(page.locator("#transcript .now")).toHaveCount(1);
  await done();
});

test("t with nothing selected takes the current word; Esc closes without saving", async ({ page }) => {
  const done = await watch(page);
  fs.rmSync(QUERIES, { force: true });
  await open(page, "&at=80000");
  await page.keyboard.press("t");
  await expect(testDialog(page)).toBeVisible();
  await expect(page.locator("#test-where")).toHaveText("Episode 1 at 1:20");
  await expect(page.locator("#test-passage")).toContainText("Then I let it cure overnight");
  await page.getByLabel("What you'd search for").fill("cure overnight");
  await page.keyboard.press("Escape");
  await expect(testDialog(page)).toBeHidden();
  expect(fs.existsSync(QUERIES)).toBe(false);
  await done();
});

test("the Reviewed button toggles and survives a reload", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const button = page.locator("#reviewed");
  await expect(button).toBeVisible();
  const was = (await button.getAttribute("aria-pressed")) === "true";
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(!was));
  await page.reload();
  await expect(words(page)).toHaveCount(WORDS);
  await expect(button).toHaveAttribute("aria-pressed", String(!was));
  // Put it back, so the state a later run starts from does not depend on this one.
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(was));
  await page.reload();
  await expect(words(page)).toHaveCount(WORDS);
  await expect(button).toHaveAttribute("aria-pressed", String(was));
  await done();
});

test("a correction is previewed, saved into corrections.yaml and shown", async ({ page }) => {
  const done = await watch(page);
  await open(page);
  const before = fs.readFileSync(CORRECTIONS, "utf8");
  expect(before).toContain("# A harmless rule that matches nothing in the transcript.");

  const tight = await indexOf(page, "tight");
  await dragSelect(page, tight, tight + 1);
  await page.keyboard.press("e");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("Wrong text")).toHaveValue("tight bond");

  const save = page.getByRole("button", { name: "Save" });
  await page.getByLabel("Right text").fill("Titebond");
  await expect(save).toBeDisabled(); // not previewed yet
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("#edit-preview .count")).toHaveText("1 sentence changes");
  const change = page.locator("#edit-preview li");
  await expect(change).toHaveCount(1);
  await expect(change.locator("del")).toHaveText("tight bond");
  await expect(change.locator("ins")).toHaveText("Titebond");
  await expect(change).toContainText("2020-01-01_ep001_review-test");
  await expect(save).toBeEnabled();

  // A previewed rule is the only one that can be saved: changing the text disables Save again.
  await page.getByLabel("Right text").fill("Titebond II");
  await expect(save).toBeDisabled();
  await page.getByLabel("Right text").fill("Titebond");
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(save).toBeEnabled();

  // The other scope of a previewed rule is previewed at once, so Save stays usable.
  await page.getByLabel("This episode only").check();
  await expect(page.locator("#edit-preview .count")).toHaveText("1 sentence changes");
  await expect(save).toBeEnabled();
  await page.getByLabel("Everywhere").check();
  await expect(page.locator("#edit-preview .count")).toHaveText("1 sentence changes");
  await expect(save).toBeEnabled();

  await save.click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator("#status")).toContainText("Saved to corrections.yaml");
  await expect(words(page)).toHaveCount(WORDS - 1);
  await expect(page.locator("#transcript span[data-i]", { hasText: /^Titebond$/ })).toHaveCount(1);
  await expect(page.locator("#transcript span[data-i]", { hasText: /^(tight|bond)$/ })).toHaveCount(0);
  // The correction shows inline: what Whisper wrote, struck out, then the word that replaced it.
  const was = page.locator("#transcript del.was");
  await expect(was).toHaveText(["tight bond"]);
  const fixed = page.locator("#transcript span.fixed");
  await expect(fixed).toHaveText(["Titebond"]);
  expect(await was.evaluate((d) => d.nextElementSibling?.textContent)).toBe("Titebond");
  // The struck-out text is not a word: a click on it does not seek.
  const time = await audioTime(page);
  await was.click();
  expect(await audioTime(page)).toBe(time);

  const after = fs.readFileSync(CORRECTIONS, "utf8");
  expect(after).toContain("\n  tight bond: Titebond\n");
  expect(after).toContain("# A harmless rule that matches nothing in the transcript.");
  expect(after).toContain("  zzyzx: Zzyzx\n");
  expect(after.replace("  tight bond: Titebond\n", "")).toBe(before);

  // The page that is served after a reload says the same.
  await page.reload();
  const fixedWord = page.locator("#transcript span[data-i]", { hasText: /^Titebond$/ });
  await expect(fixedWord).toHaveCount(1);

  // A rule is matched against what Whisper wrote, so a selection over a corrected word offers
  // that text, not the corrected word (a key with "Titebond" in it would match nothing here).
  const at = Number(await fixedWord.getAttribute("data-i"));
  await selectWords(page, at - 1, at + 1);
  await page.keyboard.press("e");
  await expect(page.getByLabel("Wrong text")).toHaveValue("a tight bond is");
  // And a rule that changes nothing says why that may be.
  await page.getByLabel("Wrong text").fill("a titebond is");
  await page.getByLabel("Right text").fill("one Titebond is");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("#edit-preview .count")).toHaveText("This rule changes nothing.");
  await expect(page.locator("#edit-preview .hint")).toContainText("what Whisper wrote");
  await expect(save).toBeDisabled();
  await page.keyboard.press("Escape");
  await done();
});
