"""Chunk embeddings with bge-base-en-v1.5 (spec §3.2 `wts embed`).

Must match the model Workers AI runs for query embeddings (@cf/baai/bge-base-en-v1.5).
Passages get no instruction prefix. Vectors are cached per text, so re-chunking that keeps
a chunk's text never re-embeds it.
"""

import hashlib
import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol

import numpy as np

DIM = 768


class Embedder(Protocol):
    model: str
    dim: int

    def embed(self, texts: Sequence[str]) -> np.ndarray: ...


class SentenceTransformerEmbedder:
    dim = DIM

    def __init__(self, model: str = "BAAI/bge-base-en-v1.5", device: str = "mps",
                 batch_size: int = 64):
        self.model = model
        self.device = device
        self.batch_size = batch_size
        self._st = None

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        if self._st is None:
            from sentence_transformers import SentenceTransformer

            self._st = SentenceTransformer(self.model, device=self.device)
        vectors = self._st.encode(
            list(texts), batch_size=self.batch_size, normalize_embeddings=True
        )
        return np.asarray(vectors, dtype=np.float32)


def get_embedder() -> Embedder:
    return SentenceTransformerEmbedder()


def text_sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def load_embeddings(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with np.load(path) as data:
        return data["chunk_ids"], data["vectors"]


def load_text_shas(path: Path) -> list[str]:
    """`text_sha` of the text each stored vector was computed from, in vector order."""
    with np.load(path) as data:
        return data["text_sha"].tolist()


def _cached(path: Path) -> dict[str, np.ndarray]:
    if not path.exists():
        return {}
    with np.load(path) as data:
        return dict(zip(data["text_sha"].tolist(), data["vectors"], strict=True))


def embed_episode(
    conn: sqlite3.Connection, row: sqlite3.Row, embedder: Embedder, out_dir: Path
) -> int:
    chunks = conn.execute(
        "select id, text from chunks where episode_id = ? and is_boilerplate = 0 order by seq",
        (row["id"],),
    ).fetchall()
    out = out_dir / f"{row['stem']}.npz"
    cache = _cached(out)
    shas = [text_sha(c["text"]) for c in chunks]
    missing = sorted({s: c["text"] for s, c in zip(shas, chunks, strict=True) if s not in cache}.items())
    if missing:
        fresh = embedder.embed([text for _, text in missing])
        cache.update({s: v for (s, _), v in zip(missing, fresh, strict=True)})
    vectors = (
        np.stack([cache[s] for s in shas]).astype(np.float32)
        if shas
        else np.zeros((0, embedder.dim), dtype=np.float32)
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    with tmp.open("wb") as f:
        np.savez(
            f,
            chunk_ids=np.array([c["id"] for c in chunks], dtype=np.int64),
            text_sha=np.array(shas, dtype="U16"),
            vectors=vectors,
        )
    tmp.replace(out)
    return len(missing)
