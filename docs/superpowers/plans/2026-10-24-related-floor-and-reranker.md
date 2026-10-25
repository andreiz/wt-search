# Related: Similarity Floor and Reranker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Related drops Vectorize hits below a similarity floor (0.62), can rerank what is left
with `@cf/baai/bge-reranker-base` behind a var, and both can be measured from one deploy with
`wts eval run --param`.

**Architecture:** All of it is in the Worker's related path (`relatedSearch` in
`worker/src/search.ts`): the floor filters `nearestChunks`' list, the reranker reorders the rows
`loadRelated` returns. `debug=1` requests may override both settings; the pipeline's eval runner
passes those overrides through and records them.

**Tech Stack:** Cloudflare Worker (TypeScript, Vitest in the Workers runtime), Workers AI,
Python `wts` CLI (pytest, respx).

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §4.4 (`related`: "A
similarity floor", "A reranker", "Measuring them"; `debug=1`), §7.2.

## Global Constraints

- `RELATED_FLOOR` = 0.62. Related only: `smart` keeps no floor.
- `RELATED_RERANK` = `on` turns the reranker on; anything else, or unset, is off. Off by default
  in both environments until Checkpoint M says otherwise.
- Overrides are read only when `debug=1`: `floor=<number in [0, 1]>`, `rerank=0|1`. Anything
  else is ignored (the setting stands).
- Rerank: at most 50 passages (`SMART_LIST_SIZE`), one AI call, after the floor and the
  exact-mode exclusion, before sort-by-date and collapse. A failed or malformed reranker answer
  keeps Vectorize's order, logs `rerank_unavailable`, and is not `smart_degraded`.
- `debug` per result in related mode gains `rerank_rank` and `rerank_score` (null when not
  reranked).
- Bump `API_VERSION` (cache.ts) to 5: the floor changes what a stored answer holds. The cache key
  also carries `rerank` (`on`/`off`) for related mode.
- Commit messages end with the session's attribution lines. Edit files with the Edit tool.

## Review Focus

- A reranker answer whose ids are out of range, duplicated or missing: every loaded row must
  still appear exactly once (unscored ones after the scored, in Vectorize order).
- `floor=` values that are not numbers, negative, above 1 or empty: the default stands.
- A floor that removes every hit: an empty, non-degraded answer (no `smart_degraded`), so the
  page shows "nothing to show", not "unavailable".
- `sort=newest` with reranking on: date order still wins, and the result set equals the
  unreranked one (reranking reorders; it never adds or drops a hit).
- The cache: a related answer stored with reranking off must not be served with it on.

---

### Task 1: The similarity floor (Worker)

**Files:**
- Modify: `worker/src/search.ts` (constants near `SMART_LIST_SIZE`; `relatedSearch`; options type)
- Modify: `worker/src/index.ts` (read `floor` when `debug`)
- Modify: `worker/src/cache.ts` (`API_VERSION` 5 with a comment line)
- Test: `worker/test/search-related.test.ts`

**Interfaces:**
- Produces: `export const RELATED_FLOOR = 0.62;` and
  `export function parseFloor(value: string | null): number | undefined` in `search.ts`;
  `relatedSearch(..., options: { ...; floor?: number })`.

- [ ] **Step 1: Write the failing tests** in `search-related.test.ts`. The fake Vectorize gives
  scores `0.9 - i/1000`; add a variant that takes explicit scores:

```ts
function fakeVecScored(matches: [number, number][]) {
  return {
    query: vi.fn(async () => ({
      count: matches.length,
      matches: matches.map(([id, score]) => ({ id: String(id), score })),
    })),
  };
}

describe("the similarity floor (spec §4.4)", () => {
  it("drops hits below 0.62 and keeps the rest in Vectorize's order", async () => {
    const body = await related({ q: "dovetail" }, [], {
      VEC: fakeVecScored([[3102, 0.7], [3002, 0.619], [3103, 0.62]]),
    });
    expect(ids(body)).toEqual([3102, 3103]);
  });

  it("with every hit below it, answers no results and is not degraded", async () => {
    const body = await related({ q: "dovetail" }, [], { VEC: fakeVecScored([[3102, 0.5]]) });
    expect(body.results).toEqual([]);
    expect(body.smart_degraded).toBeUndefined();
  });

  it("debug=1&floor= overrides it; a bad floor is ignored", async () => {
    const vec = () => fakeVecScored([[3102, 0.7], [3103, 0.65]]);
    expect(ids(await related({ q: "dovetail", debug: "1", floor: "0.68" }, [], { VEC: vec() }))).toEqual([3102]);
    expect(ids(await related({ q: "dovetail", debug: "1", floor: "0" }, [], { VEC: vec() }))).toEqual([3102, 3103]);
    for (const bad of ["", "x", "-0.1", "1.5"]) {
      expect(ids(await related({ q: "dovetail", debug: "1", floor: bad }, [], { VEC: vec() }))).toEqual([3102, 3103]);
    }
  });

  it("ignores floor= without debug=1", async () => {
    const body = await related({ q: "dovetail", floor: "0.68" }, [], {
      VEC: fakeVecScored([[3102, 0.7], [3103, 0.65]]),
    });
    expect(ids(body)).toEqual([3102, 3103]);
  });
});
```

  And in a smart-mode test file (`search-smart.test.ts`), one test that a 0.5 Vectorize hit is
  still fused in smart mode (no floor there), following that file's existing fakes.

- [ ] **Step 2: Run them.** `cd worker && npx vitest run test/search-related.test.ts`
  Expected: the floor tests FAIL (0.619 and 0.5 hits are returned).

- [ ] **Step 3: Implement.** In `search.ts`:

```ts
/** Related drops Vectorize hits less similar than this (spec §4.4, chosen by replay, §7.2). */
export const RELATED_FLOOR = 0.62;

/** A `floor=` override (debug only): a number in [0, 1], else undefined (the default stands). */
export function parseFloor(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}
```

  In `relatedSearch`, add `floor?: number` to the options, default `RELATED_FLOOR`, and right
  after `nearest` is known (and not null):

```ts
const kept = nearest.filter((n) => n.score >= floor);
```

  Use `kept` wherever `nearest` was used below (ids, debug `vector_hits` stays
  `nearest.length`, and `dropped` also lists the ids under the floor). In `index.ts`, pass
  `floor: parseFloor(params.get("floor"))` only when `debug` and `mode === "related"`
  (omit the key when undefined). In `cache.ts`, set `API_VERSION = 5` and add
  `5: Related's similarity floor (2026-10-24).` to its comment list.

- [ ] **Step 4: Run the Worker suite.** `cd worker && npm test && npx tsc --noEmit`
  Expected: all pass, type-check clean. Fix any related test whose fake scores fall under 0.62
  by raising the fake's scores, never by lowering the floor.

- [ ] **Step 5: Commit.**

```bash
git add worker/src/search.ts worker/src/index.ts worker/src/cache.ts worker/test/search-related.test.ts worker/test/search-smart.test.ts
git commit -m "worker: Related drops Vectorize hits under similarity 0.62; debug=1&floor= overrides it"
```

### Task 2: The reranker (Worker)

**Files:**
- Modify: `worker/src/search.ts` (`RERANK_MODEL`, `rerank()`, `relatedSearch`)
- Modify: `worker/src/api-types.ts` (`ResultDebug`: `rerank_rank?`, `rerank_score?`)
- Modify: `worker/src/env.ts` (`RELATED_RERANK?: string` with a doc comment)
- Modify: `worker/src/index.ts` (resolve `rerank`; cache key)
- Modify: `worker/src/cache.ts` (`SearchKey.rerank?: boolean`, set in the key for related)
- Modify: `worker/wrangler.jsonc` (a commented `RELATED_RERANK` line under each env's vars, off)
- Test: `worker/test/search-related.test.ts`, `worker/test/cache.test.ts`

**Interfaces:**
- Consumes: Task 1's `relatedSearch` options and `kept` list.
- Produces: `export const RERANK_MODEL = "@cf/baai/bge-reranker-base";`, a private
  `rerankRows(env, query, rows)`,
  `relatedSearch(..., options: { ...; rerank?: boolean })`,
  `export function rerankFlag(env: Pick<Env, "RELATED_RERANK">, override: string | null, debug: boolean): boolean`.

- [ ] **Step 1: Write the failing tests.** A fake AI that answers both models:

```ts
function fakeAiRerank(scores: Record<string, number> | Error | unknown) {
  return {
    run: vi.fn(async (model: string, inputs: { contexts?: { text?: string }[] }) => {
      if (model !== "@cf/baai/bge-reranker-base") return { shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" };
      if (scores instanceof Error) throw scores;
      if (typeof scores !== "object" || scores === null) return scores;
      // Score each context by a word it contains, so tests read clearly.
      return {
        response: (inputs.contexts ?? []).map((c, id) => ({
          id,
          score: Object.entries(scores as Record<string, number>).find(([w]) => c.text?.includes(w))?.[1] ?? 0,
        })),
      };
    }),
  };
}

describe("the reranker (spec §4.4)", () => {
  const vec = () => fakeVecScored([[3102, 0.8], [3103, 0.75], [3002, 0.7]]);

  it("is off by default: Vectorize's order, no rerank call", async () => {
    const ai = fakeAiRerank({ biscuit: 1 });
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai });
    expect(ids(body)).toEqual([3102, 3103, 3002]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("with RELATED_RERANK=on, orders by the reranker's score", async () => {
    const ai = fakeAiRerank({ "half blind": 0.9, "hand cut": 0.5, router: 0.1 });
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai, RELATED_RERANK: "on" });
    expect(ids(body)).toEqual([3103, 3002, 3102]);
    const call = ai.run.mock.calls.find(([m]) => m === "@cf/baai/bge-reranker-base")!;
    expect(call[1]).toMatchObject({ query: "dovetail" });
    // Plain text: no highlight markers.
    expect(JSON.stringify(call[1])).not.toMatch(/\\u000[12]/);
  });

  it("debug=1&rerank=1 turns it on, rerank=0 off, and debug carries its rank and score", async () => {
    const on = await related({ q: "dovetail", debug: "1", rerank: "1" }, [], {
      VEC: vec(), AI: fakeAiRerank({ "half blind": 0.9, "hand cut": 0.5, router: 0.1 }),
    });
    expect(on.results[0]!.debug).toMatchObject({ rerank_rank: 1, rerank_score: 0.9, vector_rank: 2 });
    const off = await related({ q: "dovetail", debug: "1", rerank: "0" }, [], {
      VEC: vec(), AI: fakeAiRerank({ "half blind": 0.9 }), RELATED_RERANK: "on",
    });
    expect(ids(off)).toEqual([3102, 3103, 3002]);
    expect(off.results[0]!.debug).toMatchObject({ rerank_rank: null, rerank_score: null });
  });

  it.each([
    ["an error", new Error("AI down")],
    ["no response", {}],
    ["a non-object", "nonsense"],
  ])("keeps Vectorize's order when the reranker gives %s, and is not degraded", async (_name, answer) => {
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: fakeAiRerank(answer), RELATED_RERANK: "on" });
    expect(ids(body)).toEqual([3102, 3103, 3002]);
    expect(body.smart_degraded).toBeUndefined();
  });

  it("puts rows the reranker left out after the scored ones, each row once", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/baai/bge-reranker-base"
          ? { response: [{ id: 2, score: 0.9 }, { id: 2, score: 0.8 }, { id: 99, score: 1 }] }
          : { shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" }),
    };
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai, RELATED_RERANK: "on" });
    expect(ids(body)).toEqual([3002, 3102, 3103]);
  });

  it("with sort=newest, date order wins and the set is the same", async () => {
    const body = await related({ q: "dovetail", sort: "newest" }, [], {
      VEC: vec(), AI: fakeAiRerank({ router: 0.9 }), RELATED_RERANK: "on",
    });
    expect(new Set(ids(body))).toEqual(new Set([3102, 3103, 3002]));
  });
});
```

  In `cache.test.ts`, one test that `cacheKey` for related mode with `rerank: true` differs
  from the same key with `rerank: false`, and that exact mode ignores `rerank`.

- [ ] **Step 2: Run them.** `cd worker && npx vitest run test/search-related.test.ts test/cache.test.ts`
  Expected: the reranker and cache tests FAIL.

- [ ] **Step 3: Implement.**

```ts
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** RELATED_RERANK=on, unless a debug request says rerank=0|1. */
export function rerankFlag(env: Pick<Env, "RELATED_RERANK">, override: string | null, debug: boolean): boolean {
  if (debug && (override === "0" || override === "1")) return override === "1";
  return env.RELATED_RERANK === "on";
}

const MARKS = /[\u0001\u0002]/g;

/**
 * The rows in the reranker's order (best first), with each one's rank and score; rows it did
 * not score follow in their given order. Null when the call fails or answers nothing usable
 * (the caller keeps Vectorize's order).
 */
async function rerankRows(
  env: Pick<Env, "AI">,
  query: string,
  rows: Row[],
): Promise<{ rows: Row[]; scores: Map<number, { rank: number; score: number }> } | null> {
  let output: unknown;
  try {
    // The workers-types input type lacks `query`, though the model takes it.
    output = await env.AI.run(RERANK_MODEL, {
      query,
      contexts: rows.map((r) => ({ text: r.marked.replace(MARKS, "") })),
    } as unknown as Ai_Cf_Baai_Bge_Reranker_Base_Input);
  } catch {
    return null;
  }
  const response = (output as { response?: unknown } | null)?.response;
  if (!Array.isArray(response)) return null;
  const best = new Map<number, number>();
  for (const item of response as { id?: unknown; score?: unknown }[]) {
    if (typeof item?.id !== "number" || typeof item.score !== "number") continue;
    if (!Number.isInteger(item.id) || item.id < 0 || item.id >= rows.length || best.has(item.id)) continue;
    best.set(item.id, item.score);
  }
  if (best.size === 0) return null;
  const order = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const rest = rows.map((_, i) => i).filter((i) => !best.has(i));
  const scores = new Map(order.map((i, rank) => [rows[i]!.id, { rank: rank + 1, score: best.get(i)! }]));
  return { rows: [...order, ...rest].map((i) => rows[i]!), scores };
}
```

  In `relatedSearch`: add `rerank?: boolean` and `onRerankFailed?: (err: unknown) => void` to
  the options; after `hits` is built from `kept` and before `sortByDate`:

```ts
let reranked: Map<number, { rank: number; score: number }> | null = null;
if (rerank && hits.length > 1) {
  const answer = await rerankRows(env, parsed.semantic, hits);
  if (answer) {
    hits = answer.rows;
    reranked = answer.scores;
  } else {
    onRerankFailed();
  }
}
```

  In the debug mapping add
  `rerank_rank: reranked?.get(r.chunk_id)?.rank ?? null, rerank_score: reranked?.get(r.chunk_id)?.score ?? null`.
  `ResultDebug` gets the two fields as optional `number | null`. In `index.ts`, for related
  mode compute `const rerank = rerankFlag(env, params.get("rerank"), debug)`, pass
  `rerank` and `onRerankFailed: () => logError("rerank_unavailable", request, null)`, and put
  `rerank` in the cache key (`SearchKey.rerank`, set only for related; `cacheKey` adds
  `rerank=on|off` to the URL when the field is present). `env.ts`: document `RELATED_RERANK`
  ("on" reranks Related, spec §4.4; a var, off when unset). `wrangler.jsonc`: under staging's
  and production's vars, a comment line `// "RELATED_RERANK": "on" reranks Related (spec §4.4); off until measured.`

- [ ] **Step 4: Run the Worker suite.** `cd worker && npm test && npx tsc --noEmit`
  Expected: all pass, type-check clean.

- [ ] **Step 5: Commit.**

```bash
git add worker/src worker/test worker/wrangler.jsonc
git commit -m "worker: Related can rerank with bge-reranker-base (RELATED_RERANK=on, or debug rerank=1)"
```

### Task 3: `wts eval run --param` (pipeline)

**Files:**
- Modify: `pipeline/src/wts/search.py` (`search(..., extra: dict[str, str] | None = None)`)
- Modify: `pipeline/src/wts/evalset/run.py` (`ask`/`run_cases`/`build_report` take `params`)
- Modify: `pipeline/src/wts/cli.py` (`eval run --param KEY=VALUE`, repeatable)
- Modify: `eval/README.md` (one example line)
- Test: `pipeline/tests/test_search.py` (or the file that tests `search()`), `pipeline/tests/test_eval_run.py`

**Interfaces:**
- Produces: `search(client, api_url, q, *, mode, sort, page, debug, sleep, extra=None)`;
  `run_cases(client, api_url, cases, *, sleep, progress, params=None)`; the report's top level
  gains `"params": {"floor": "0.66"}` (`{}` without any).

- [ ] **Step 1: Write the failing tests.**

```python
def test_search_sends_extra_params(respx_mock):
    route = respx_mock.get("https://api.example/api/search").mock(
        return_value=httpx.Response(200, json={"results": [], "has_more": False}))
    with new_client() as client:
        search(client, "https://api.example", "glue", mode="related", debug=True,
               extra={"floor": "0.66", "rerank": "1"})
    sent = route.calls[0].request.url.params
    assert sent["floor"] == "0.66" and sent["rerank"] == "1" and sent["debug"] == "1"
```

```python
def test_params_go_with_related_requests_only_and_into_the_report(respx_mock):
    # One `both` case: the exact request has no params, the related one has them.
    ...  # follow test_eval_run.py's existing fixtures for a case and a fake API
    assert exact_request.url.params.get("floor") is None
    assert related_request.url.params["floor"] == "0.66"
    assert report["params"] == {"floor": "0.66"}


def test_cli_param_must_be_key_equals_value(wts_home):
    r = CliRunner().invoke(main, ["eval", "run", "--param", "floor"])
    assert r.exit_code == 2 and "KEY=VALUE" in r.output


def test_cli_update_refuses_params(wts_home):
    # A baseline is the deployed settings, not an experiment.
    r = CliRunner().invoke(main, ["eval", "run", "--update", "--param", "floor=0.7"])
    assert r.exit_code == 2 and "--param" in r.output
```

- [ ] **Step 2: Run them.** `cd pipeline && uv run pytest -q tests/test_eval_run.py tests/test_search.py`
  Expected: FAIL (`extra` and `--param` don't exist).

- [ ] **Step 3: Implement.** `search()` merges `extra` into `params` after the standard ones.
  `ask()` passes `extra=params` only for `mode == "related"` (that request already has
  `debug=1`). `build_report` writes `"params": params or {}`, and `format_report` prints
  `params: floor=0.66 rerank=1` under the header line when there are any. The CLI option:

```python
@click.option("--param", "params", multiple=True, metavar="KEY=VALUE",
              help="Send with every Related request (debug overrides, e.g. floor=0.66, rerank=1).")
```

  parsed into a dict (`click.BadParameter("use KEY=VALUE")` on a missing `=`), and
  `click.UsageError("--update records the deployed settings; leave out --param")` with
  `--update`.

- [ ] **Step 4: Run the pipeline suite.** `cd pipeline && uv run pytest -q && uv run ruff check .`
  Expected: all pass, lint clean.

- [ ] **Step 5: Commit.**

```bash
git add pipeline/src pipeline/tests eval/README.md
git commit -m "eval run: --param KEY=VALUE sends debug overrides with Related requests and records them"
```

### Checkpoint M (maintainer): measure on staging

1. `cd worker && npm run deploy:staging` (floor on at 0.62, reranker off).
2. `cd pipeline && uv run wts eval run` — compared with the baseline: expect `hvlp-sprayer-2020`
   to pass and no regression line. If paraphrase recall drops more than 0.02, the replay missed
   something: stop and look at the report.
3. `uv run wts eval run --param rerank=1` — the reranker over the same deploy. Read the
   negatives, paraphrase recall and the time hit rate against step 2's report.
4. Optional: `--param floor=0.60`, `--param floor=0.66` to see the real effect of hits 11–20
   moving up, which the replay couldn't.
5. Decide with the maintainer: turn `RELATED_RERANK` on for staging (a var in `wrangler.jsonc`,
   then deploy), or leave it off. Then `uv run wts eval run --update` records the new baseline,
   and the decision goes into spec §4.4 and `docs/HANDOFF.md`.
