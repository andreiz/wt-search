# `wts analytics pull` and `report` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy the Worker's Analytics Engine search points into a local `analytics.db` and print a summary for a date range that leaves out our own traffic.

**Architecture:** The Worker records a traffic class with each point (`pipeline` by User-Agent, `maintainer` by a header the frontend sends after `?me=1`, else `web`). The pipeline pulls whole UTC days through the Analytics Engine SQL API into `analytics.db`, replacing them on each pull, and `report` summarises from that file alone, classing pre-change rows against the eval files.

**Tech Stack:** Python 3.13 + click + httpx + sqlite3 (pipeline); TypeScript Worker + Vitest; Preact + Vitest/happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-29-analytics-pull-design.md` (and the main spec `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §3.6, §5.7, §8.3, §8.4, which Tasks 1, 2 and 6 update).

## Global Constraints

- No IP, cookie, user agent or header value is stored anywhere; the Worker keeps only the class `pipeline` | `maintainer` | `web`.
- Search points: blob5 is the class (blobs 1–4 unchanged). Report points: blob1 is the class.
- `pipeline` ⇔ `User-Agent` starts with `WoodTalkSearchBot/`; `maintainer` ⇔ header `X-WTS-Traffic: maintainer`; `pipeline` wins if both.
- Frontend: `?me=1` stores `localStorage["wts-traffic"] = "maintainer"`; `?me=0` removes it; the `me` parameter is then removed with `history.replaceState`. Storage access never throws out.
- Footer, while the flag is set: "Unofficial · fan-made · not counted".
- New Keychain secret `cloudflare_analytics_token`; `cloudflare_api_token` is not widened.
- Dataset: `[env.<name>] analytics_dataset`, default `wts_<name>`; must match `^[A-Za-z0-9_]+$` (it is put into SQL text).
- `analytics.db` sits beside `state.db` in the app directory.
- Counts are `sum(sample)` (Analytics Engine's `_sample_interval`), never row counts.
- Dates on the command line are local days, inclusive; default the last 7 days including today. `--since` also takes `Nd`.
- Queries are grouped by `" ".join(q.lower().split())` and shown in their most common spelling.
- Edit files with the Edit tool (Write for new files). Commit straight to `main`; never push without the maintainer's approval.
- Commit messages end with the two attribution lines from the session (`Co-Authored-By: …`, `Claude-Session: …`).

## Review Focus

1. A pull that brings nothing new, or a re-pull of today, must leave days before the window untouched and not duplicate rows (Task 4: `test_repull_replaces_only_the_window`).
2. A report for a range with no searches (or before any pull) must say so, not crash on empty percentiles (Task 5: `test_empty_range`; Task 6: `test_report_before_any_pull`).
3. Local-day boundaries: 2026-10-30 03:49 UTC is 2026-10-29 in PDT and must count on the 29th (Task 5: `test_local_day_bounds`).
4. Browser storage that throws (private windows, blocked site data) must leave the page working and send no header (Task 2: `storage that throws`).
5. Old rows with empty fields (status 0, no mode, as in the 18 such staging rows) must not break the report (Task 5: `test_rows_with_empty_fields`).

---

### Task 1: Worker records the traffic class

**Files:**
- Modify: `worker/src/analytics.ts` (column comment, `SearchPoint`, `recordSearch`, `recordReport`)
- Modify: `worker/src/index.ts:246-274`
- Test: `worker/test/requests.test.ts` (the "Analytics Engine" describe)
- Modify: main spec §8.3 (the columns paragraph)

**Interfaces:**
- Produces: `export type Traffic = "pipeline" | "maintainer" | "web"`; `export function trafficOf(request: Request): Traffic` in `analytics.ts`; `SearchPoint.traffic: Traffic`; `recordReport(env, status, traffic: Traffic)`.

- [ ] **Step 1: Update the existing tests and add new ones**

Existing expectations gain the class: the search point's blobs become `["hide glue", "exact", "oldest", "skip", "web"]`; the report points become `{ indexes: ["report"], blobs: ["web"], doubles: [200] }` and `[400]`. New tests:

```ts
it("classes a pipeline client by its User-Agent", async () => {
  const a = analytics();
  await logLines(() => call("/api/search?q=glue&mode=exact", bindings({ ANALYTICS: a }),
    { headers: { "user-agent": "WoodTalkSearchBot/0.1 (+https://github.com/andreiz/wt-search)" } }));
  expect(a.writeDataPoint.mock.calls[0]?.[0].blobs?.[4]).toBe("pipeline");
});
it("classes the maintainer's browser by X-WTS-Traffic", …  headers { "x-wts-traffic": "maintainer" } → "maintainer");
it("prefers pipeline when both are sent", … both headers → "pipeline");
it("ignores other X-WTS-Traffic values", … { "x-wts-traffic": "eval" } → "web");
it("classes a cache hit too", … same search twice; both points carry the class);
it("never writes the User-Agent or header value", … JSON.stringify(all calls) contains neither "WoodTalkSearchBot" nor the log lines);
```

- [ ] **Step 2: Run, expect the new and changed tests to fail**

Run: `cd worker && npx vitest run test/requests.test.ts`
Expected: FAIL on the blob counts / missing class.

- [ ] **Step 3: Implement** `trafficOf` (startsWith `WoodTalkSearchBot/`, exact header value `maintainer`, case-sensitive values, header names case-insensitive as `Headers` already is), pass `trafficOf(request)` from the router into `recordSearch` and `recordReport`, and update the column comment in `analytics.ts`.

- [ ] **Step 4: Run the Worker suite and type-check**

Run: `cd worker && npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Update main spec §8.3** — search blob5 and report blob1 = class, with the three values and their rules, marked *(Added 2026-10-29.)*

- [ ] **Step 6: Commit** `worker: record a traffic class with each analytics point`

---

### Task 2: The maintainer's browser switch

**Files:**
- Create: `web/src/lib/traffic.ts`
- Modify: `web/src/lib/api.ts` (`call` merges the traffic headers)
- Modify: `web/src/main.tsx` (apply the switch before `render`)
- Modify: `web/src/components/Footer.tsx`
- Test: `web/test/lib/traffic.test.ts` (new), `web/test/footer.test.tsx`, the api tests under `web/test/lib/`
- Modify: main spec §5.7

**Interfaces:**
- Produces, in `traffic.ts` (no DOM globals referenced at import time; everything injected):
  - `export const TRAFFIC_KEY = "wts-traffic"`
  - `export function applyTrafficSwitch(url: URL, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): { counted: boolean; cleanUrl: string | null }` — handles `me=1`/`me=0`, returns the URL without `me` (or null when there was none), and whether searches count (`counted === false` ⇔ flag set). Any storage exception ⇒ `counted: true`.
  - `export function setMaintainer(on: boolean): void`, `export function isMaintainer(): boolean` — module state, set once at startup.
  - `export function trafficHeaders(): Record<string, string>` — `{ "x-wts-traffic": "maintainer" }` or `{}`.
- `api.ts` imports `trafficHeaders` only (it stays DOM-free); every `call` merges them into `init.headers` (keeping the report's `content-type`).

- [ ] **Step 1: Write the failing tests**

`traffic.test.ts`:
```ts
it("?me=1 stores the flag and strips the parameter", () => {
  const s = memoryStorage();
  expect(applyTrafficSwitch(new URL("https://x/?q=glue&me=1"), s))
    .toEqual({ counted: false, cleanUrl: "/?q=glue" });
  expect(s.getItem(TRAFFIC_KEY)).toBe("maintainer");
});
it("?me=0 removes it", … counted: true, item null, cleanUrl "/");
it("no parameter: reads the stored flag, cleanUrl null", …);
it("storage that throws: counted, no exception", () => {
  const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  expect(applyTrafficSwitch(new URL("https://x/?me=1"), bad).counted).toBe(true);
});
it("null storage: counted", …);
it("trafficHeaders follows setMaintainer", …);
```
api test: with `setMaintainer(true)`, `search(...)` and `report(...)` send `x-wts-traffic: maintainer` (and report still sends `content-type`); with `false`, no such header.
footer test: with `setMaintainer(true)` the line reads "Unofficial · fan-made · not counted"; with `false`, "Unofficial · fan-made".

- [ ] **Step 2: Run, expect failures**

Run: `cd web && npx vitest run test/lib/traffic.test.ts test/footer.test.tsx test/lib`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `traffic.ts`, the `call` merge, the footer note, and in `main.tsx` before `render`: get `window.localStorage` inside try/catch (null on failure), run `applyTrafficSwitch(new URL(location.href), storage)`, `history.replaceState(history.state, "", cleanUrl)` when non-null, then `setMaintainer(!counted)`. This runs before `<App/>` mounts, so a first search from `?q=` already carries the header.

- [ ] **Step 4: Run the web suite and type-check**

Run: `cd web && npm test && npm run typecheck`
Expected: all pass (the build check included).

- [ ] **Step 5: Update main spec §5.7** — still no analytics or cookies; one maintainer flag in local storage, set only by `?me=1`, cleared by `?me=0`; the footer's "· not counted". *(Added 2026-10-29.)*

- [ ] **Step 6: Commit** `web: ?me=1 marks the maintainer's searches as not counted`

---

### Task 3: Secret, dataset config, and the SQL call

**Files:**
- Modify: `pipeline/src/wts/secrets.py` (`SECRET_NAMES`)
- Modify: `pipeline/src/wts/config.py` (`analytics_dataset(name) -> str`)
- Modify: `pipeline/src/wts/cloudflare.py` (`CloudflareApi.sql`)
- Test: `pipeline/tests/test_secrets.py`, `test_config.py`, `test_cloudflare.py`

**Interfaces:**
- Produces:
  - `"cloudflare_analytics_token"` in `SECRET_NAMES` (after `cloudflare_api_token`, with a comment: read-only, used by `wts analytics pull`).
  - `Config.analytics_dataset(name: str) -> str`: `[env.<name>] analytics_dataset` or `f"wts_{name}"`; raises `click.UsageError` if it doesn't match `^[A-Za-z0-9_]+$`.
  - `CloudflareApi.sql(query: str) -> list[dict]`: POSTs `query` as `text/plain` to `/analytics_engine/sql`, same retries as `post`, returns the body's `data` list. A body with `success: false`, a non-JSON body or one without a `data` list raises `CloudflareError` (token scrubbed). `_envelope` doesn't fit (a success body has no `success` key), so factor the retry loop so `post` and `sql` share it.

- [ ] **Step 1: Write the failing tests**

```python
def test_analytics_dataset_default_and_override(): ...  # "staging" → "wts_staging"; table value wins
def test_analytics_dataset_rejects_sql(): ...            # "wts; drop" → click.UsageError
def test_sql_returns_data(httpx_mock-style fake): ...     # body {"meta": [...], "data": [{"n": "3"}], "rows": 1} → [{"n": "3"}]; request content is the SQL, header Content-Type text/plain, bearer token
def test_sql_auth_error(): ...                            # 200/403 with {"success": false, "errors": [{"code": 10000, "message": "Authentication error"}]} → CloudflareError, message has no token
def test_sql_retries_5xx(): ...                           # 502 then success; sleep called once
def test_secret_names_include_analytics_token(): ...
```
Use the fakes `test_cloudflare.py` already uses for `post`.

- [ ] **Step 2: Run, expect failures**

Run: `cd pipeline && uv run pytest -q tests/test_cloudflare.py tests/test_config.py tests/test_secrets.py`
Expected: FAIL (`sql`/`analytics_dataset` missing).

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `pipeline: analytics token, dataset config and the Analytics Engine SQL call`

---

### Task 4: `analytics.db` and the pull

**Files:**
- Modify: `pipeline/src/wts/db.py` (`connect(path, migrations="migrations")`; the log line names `path.name`)
- Create: `pipeline/src/wts/analytics_migrations/001_init.sql`, `pipeline/src/wts/analytics_migrations/__init__.py` if the package loader needs it
- Modify: `pipeline/src/wts/paths.py` (`Paths.analytics_db = app_dir / "analytics.db"`)
- Create: `pipeline/src/wts/analytics.py`
- Test: `pipeline/tests/test_analytics_pull.py`, `test_paths.py`, `test_state.py` (state.db still migrates as before)

**Interfaces:**
- Consumes: `CloudflareApi.sql`, `Config.analytics_dataset` (Task 3).
- Produces, in `analytics.py`:
  - `def open_db(path: Path) -> sqlite3.Connection` — `db.connect(path, "analytics_migrations")`.
  - `@dataclass PullResult: rows: int; first_day: date; last_day: date` (UTC days).
  - `def pull(conn, sql: Callable[[str], list[dict]], *, env: str, dataset: str, now: datetime) -> PullResult`
  - `def last_pull(conn, env: str) -> datetime | None`
- Schema (`001_init.sql`):
  ```sql
  create table points (
    env text not null, kind text not null, ts text not null,   -- ts: 'YYYY-MM-DD HH:MM:SS' UTC, as Analytics Engine returns it
    q text, mode text, sort text, cache text,
    results real, ms real, degraded real, page real, status real,
    traffic text not null default '', sample real not null default 1
  );
  create index points_env_ts on points (env, ts);
  create table pulls (env text not null, at text not null, from_ts text not null, to_ts text not null, rows integer not null);
  ```
- Pull algorithm:
  1. Window start = 00:00 UTC of the day of `max(ts)` for `env`; with no rows, 00:00 UTC of `now - 92 days`.
  2. One query per UTC day from the window start through today:
     `SELECT timestamp, index1, blob1, blob2, blob3, blob4, blob5, double1, double2, double3, double4, double5, _sample_interval FROM {dataset} WHERE timestamp >= toDateTime('{day} 00:00:00') AND timestamp < toDateTime('{next} 00:00:00') ORDER BY timestamp LIMIT 10000 FORMAT JSON`.
     If a day returns 10,000 rows, re-query it hour by hour; if an hour also returns 10,000, raise (it won't happen at this site's size; failing beats silently dropping).
  3. Map: `index1 == "search"` → q=blob1, mode=blob2, sort=blob3, cache=blob4, traffic=blob5, results..status = double1..5; `index1 == "report"` → traffic=blob1, status=double1, the rest null. Numbers may arrive as strings (UInt64); convert with `float`.
  4. One transaction: `delete from points where env = ? and ts >= ?` (window start), insert all, insert into `pulls`.
  5. If `last_pull(env)` exists and is more than 80 days before `now`, log a warning: points older than Cloudflare's ~3 months may be gone.

- [ ] **Step 1: Write the failing tests** (a fake `sql` that serves canned rows by the day in the query's `WHERE`):

```python
def test_first_pull_asks_92_days_one_query_per_day(): ...       # now=2026-10-29 12:00Z → 93 queries, first for 2026-07-29
def test_rows_are_mapped_for_search_and_report(): ...           # search row's blob5 → traffic; report row's blob1 → traffic, status from double1
def test_repull_replaces_only_the_window(): ...                 # rows on 10-27 and 10-28 stored; re-pull on 10-28 serves a changed 10-28 → 10-27 untouched, 10-28 replaced, no duplicates
def test_repull_with_nothing_new_changes_nothing(): ...
def test_capped_day_is_split_by_hour(): ...                     # 10,000 rows for a day → 24 hour queries
def test_stale_last_pull_warns(caplog): ...                     # last pull 81 days ago → warning names ~3 months
def test_dataset_is_used_in_from(): ...
```

- [ ] **Step 2: Run, expect failures**

Run: `cd pipeline && uv run pytest -q tests/test_analytics_pull.py tests/test_paths.py tests/test_state.py`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** as above.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `pipeline: analytics.db and pulling Analytics Engine by whole UTC days`

---

### Task 5: The report

**Files:**
- Create: `pipeline/src/wts/analytics_report.py`
- Test: `pipeline/tests/test_analytics_report.py`

**Interfaces:**
- Consumes: `analytics.db` schema (Task 4); `wts.evalset.cases.load_cases`, `eval_dir` (existing).
- Produces:
  - `def parse_day_range(since: str | None, until: str | None, *, today: date) -> tuple[date, date]` — `YYYY-MM-DD` or `Nd` for `since` (`7d` = today and the 6 days before); defaults `(today - 6 days, today)`; `until` alone needs `since` too or defaults since to 6 days before `until`; `since > until` → ValueError.
  - `def utc_bounds(first: date, last: date, tz: tzinfo) -> tuple[str, str]` — start of `first` and start of the day after `last`, local, converted to `'YYYY-MM-DD HH:MM:SS'` UTC.
  - `def classify(row_traffic: str, q: str | None, eval_queries: frozenset[str]) -> str` — stored class if non-empty; else `pipeline` when the normalised query, with tokens matching `\b(year|ep|after|before|include|sort):\S+` removed and re-normalised, is in `eval_queries`, or starts with `budget ` or `killswitch check`, or contains `\bz[qz]\d+\b`; else `web`.
  - `def eval_query_set(directory: Path | None = None) -> frozenset[str]` — normalised `query` of every case.
  - `def normalise(q: str) -> str` — `" ".join(q.lower().split())`.
  - `def summarise(conn, *, env: str, first: date, last: date, tz: tzinfo, top: int, include_all: bool, eval_queries: frozenset[str]) -> str`
- Output, in order (layout and widths are the implementer's; these headings and facts are fixed):
  1. `Searches on staging, 2026-10-23 – 2026-10-29 (last pulled 2026-10-29 21:40)` and `left out: 812 pipeline, 40 maintainer` (omitted with `--all` or when nothing was left out).
  2. Totals: searches, distinct queries, by mode (exact / related / smart), sorts other than relevance, reports sent.
  3. `Top searches` — count, average results, query (most common spelling in the group).
  4. `Found nothing` — searches with results 0 and status 200: count, mode, query.
  5. `Errors and degraded` — counts by status ≠ 200 and degraded, each with its top queries; the line `none` when empty.
  6. `Speed` — p50 and p95 ms per mode for cache miss and for hit (weighted by `sample`), mode rows with no points left out.
  With no searches in the range: the header, then `no searches in this range`.

- [ ] **Step 1: Write the failing tests** (rows inserted straight into an `open_db(tmp)`):

```python
def test_parse_day_range_defaults_and_nd(): ...         # today 2026-10-29: (None,None) → (10-23,10-29); "7d" → same; "2026-10-01" → (10-01,10-29)
def test_parse_day_range_rejects_reversed(): ...
def test_local_day_bounds(): ...                        # America/Los_Angeles, 2026-10-29 → ('2026-10-29 07:00:00', '2026-10-30 07:00:00'); a row at '2026-10-30 03:49:31' falls on the 29th
def test_classify_old_rows(): ...                       # '' + "Conoid" with eval {"conoid"} → pipeline; "sketchup year:2014" with eval {"sketchup"} → pipeline; "budget test 1 1793329063 walnut" → pipeline; "chisel zq24446" → pipeline; "hide glue" → web; stored "maintainer" stays
def test_counts_use_sample(): ...                       # one row with sample 10 counts as 10
def test_groups_spellings(): ...                        # "Hide Glue", "hide  glue", "hide glue" → one group shown as the most common spelling
def test_default_leaves_out_our_traffic(): ...          # pipeline + maintainer rows absent from lists; header says how many
def test_include_all(): ...
def test_found_nothing_lists_zero_result_200s_only(): ...
def test_empty_range(): ...                             # → contains "no searches in this range"
def test_rows_with_empty_fields(): ...                  # status 0, mode '', q None: no exception, counted under errors
```

- [ ] **Step 2: Run, expect failures**

Run: `cd pipeline && uv run pytest -q tests/test_analytics_report.py`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** Percentile: sort by ms, take the first value whose cumulative weight reaches p × total weight.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `pipeline: the analytics summary, leaving out our own traffic`

---

### Task 6: `wts analytics pull|report` and the docs

**Files:**
- Modify: `pipeline/src/wts/cli.py` (a new `analytics` group after `logs`)
- Test: `pipeline/tests/test_analytics_cli.py` (click `CliRunner`, `WTS_HOME` in a tmp dir, fake secret store and SQL as other CLI tests do)
- Modify: main spec §3.6 (the secret), §8.4 (both commands as built; drop "run weekly by `wts run`" and "drives the weekly digest" in favour of "later"), command table row at line ~231
- Modify: `docs/HANDOFF.md` items 14 and 16, and a "how to" line for `?me=1`
- Modify: `pipeline/README.md` command list if it lists commands
- Backup: no change. `wts backup` rsyncs the app directory and excludes only `state.db*`, so `analytics.db` is already copied; `pull` and `backup` don't run at the same time (decided here, spec §5 left it open).

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `wts analytics pull [--env]`: env = `--env` or `run_env` (UsageError naming the config file when neither); needs `cloudflare_account_id` and the secret (`MissingSecret`'s message already says how to set it); prints `pulled N points for <first>..<last> (<env>)` then `summarise` for the default range.
  - `wts analytics report [--env] [--since] [--until] [--top N=20] [--all]`: no network; a bad `--since`/`--until` is `click.BadParameter` on that option; with no pulls for the env: `no analytics pulled for <env> yet; run wts analytics pull`, exit 1.
  - Local time zone: `datetime.now().astimezone().tzinfo`.

- [ ] **Step 1: Write the failing tests**

```python
def test_pull_then_summary(): ...            # fake sql serves two rows for today → output has "pulled 2 points" and "Top searches"
def test_pull_missing_secret(): ...          # message names `wts secrets set cloudflare_analytics_token`, exit ≠ 0
def test_report_before_any_pull(): ...       # message and exit 1
def test_report_bad_since(): ...             # "--since yesterday" → BadParameter on --since
def test_report_does_not_touch_network(): ... # the SQL fake raises if called
```

- [ ] **Step 2: Run, expect failures**

Run: `cd pipeline && uv run pytest -q tests/test_analytics_cli.py`
Expected: FAIL (no such command).

- [ ] **Step 3: Implement** the group; update the spec, HANDOFF and README.

- [ ] **Step 4: Run the whole pipeline suite and lint**

Run: `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass, no lint errors.

- [ ] **Step 5: Commit** `pipeline: wts analytics pull and report; docs`

- [ ] **Step 6: Live check (on the Mac):** `uv run wts analytics pull --env staging`. Expected: ~5,700+ points pulled; the summary's `left out` line shows most of them as pipeline. Then `uv run wts analytics report --since 2026-10-07 --all` shows the eval questions on top.

---

## After the plan

The maintainer deploys Tasks 1–2 (`cd worker && npm run deploy:staging`), then opens the site with `?me=1` on each device and checks the footer says "· not counted".
