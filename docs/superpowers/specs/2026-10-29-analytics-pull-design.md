# `wts analytics pull` and `report`: what people search for

**Status:** draft for the maintainer's review, 2026-10-29.
**Changes:** spec §3.6 (one new secret), §4.x/§8.3 (a traffic column in Analytics Engine),
§5.7 (a maintainer switch kept in local storage), §8.4 (the commands as built).
**Builds on:** HANDOFF backlog items 14 (weekly digest) and 16 (keep our own traffic out).

## Why

The Worker already records one Analytics Engine point per search (spec §8.3): the query, mode,
sort, cache, results, latency, degraded, page and status. Cloudflare keeps it about 3 months,
and the only way to read it today is hand-written SQL against Cloudflare's API, which is what we
did on 2026-10-29. That first look showed the second problem: of 5,689 searches logged
2026-10-07..29, none came from outside. About 95% were the eval and its experiments; the rest
were the maintainer's hand tests and test traffic.

The maintainer wants this soon, before launch, so that when the hosts and listeners start
using the site, what they search for (and what finds nothing) is one command away. It's the
raw material for corrections, test cases and fixes.

## Goals

1. `wts analytics pull` copies new points from Analytics Engine into a local `analytics.db` on
   the Mac, so the history outlives Cloudflare's 3 months, then prints the summary for the
   last 7 days.
2. `wts analytics report` prints the same summary from `analytics.db` for any date range,
   without contacting Cloudflare.
3. The summary leaves out our own searches by default: the eval, smoke searches, `wts search`,
   test traffic, and the maintainer's own browsing once they've switched it on.

## Non-goals

- The weekly email digest (item 14). It will reuse the summary; how mail is sent is still open.
- Running `pull` from `wts run`. Easy to add later; not now.
- Page events beyond searches (item 12).
- A production dataset in use. The design takes `--env` and works for production once it exists.

## Anti-goals

- Logging anything that identifies a visitor: no IP addresses, cookies, user agents or
  headers stored. The new column records only a class (`pipeline`, `maintainer`, `web`).
- Changing anything a visitor sees, or what the footer says about logging.

## 1. Telling our traffic apart

### 1.1 Going forward: a traffic class in the Worker

`recordSearch` gets a new field, written as **blob5** after the existing four (old rows read as
an empty string):

| Value | When |
|---|---|
| `pipeline` | the request's `User-Agent` starts with `WoodTalkSearchBot/`. Every pipeline client already sends it (`pipeline/src/wts/net.py`): `wts eval run`, the smoke search after `wts run`, `wts search`. No pipeline change. |
| `maintainer` | the request carries `X-WTS-Traffic: maintainer` (§1.2). |
| `web` | anything else. |

`pipeline` wins if both apply. The header is not secret; anyone sending it only hides their own
searches. The Worker reads the two headers and keeps nothing but the class. The `report` data
point gets the same class (as its blob1) so reports sent during testing can be told apart too.

Other clients we use by hand (`curl` in experiments) count as `web`. That is acceptable: they
are rare, and before launch everything is ours anyway (§1.3).

### 1.2 The maintainer's browser switch

- Opening the site with `?me=1` stores `wts-traffic=maintainer` in `localStorage`; `?me=0`
  removes it. The parameter is removed from the address bar afterwards (`history.replaceState`)
  so it isn't bookmarked or shared by accident.
- While the flag is set, every `/api/*` request from `web/src/lib/api.ts` adds the header
  `X-WTS-Traffic: maintainer`. Same-origin, so no CORS change; the Worker's response cache is
  keyed by URL, so the header doesn't split it.
- Local storage, not a cookie: it never travels to the server on its own, and visitors who never
  open `?me=1` have nothing stored. Reading or writing it is wrapped in try/catch (private
  windows, blocked storage); failing means the searches count as `web`.
- *(My call:)* the footer shows "· not counted" after "Unofficial · fan-made" while the flag is
  set, so the maintainer can see the switch is on. Visitors never see it.
- Done once per device (Mac, phone, iPad), and again after clearing site data.
- *(My call:)* `web/src/lib/api.ts` stays free of DOM access: a small helper reads the flag and
  passes it in. `?me=` is handled at startup, before the first search fires, so a link with
  both `?me=1` and `q=` counts that first search correctly.

### 1.3 Searches logged before the traffic class

Rows with an empty blob5 are classed **at report time** (not stored), so editing the eval files
later re-classes them:

- `pipeline` if the query, normalised (§3.2) and with filter tokens (`year:`, `ep:`, `after:`,
  `before:`, `include:`, `sort:`) removed, matches a `query:` in `eval/queries.yaml` or
  `eval/synthetic.yaml`, or matches the test patterns: starts with `budget ` or
  `killswitch check`, or contains a cache-busting token (`zq` or `zz` followed by digits).
- otherwise `web`.

This is a best effort: one-off experiment queries and the maintainer's hand tests from before
the switch still show as `web`. The simple answer for those is the date range: everything
before launch is ours, so `--since <launch date>` drops it.

## 2. `analytics.db` and `wts analytics pull`

### 2.1 Where and what

- `analytics.db` in the app directory beside `state.db` (spec §3.0 already names it), its own
  SQLite file with its own small migration list (as `state.db` has).
- One table of points:
  `points(env, kind, ts, q, mode, sort, cache, results, ms, degraded, page, status, traffic,
  sample)`, where `kind` is `search` or `report`, `ts` is UTC (as Analytics Engine returns it),
  `traffic` is blob5 as stored (empty for old rows), and `sample` is `_sample_interval`.
  Index on `(env, ts)`.
- One table of pulls: `pulls(env, at, from_ts, to_ts, rows)`, for `wts analytics report` to say
  how fresh the data is, and for the gap warning (§2.3).

### 2.2 Reading Analytics Engine

- `POST https://api.cloudflare.com/client/v4/accounts/<cloudflare_account_id>/analytics_engine/sql`,
  body the SQL text, bearer token from the new Keychain secret **`cloudflare_analytics_token`**
  (Account Analytics: Read; the maintainer created it 2026-10-29). Add it to `SECRET_NAMES` so
  `wts secrets set` accepts it; it is needed only by `pull`.
- The pipeline's `cloudflare_api_token` stays scoped to D1 and Vectorize; it is not widened.
- Dataset per environment: `[env.<name>] analytics_dataset` in `config.toml`, defaulting to
  `wts_<name>` (`wts_staging`, `wts_production`, as in `worker/wrangler.jsonc`). *(My call.)*
- Select every column the table stores, `FORMAT JSON`, ordered by timestamp.
- Errors (auth, HTTP, malformed JSON) reuse the pipeline's existing scrubbed error style
  (`describe_http_error`); the token never appears in a message.

### 2.3 Incremental pulls without row ids

Analytics Engine rows have no id, and a point can land a little after its timestamp. So a pull
**replaces whole UTC days** instead of appending:

1. Window start: the start of the UTC day before the newest stored `ts` for this env, but no
   more than 80 days back; on the first pull, 92 days ago (everything Cloudflare still has).
   *(Revised 2026-10-30 after the final review: starting at the newest stored day itself would
   delete that day if Cloudflare had already dropped it, after a long gap or a quiet env, and
   would miss a point stamped just before midnight UTC that arrived after a pull.)*
2. Fetch the window up to now, one query per UTC day (so no response gets large; if a day
   comes back at the query's row cap, split it further — the builder's call how).
3. In one transaction: delete this env's rows with `ts` ≥ window start, insert what was
   fetched, record the pull.
4. If the previous pull for this env is older than 80 days, warn that points older than
   Cloudflare's retention may already be gone.

Re-running `pull` is safe and changes nothing if no new points arrived.

### 2.4 Output

`pull` prints one line (`pulled 1,032 points for 2026-10-29..30 (staging)`), then the report for
the last 7 days (§3).

## 3. `wts analytics report`

### 3.1 Command

```
wts analytics report [--env staging|production] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                     [--top N] [--all]
```

- `--env` defaults to `run_env`, as everywhere.
- Dates are local days (the Mac's time zone), inclusive. Defaults: the last 7 days, today
  included. `--since` alone runs to today. *(My call: also accept `7d`/`30d` for `--since`, as
  `wts logs` does.)*
- `--top N` (default 20) caps each list.
- `--all` includes every traffic class; by default only `web` counts.
- Works with no network. With no pulls yet, it says to run `wts analytics pull`.

### 3.2 What it prints

Counts use `sum(sample)`, not row counts (Analytics Engine samples under load). Queries are
grouped normalised: lower case, whitespace collapsed and trimmed; each group is shown as its
most common spelling.

1. A header: the env, the range in local dates, when data was last pulled, and what was left
   out (`left out: 812 pipeline, 40 maintainer`).
2. Totals: searches, distinct queries; split by mode (Exact / Related / Smart) and by sort
   when it isn't relevance; reports sent.
3. **Top searches**: count, average results, query.
4. **Searches that found nothing** (results 0 and status 200): count, mode, query.
5. **Errors and degraded**: count by status other than 200, and degraded count, with the top
   queries for each (often empty).
6. **Speed**: p50 and p95 latency per mode, for cache misses and for hits.

Plain text for the terminal; no `--json` for now *(my call; SQL on `analytics.db` covers
anything else)*.

## 4. Spec and doc updates

- §3.6: the new secret.
- §8.3: blob5 for searches, blob1 for reports, with the three values.
- §5.7: the frontend still has no analytics or cookies; it may hold one maintainer flag in local
  storage, set only by `?me=1`.
- §8.4: both commands as built.
- HANDOFF: items 14 and 16 updated; the `?me=1` step in the "how to" notes.

## 5. Left to the builder

- Module layout (`wts/analytics.py` or a package), the migration mechanism, the exact report
  layout and column widths.
- How a capped day is split (§2.3).
- Whether `wts backup` needs a snapshot step for `analytics.db` like `state.db`'s, or rsync of
  the file is enough given `pull` and `backup` don't run at the same time.
- Tests: pipeline tests with a fake Analytics Engine response (no network); Worker tests for
  the three classes; frontend tests for `?me=1`/`?me=0`, the header, the footer note, and
  storage that throws.

## 6. Order and who runs what

1. Worker and frontend change, deployed by the maintainer (`npm run deploy:staging`), then
   `?me=1` on each device.
2. Pipeline: secret, `analytics.db`, `pull`, `report`. Usable before step 1 ships; the old-row
   classing (§1.3) covers until then.
