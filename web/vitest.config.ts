import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [preact()],
  test: {
    // Component tests run in happy-dom; test files that need Node say so with
    // `// @vitest-environment node` (the build check does).
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
    // The build check runs a full `vite build`.
    testTimeout: 60_000,
  },
});
