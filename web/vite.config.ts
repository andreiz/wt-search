import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { staticHeaders } from "./vite-plugin-headers.ts";

export default defineConfig({
  plugins: [preact(), staticHeaders()],
  build: {
    outDir: "dist",
    // Hashed files go to /assets/ (the default), where _headers makes them immutable.
    assetsDir: "assets",
    // The polyfill is an inline script, which the CSP forbids. Every browser we support
    // has native modulepreload.
    modulePreload: { polyfill: false },
    // Never inline an asset as a data: URI: font-src allows 'self' only.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    // `wrangler dev` (in worker/, `--env e2e` or the top level with local bindings) on 8787.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
