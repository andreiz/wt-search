// Types the `env` imported from "cloudflare:workers" in tests: the Worker's Env plus the
// test-only migrations binding injected by vitest.config.ts.
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    // Types `exports.default.fetch()` from "cloudflare:workers" (the main module's exports).
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
