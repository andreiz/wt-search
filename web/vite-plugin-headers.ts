// Serves public/_headers from `vite preview`, so the e2e tests run under the same CSP that
// Cloudflare applies to the static files in production (spec §5.1). Handles the subset of the
// _headers format we use: a path line (exact, or a trailing `*` splat), then indented
// `Name: value` lines. It is a test aid, not a copy of Cloudflare's matcher.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export interface HeaderRule {
  pattern: string;
  headers: Record<string, string>;
}

export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: {} });
      continue;
    }
    const rule = rules[rules.length - 1];
    const colon = raw.indexOf(":");
    if (rule && colon > 0) rule.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return rules;
}

function matches(pattern: string, pathname: string): boolean {
  return pattern.endsWith("*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;
}

export function headersFor(rules: HeaderRule[], pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) if (matches(rule.pattern, pathname)) Object.assign(out, rule.headers);
  return out;
}

export function staticHeaders(): Plugin {
  return {
    name: "wts-static-headers",
    configurePreviewServer(server) {
      const file = path.resolve(server.config.root, "public/_headers");
      const rules = parseHeaders(fs.readFileSync(file, "utf8"));
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        for (const [name, value] of Object.entries(headersFor(rules, pathname))) res.setHeader(name, value);
        next();
      });
    },
  };
}
