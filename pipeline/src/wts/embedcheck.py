"""`wts check-embeddings`: do Workers AI query vectors agree with the Mac's passage vectors?
(spec §3.2 `wts embed`; plan 2, Task 9 and Review Focus 1.)

Smart search embeds the query with `@cf/baai/bge-base-en-v1.5` on Workers AI and compares it
with vectors made on the Mac by sentence-transformers, which pools bge with CLS. The REST API's
default pooling is `mean`, which doesn't match, and search would quietly return poor results.
So a few stored chunks are embedded again through Workers AI with `pooling: "cls"`; the same
text must give nearly the same vector (cosine >= MIN_COSINE).
"""

import sqlite3
from pathlib import Path

import numpy as np

from wts.cloudflare import CloudflareApi
from wts.embed import DIM, load_embeddings
from wts.paths import Paths
from wts.state import Status

MODEL = "@cf/baai/bge-base-en-v1.5"
POOLING = "cls"
MIN_COSINE = 0.99


class NothingEmbedded(Exception):
    """No episode has stored embeddings to compare."""

    def __init__(self) -> None:
        super().__init__("nothing embedded yet; run `wts embed`")


def check_embeddings(
    conn: sqlite3.Connection, paths: Paths, api: CloudflareApi, n: int = 5
) -> list[tuple[int, float]]:
    """Cosine between the stored Mac vector and the Workers AI vector for `n` chunks, as
    `(chunk_id, cosine)`, oldest episode first. The chunks come from up to `n` episodes spaced
    evenly by date, the middle non-boilerplate chunk of each, so the same corpus always gives
    the same picks. All texts go in one request."""
    picks = _pick(conn, paths, n)
    if not picks:
        raise NothingEmbedded()
    texts = [text for _, text, _ in picks]
    # `pooling` defaults to "mean" on the API, which is not compatible with the Mac's CLS.
    resp = api.post(f"/ai/run/{MODEL}", body={"text": texts, "pooling": POOLING})
    remote = _vectors(api, resp, len(texts))
    return [
        (chunk_id, _cosine(api, stored, vector))
        for (chunk_id, _, stored), vector in zip(picks, remote, strict=True)
    ]


def chunk_stems(conn: sqlite3.Connection, chunk_ids: list[int]) -> dict[int, str]:
    """The episode stem of each chunk, for reporting."""
    return {
        i: conn.execute(
            "select e.stem from chunks c join episodes e on e.id = c.episode_id where c.id = ?",
            (i,),
        ).fetchone()[0]
        for i in chunk_ids
    }


def _pick(conn: sqlite3.Connection, paths: Paths, n: int) -> list[tuple[int, str, np.ndarray]]:
    """`(chunk_id, text, stored vector)` for the chosen chunks."""
    rows = conn.execute(
        "select e.id, e.stem from episodes e where e.status in (?, ?) "
        "and exists (select 1 from chunks c where c.episode_id = e.id and c.is_boilerplate = 0) "
        "order by e.published_at, e.id",
        (Status.EMBEDDED.value, Status.PUBLISHED.value),
    ).fetchall()
    rows = [r for r in rows if (paths.embeddings_dir / f"{r['stem']}.npz").exists()]
    k = min(n, len(rows))
    # The centres of k equal slices of the date-ordered list.
    chosen = [rows[(2 * i + 1) * len(rows) // (2 * k)] for i in range(k)]
    picks = []
    for row in chosen:
        pick = _middle_chunk(conn, row["id"], paths.embeddings_dir / f"{row['stem']}.npz")
        if pick:
            picks.append(pick)
    return picks


def _middle_chunk(
    conn: sqlite3.Connection, episode_id: int, path: Path
) -> tuple[int, str, np.ndarray] | None:
    chunk_ids, vectors = load_embeddings(path)
    # Only chunks that are still non-boilerplate: a stored vector for a chunk that has since
    # been flagged (or removed) says nothing about what is published.
    texts = dict(conn.execute(
        "select id, text from chunks where episode_id = ? and is_boilerplate = 0",
        (episode_id,)).fetchall())
    usable = [(int(i), v) for i, v in zip(chunk_ids, vectors, strict=True) if int(i) in texts]
    if not usable:
        return None
    chunk_id, vector = usable[len(usable) // 2]
    return chunk_id, texts[chunk_id], vector


def _vectors(api: CloudflareApi, resp: dict, expected: int) -> list[np.ndarray]:
    """The response's vectors, checked for count, dimension and pooling."""
    result = resp.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise api.fail(200, "Workers AI response has no result.data")
    data = result["data"]
    if len(data) != expected:
        raise api.fail(200, f"Workers AI returned {len(data)} vectors for {expected} texts")
    shape = result.get("shape")
    if shape is not None and shape != [expected, DIM]:
        raise api.fail(200, f"Workers AI returned shape {shape}, expected {[expected, DIM]}")
    pooling = result.get("pooling")
    if pooling is not None and pooling != POOLING:
        raise api.fail(200, f"Workers AI used pooling {pooling!r}, expected {POOLING!r}")
    vectors = []
    for vector in data:
        if not isinstance(vector, list) or len(vector) != DIM:
            raise api.fail(200, f"Workers AI returned a vector that is not {DIM} numbers long")
        try:
            vectors.append(np.asarray(vector, dtype=np.float64))
        except (TypeError, ValueError):
            raise api.fail(200, "Workers AI returned a vector with non-numeric values") from None
    return vectors


def _cosine(api: CloudflareApi, stored: np.ndarray, remote: np.ndarray) -> float:
    """Cosine similarity, normalising both sides: neither is assumed to be a unit vector."""
    stored = np.asarray(stored, dtype=np.float64)
    if stored.shape != remote.shape:
        raise api.fail(200, f"stored vector has {stored.size} dimensions, expected {DIM}")
    norms = np.linalg.norm(stored) * np.linalg.norm(remote)
    if not np.isfinite(norms) or norms == 0:
        raise api.fail(200, "a vector is zero or not finite")
    return float(np.dot(stored, remote) / norms)
