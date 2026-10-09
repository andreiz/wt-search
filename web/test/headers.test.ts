// @vitest-environment node
// The _headers parser behind `vite preview`, so e2e runs under the real file's CSP (spec §5.1).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headersFor, parseHeaders } from "../vite-plugin-headers";

const SAMPLE = `# comment
/*
  X-A: one
  X-B: two: with colon
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/exact
  X-C: three
`;

describe("parseHeaders / headersFor", () => {
  const rules = parseHeaders(SAMPLE);

  it("reads patterns, header lines and values containing colons", () => {
    expect(rules.map((r) => r.pattern)).toEqual(["/*", "/assets/*", "/exact"]);
    expect(headersFor(rules, "/")).toEqual({ "X-A": "one", "X-B": "two: with colon" });
  });

  it("applies a splat rule to its prefix and a plain rule to its exact path", () => {
    expect(headersFor(rules, "/assets/index-abc.js")["Cache-Control"]).toContain("immutable");
    expect(headersFor(rules, "/index.html")["Cache-Control"]).toBeUndefined();
    expect(headersFor(rules, "/exact")["X-C"]).toBe("three");
    expect(headersFor(rules, "/exact/more")["X-C"]).toBeUndefined();
  });
});

describe("public/_headers", () => {
  const file = fs.readFileSync(path.resolve(import.meta.dirname, "../public/_headers"), "utf8");
  const h = headersFor(parseHeaders(file), "/anything");

  it("sends a strict CSP with the only third party being Turnstile", () => {
    const csp = h["Content-Security-Policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("googleapis");
    const origins = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set(["https://challenges.cloudflare.com"]));
  });

  it("sends nosniff and no-referrer, and caches hashed assets forever", () => {
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    const rules = parseHeaders(file);
    expect(headersFor(rules, "/assets/x.js")["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });
});
