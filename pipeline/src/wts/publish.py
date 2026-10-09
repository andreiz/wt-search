"""`wts publish`: send changed episodes to one environment's D1 and Vectorize (spec §3.2, §6;
plan 2, Task 7 and decisions 1–2).

D1's REST API isn't atomic across statements, so publishing is idempotent instead. An episode
counts as published to an environment only once every call for it has succeeded: then its
`publications` row records the digest of what was sent. Before the first remote write an
existing row's digest is blanked (DIRTY), since a write can land even when its call fails. A
failure anywhere leaves it blank, the episode goes to `error`, and the next run repeats every
call, whatever the content is by then, which ends in the same state as a clean publish.

Per episode, in order:
  1. Vectorize upsert of the non-boilerplate chunks. Their ids are first added to
     `published_vectors`, which lists every vector id that may exist in the index, so ids sent
     before a failure are still deleted if a re-chunk drops them.
  2. One D1 batch: upsert the episode row, delete its chunks that are gone, upsert its chunks
     (ON CONFLICT DO UPDATE, never INSERT OR REPLACE, which skips the FTS delete trigger).
  3. Vectorize delete of ids in `published_vectors` that are no longer current.
  4. One local transaction: `publications`, `published_vectors`, the owed `corpus_version`
     bump (a `kv` flag, cleared once the bump succeeds), status → `published`.
"""

import hashlib
import json
import logging
import sqlite3
from collections import Counter
from collections.abc import Collection
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np

from wts.cloudflare import D1, CloudflareApi, Vectorize, chunked_inserts
from wts.config import Config
from wts.db import kv_get
from wts.embed import load_embeddings
from wts.log import plural
from wts.net import new_client
from wts.paths import Paths
from wts.secrets import SecretStore, get_secret, get_store
from wts.state import Status, advance, fail, publish_ready

log = logging.getLogger("wts")

# Bump when what is sent for an episode changes shape, so every episode is republished.
DIGEST_VERSION = 1
YOUTUBE_MAX_DRIFT_S = 3  # spec §4.6: link YouTube only when its length matches the feed's
# Stored in place of a digest while an attempt is in flight or failed; never equals a real one,
# so the episode stays due (even if its content goes back to what was last published).
DIRTY = ""

EPISODE_COLUMNS = (
    "id", "guid", "number", "title", "published_at", "year", "duration_s", "audio_url",
    "page_url", "apple_episode_id", "spotify_episode_id", "youtube_video_id",
    "offset_apple_s", "offset_spotify_s", "offset_youtube_s",
)
CHUNK_COLUMNS = (
    "id", "episode_id", "seq", "start_ms", "end_ms", "text", "word_times", "is_boilerplate",
)
_BOILERPLATE = CHUNK_COLUMNS.index("is_boilerplate")

# The current chunk ids go in as one JSON array, so the statement stays within D1's 100 bound
# parameters however many chunks an episode has.
DELETE_GONE_CHUNKS = (
    "delete from chunks where episode_id = ? and id not in (select value from json_each(?))"
)
SET_CORPUS_VERSION = (
    "insert into meta (key, value) values ('corpus_version', ?), ('last_published_at', ?) "
    "on conflict (key) do update set value = excluded.value"
)


def year_of(published_at: str) -> int:
    return int(published_at[:4])


def youtube_id_for_publish(row: sqlite3.Row) -> str | None:
    """The matched video, only when its length is within 3 s of the feed's (spec §4.6). The
    match itself stays in state.db either way."""
    video, video_s, feed_s = row["youtube_video_id"], row["youtube_duration_s"], row["duration_s"]
    if video is None or video_s is None or feed_s is None:
        return None
    return video if abs(video_s - feed_s) <= YOUTUBE_MAX_DRIFT_S else None


def episode_values(row: sqlite3.Row) -> list:
    """The episode's D1 row, in EPISODE_COLUMNS order."""
    derived = {"year": year_of(row["published_at"]),
               "youtube_video_id": youtube_id_for_publish(row)}
    return [derived[c] if c in derived else row[c] for c in EPISODE_COLUMNS]


def _chunks(conn: sqlite3.Connection, episode_id: int) -> list[tuple]:
    return [
        tuple(r)
        for r in conn.execute(
            f"select {', '.join(CHUNK_COLUMNS)} from chunks where episode_id = ? order by seq",
            (episode_id,),
        )
    ]


def _embeddings(
    row: sqlite3.Row, chunks: list[tuple], embeddings_dir: Path
) -> tuple[np.ndarray, np.ndarray]:
    """The episode's stored vectors, checked against its current non-boilerplate chunks."""
    chunk_ids, vectors = load_embeddings(embeddings_dir / f"{row['stem']}.npz")
    if chunk_ids.tolist() != [c[0] for c in chunks if not c[_BOILERPLATE]]:
        raise ValueError("embeddings don't match the current chunks; run `wts embed`")
    return chunk_ids, vectors


def episode_digest(conn: sqlite3.Connection, row: sqlite3.Row, embeddings_dir: Path) -> str:
    """SHA-256 of everything an environment gets for this episode: its D1 row (platform IDs
    after the YouTube rule, offsets), its chunks, and its vectors."""
    chunks = _chunks(conn, row["id"])
    chunk_ids, vectors = _embeddings(row, chunks, embeddings_dir)
    h = hashlib.sha256()
    h.update(json.dumps([DIGEST_VERSION, episode_values(row), chunks]).encode())
    h.update(np.ascontiguousarray(chunk_ids, dtype=np.int64).tobytes())
    h.update(np.ascontiguousarray(vectors, dtype=np.float32).tobytes())
    return h.hexdigest()


def due_episodes(
    conn: sqlite3.Connection, env: str, ids: Collection[int], embeddings_dir: Path
) -> list[sqlite3.Row]:
    """Publish-ready episodes whose content differs from what `env` has (or that it lacks).
    An episode whose digest can't be computed (missing embeddings, say) is due, so publishing
    it fails and records why."""
    published = dict(conn.execute("select episode_id, digest from publications where env = ?",
                                  (env,)).fetchall())
    due = []
    for row in publish_ready(conn, ids):
        try:
            digest = episode_digest(conn, row, embeddings_dir)
        except Exception:  # noqa: BLE001 — publish_episode reports it
            digest = None
        if digest is None or published.get(row["id"]) != digest:
            due.append(row)
    return due


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def publish_episode(
    conn: sqlite3.Connection, d1: D1, vectorize: Vectorize, env: str, row: sqlite3.Row,
    embeddings_dir: Path,
) -> Counter:
    """Steps 1–4 above for one episode. Raises on any failure, leaving its `publications` row
    (if any) dirty once remote writes have started."""
    episode_id = row["id"]
    chunks = _chunks(conn, episode_id)
    chunk_ids, vectors = _embeddings(row, chunks, embeddings_dir)
    digest = episode_digest(conn, row, embeddings_dir)
    current = [int(i) for i in chunk_ids]
    metadata = {"episode_id": episode_id, "year": year_of(row["published_at"])}

    # 1. Vectors, after noting their ids as possibly present in this environment's index, and
    # after marking the recorded digest dirty: a write may land even when its call then fails,
    # so until step 4 the environment may hold neither the recorded content nor the current.
    with conn:
        conn.execute("update publications set digest = ? where episode_id = ? and env = ?",
                     (DIRTY, episode_id, env))
        conn.executemany(
            "insert or ignore into published_vectors (env, chunk_id, episode_id) values (?, ?, ?)",
            [(env, i, episode_id) for i in current],
        )
    if current:
        vectorize.upsert([(str(i), v.tolist(), metadata)
                          for i, v in zip(current, vectors, strict=True)])

    # 2. D1: the episode row first (chunks reference it), then chunks that are gone, then the rest.
    d1.batch([
        *chunked_inserts("episodes", EPISODE_COLUMNS, [episode_values(row)], upsert_on="id"),
        (DELETE_GONE_CHUNKS, [episode_id, json.dumps([c[0] for c in chunks])]),
        *chunked_inserts("chunks", CHUNK_COLUMNS, chunks, upsert_on="id"),
    ])

    # 3. Vectors of chunks that were removed or became boilerplate.
    known = [r[0] for r in conn.execute(
        "select chunk_id from published_vectors where env = ? and episode_id = ?",
        (env, episode_id))]
    stale = sorted(set(known) - set(current))
    if stale:
        vectorize.delete_by_ids([str(i) for i in stale])

    # 4. Record it. advance() commits the whole transaction, so it goes last.
    with conn:
        conn.execute(
            "insert into publications (episode_id, env, digest, published_at) values (?, ?, ?, ?) "
            "on conflict (episode_id, env) do update set digest = excluded.digest, "
            "published_at = excluded.published_at",
            (episode_id, env, digest, _now()),
        )
        # The cache-busting bump is owed from here on, even if this run dies before making it.
        conn.execute(
            "insert into kv (key, value) values (?, '1') "
            "on conflict (key) do update set value = excluded.value", (_pending_key(env),))
        conn.executemany("delete from published_vectors where env = ? and chunk_id = ?",
                         [(env, i) for i in stale])
        if row["status"] != Status.PUBLISHED:
            advance(conn, episode_id, "publish")
    return Counter(chunks=len(chunks), vectors=len(current), vectors_deleted=len(stale))


def _pending_key(env: str) -> str:
    return f"publish.corpus_version_pending.{env}"


def _bump_corpus_version(conn: sqlite3.Connection, d1: D1, env: str) -> None:
    """New `meta.corpus_version` (part of the Worker's cache key) and `last_published_at`. If
    that fails it is retried on the next run, even when nothing else is due."""
    now = datetime.now(UTC)
    d1.batch([(SET_CORPUS_VERSION,
               [now.strftime("%Y%m%d%H%M%S"), now.isoformat(timespec="seconds")])])
    with conn:
        conn.execute("delete from kv where key = ?", (_pending_key(env),))


def run_publish(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    env: str,
    ids: Collection[int],
    *,
    client: httpx.Client | None = None,
    store: SecretStore | None = None,
    d1: D1 | None = None,
    vectorize: Vectorize | None = None,
    dry_run: bool = False,
) -> Counter:
    """Publish the due episodes among `ids` to `env`, one at a time. A failed episode goes to
    `error` (retried on later runs) and the others continue."""
    counts: Counter = Counter()
    rows = due_episodes(conn, env, ids, paths.embeddings_dir)
    pending = kv_get(conn, _pending_key(env)) is not None
    if dry_run:
        for row in rows:
            n = conn.execute("select count(*) from chunks where episode_id = ?",
                             (row["id"],)).fetchone()[0]
            log.info(f"would publish to {env}: {plural(n, 'chunk')}",
                     extra={"step": "publish", "episode": row["stem"]})
            counts["dry_run"] += 1
        return counts
    if not rows and not pending:
        return counts
    if d1 is None or vectorize is None:
        target = cfg.env(env)
        api = CloudflareApi(client or new_client(), cfg.cloudflare_account_id,
                            get_secret(store or get_store(), "cloudflare_api_token"))
        d1 = d1 or D1(api, target.d1_database_id)
        vectorize = vectorize or Vectorize(api, target.vectorize_index)

    for row in rows:
        extra = {"step": "publish", "episode": row["stem"]}
        try:
            done = publish_episode(conn, d1, vectorize, env, row, paths.embeddings_dir)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            fail(conn, row["id"], "publish", f"{type(exc).__name__}: {exc}"[:500])
            counts["error"] += 1
            log.error(f"publish to {env} failed: {type(exc).__name__}: {exc}", extra=extra)
            continue
        counts["ok"] += 1
        counts.update(done)
        log.info(f"published to {env}: {plural(done['chunks'], 'chunk')}, "
                 f"{plural(done['vectors'], 'vector')}"
                 + (f", {done['vectors_deleted']} removed" if done["vectors_deleted"] else ""),
                 extra=extra)

    if counts["ok"] or pending:  # publish_episode recorded the debt with each success
        try:
            _bump_corpus_version(conn, d1, env)
        except Exception as exc:  # noqa: BLE001 — retried on the next run
            counts["error"] += 1
            log.error(f"updating corpus_version in {env} failed ({type(exc).__name__}: {exc}); "
                      "retried on the next publish", extra={"step": "publish"})
    return counts
