// POST /api/report (spec §4.4, §5): a listener reports a transcript error on a passage, or
// (with no chunk_id) sends general feedback from the site's footer.
//
// Order: check the body, then Turnstile, then one INSERT. Turnstile comes before anything is
// written, so a bot gets no database work; the body comes before Turnstile, so a malformed
// request costs no siteverify call. Report text and the token are never logged (spec §8.3):
// the log lines carry only the event and the error message of the failing call.

import type { Env } from "./env";
import { originAllowed } from "./guard";
import { json, logError } from "./http";

/** Cloudflare's token check (Turnstile server-side validation). */
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The body's length in UTF-16 units, checked before it is parsed. */
export const MAX_BODY_CHARS = 16 * 1024;
/** What is read of a body at all, and the largest Content-Length accepted: UTF-8 takes at most 3 bytes per UTF-16 unit. */
const MAX_BODY_BYTES = MAX_BODY_CHARS * 3;
/** Lengths in characters (code points), after trimming. */
export const MAX_QUOTED = 500;
export const MAX_SUGGESTED = 500;
export const MAX_NOTE = 1000;
export const MAX_TOKEN = 2048;
/** siteverify normally answers in well under a second; past this the check fails closed. */
const SITEVERIFY_TIMEOUT_MS = 5000;

/**
 * A report that passed the checks on its own: trimmed, optional fields NULL when empty.
 * General feedback has `chunk_id` null, and so no quoted or suggested text.
 */
export interface ReportFields {
  chunk_id: number | null;
  quoted_text: string | null;
  suggested_text: string | null;
  note: string | null;
  turnstile_token: string;
}

/** Characters as a person counts them: an emoji is one, not two UTF-16 code units. */
function length(s: string): number {
  return Array.from(s).length;
}

// A lone surrogate half cannot be encoded as UTF-8, so D1 could not store it faithfully.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** A string field: trimmed, at most `max` characters. `required` rejects an empty one; optional ones become null. */
function textField(value: unknown, label: string, max: number, required: boolean): Checked<string | null> {
  if (value === undefined || value === null) {
    return required ? { ok: false, message: `Please include the ${label}.` } : { ok: true, value: null };
  }
  if (typeof value !== "string") return { ok: false, message: `The ${label} must be text.` };
  if (LONE_SURROGATE.test(value)) return { ok: false, message: `The ${label} has characters we can't store.` };
  const trimmed = value.trim();
  if (trimmed === "") {
    return required ? { ok: false, message: `Please include the ${label}.` } : { ok: true, value: null };
  }
  if (length(trimmed) > max) return { ok: false, message: `The ${label} is too long (at most ${max} characters).` };
  return { ok: true, value: trimmed };
}

/**
 * Check the raw body text. The message says what to fix and never echoes what was sent.
 * This does not look at the database, so it cannot tell whether the chunk exists.
 */
export function parseReport(raw: string): Checked<ReportFields> {
  if (raw.length > MAX_BODY_CHARS) return { ok: false, message: "That report is too long." };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "That report couldn't be read." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "That report couldn't be read." };
  }
  const fields = body as Record<string, unknown>;

  const token = fields.turnstile_token;
  const tokenOk = typeof token === "string" && token !== "" && length(token) <= MAX_TOKEN;
  const noToken = { ok: false, message: "The human check is missing, please try again." } as const;

  // No chunk_id (absent or null) is general feedback: a required note and nothing else. A
  // chunk_id that is present but not a number falls through to the passage check and is 400.
  if (fields.chunk_id === undefined || fields.chunk_id === null) {
    // Present at all is refused, even null or "": the stricter reading, so a form that sends
    // passage fields with feedback is caught in testing rather than quietly tolerated.
    if (fields.quoted_text !== undefined || fields.suggested_text !== undefined) {
      return { ok: false, message: "Feedback takes a message only, with no quoted text or suggested correction." };
    }
    const note = textField(fields.note, "feedback", MAX_NOTE, true);
    if (!note.ok) return note;
    if (!tokenOk) return noToken;
    return {
      ok: true,
      value: { chunk_id: null, quoted_text: null, suggested_text: null, note: note.value, turnstile_token: token },
    };
  }

  const chunkId = fields.chunk_id;
  if (typeof chunkId !== "number" || !Number.isSafeInteger(chunkId) || chunkId < 1) {
    return { ok: false, message: "That passage couldn't be identified." };
  }
  const quoted = textField(fields.quoted_text, "quoted text", MAX_QUOTED, true);
  if (!quoted.ok) return quoted;
  const suggested = textField(fields.suggested_text, "suggested correction", MAX_SUGGESTED, false);
  if (!suggested.ok) return suggested;
  const note = textField(fields.note, "note", MAX_NOTE, false);
  if (!note.ok) return note;
  if (!tokenOk) return noToken;
  return {
    ok: true,
    value: {
      chunk_id: chunkId,
      // Required, so never null; the type of textField does not say so.
      quoted_text: quoted.value ?? "",
      suggested_text: suggested.value,
      note: note.value,
      turnstile_token: token,
    },
  };
}

/**
 * Ask Cloudflare whether the token is good. True or false is its answer; anything else (it
 * cannot be reached, answers non-2xx or not JSON, or the JSON has no boolean `success`)
 * throws, so the route fails closed with 503. The listener's IP is deliberately not sent
 * (spec: no IPs); it is optional for siteverify.
 */
export async function verifyTurnstile(secret: string, token: string): Promise<boolean> {
  const response = await fetch(SITEVERIFY_URL, {
    method: "POST",
    body: new URLSearchParams({ secret, response: token }),
    signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`siteverify answered ${response.status}`);
  const result = (await response.json()) as { success?: unknown; "error-codes"?: unknown } | null;
  if (typeof result !== "object" || result === null || typeof result.success !== "boolean") {
    throw new Error("siteverify answered something other than a verdict");
  }
  // A refusal about our own secret is a misconfiguration, not a bot: every listener would get
  // 403. Throw, so it is a 503 with a log line that says which.
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
  const ours = codes.filter((c) => c === "invalid-input-secret" || c === "missing-input-secret");
  if (!result.success && ours.length > 0) throw new Error(`siteverify refused the secret: ${ours.join(", ")}`);
  return result.success;
}

// One statement checks the chunk and inserts: no row is written when the chunk does not
// exist (`changes` is 0). `status` takes its default, 'open'.
const INSERT_REPORT = `INSERT INTO reports (chunk_id, created_at, quoted_text, suggested_text, note)
SELECT ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)`;

// General feedback has no chunk to check: a plain INSERT, chunk_id NULL.
const INSERT_FEEDBACK = `INSERT INTO reports (chunk_id, created_at, quoted_text, suggested_text, note)
VALUES (NULL, ?, NULL, NULL, ?)`;

const unavailable = (message: string): Response => json({ error: "unavailable", message }, 503);

/**
 * The request body as UTF-8 text, read chunk by chunk (no body is ""). Once more than
 * `maxBytes` have arrived the stream is cancelled and the result is null: a body with no
 * Content-Length is never buffered whole.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  // Stream mode keeps a character split across two chunks together.
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * POST /api/report: `{chunk_id, quoted_text, suggested_text?, note?, turnstile_token}`, or,
 * without a chunk_id, general feedback `{note, turnstile_token}`.
 * 400 for a bad body or an unknown chunk, 403 when Turnstile refuses the token, 503 when
 * Turnstile or D1 cannot be used. Nothing is stored unless the answer is 200.
 */
export async function report(request: Request, env: Env): Promise<Response> {
  // Only the site may send reports (spec §4.8 item 6): checked first, so a report from
  // anywhere else costs no body read, no Turnstile call and no D1.
  if (!originAllowed(request, env)) {
    return json(
      { error: "forbidden", message: "Reports can only be sent from the Wood Talk search page." },
      403,
    );
  }
  // A declared size far past the limit is refused before the body is read at all; a body
  // without one (streamed, chunked) is read only up to the same cap. parseReport checks the
  // real length.
  const tooLong = (): Response => json({ error: "bad_request", message: "That report is too long." }, 400);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLong();
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return tooLong();
  const parsed = parseReport(raw);
  if (!parsed.ok) return json({ error: "bad_request", message: parsed.message }, 400);
  const { chunk_id, quoted_text, suggested_text, note, turnstile_token } = parsed.value;

  let human: boolean;
  try {
    human = await verifyTurnstile(env.TURNSTILE_SECRET, turnstile_token);
  } catch (err) {
    logError("turnstile_unavailable", request, err);
    return unavailable("We couldn't check that you're human just now, please try again in a minute.");
  }
  if (!human) {
    return json({ error: "forbidden", message: "We couldn't verify you're human, please try again." }, 403);
  }

  let changes: number;
  try {
    const created_at = new Date().toISOString();
    const statement =
      chunk_id === null
        ? env.DB.prepare(INSERT_FEEDBACK).bind(created_at, note)
        : env.DB.prepare(INSERT_REPORT).bind(chunk_id, created_at, quoted_text, suggested_text, note, chunk_id);
    changes = (await statement.run()).meta.changes;
  } catch (err) {
    logError("d1_unavailable", request, err);
    return unavailable("We couldn't save your report just now, please try again in a minute.");
  }
  if (changes === 0) return json({ error: "bad_request", message: "That passage couldn't be found." }, 400);
  return json({ ok: true });
}
