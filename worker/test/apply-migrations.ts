// Vitest setup file, run before every test file inside the Workers runtime: bring the
// test D1 up to date with schema/*.sql. Idempotent (applied migrations are recorded in
// d1_migrations), and storage is isolated per test file.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
