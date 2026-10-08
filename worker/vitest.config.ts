import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // The D1 schema is shared with the pipeline: tests apply the very same schema/*.sql
      // files that `wrangler d1 migrations apply` sends to staging and production.
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "../schema"));
      return {
        // Top-level config: the D1 binding only (see the comment in wrangler.jsonc).
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Test-only: read by test/apply-migrations.ts.
            TEST_MIGRATIONS: migrations,
            TURNSTILE_SITE_KEY: "test-site-key",
            TURNSTILE_SECRET: "test-secret",
            // As on staging: Vite's dev server, on top of the Worker's own origin (spec §4.8 item 6).
            REPORT_ORIGINS: "http://localhost:5173",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
