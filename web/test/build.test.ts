// @vitest-environment node
// Build checks (plan 3, Task 5; spec §5.1): the built site holds no inline script, no host and
// no third-party font, and the source holds nothing the CSP would block. Builds into a temp
// directory, so `npm test` doesn't depend on, or disturb, `web/dist`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
let outDir = "";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wts-web-build-"));
  await build({ root, logLevel: "silent", build: { outDir, emptyOutDir: true } });
});

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

describe("web build", () => {
  it("index.html has no inline script and loads hashed files from /assets/", () => {
    const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/assets\/[^"]+-[\w-]{8}\.js"/);
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
  });

  it("holds no host and no third-party font service", () => {
    const banned = ["workers.dev", "10fathoms", "localhost", "googleapis", "gstatic"];
    for (const file of walk(outDir)) {
      if (/\.(woff2?|png|ico)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const word of banned) {
        expect(text.includes(word), `${path.relative(outDir, file)} contains ${word}`).toBe(false);
      }
    }
  });

  it("bundles the two Source Serif 4 woff2 files under /assets/, never as data: URIs", () => {
    const fonts = fs.readdirSync(path.join(outDir, "assets")).filter((f) => f.endsWith(".woff2"));
    expect(fonts.some((f) => f.startsWith("source-serif-4-latin-400-normal-"))).toBe(true);
    expect(fonts.some((f) => f.startsWith("source-serif-4-latin-600-normal-"))).toBe(true);
    const css = walk(path.join(outDir, "assets"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    expect(css).not.toContain("data:font");
    expect(css).toMatch(/font-display:\s*swap/);
    expect(css).toContain("/assets/source-serif-4-latin-400-normal-");
  });

  it("copies _headers and the favicon from public/", () => {
    expect(fs.existsSync(path.join(outDir, "_headers"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "favicon.svg"))).toBe(true);
  });
});

describe("web source", () => {
  it("has no style attribute and no style prop (CSP style-src 'self')", () => {
    const files = walk(path.join(root, "src")).filter((f) => /\.(tsx?|html)$/.test(f));
    files.push(path.join(root, "index.html"));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, path.relative(root, file)).not.toMatch(/\bstyle\s*=/);
      expect(text, path.relative(root, file)).not.toMatch(/\.style\.cssText|setAttribute\(\s*["']style/);
    }
  });
});
