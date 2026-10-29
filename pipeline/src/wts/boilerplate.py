"""Scripted, repeated passages: word runs shared across episodes (boilerplate spec 2026-10-28 §5.1).

An episode's words become tokens, and every run of `run_words` consecutive non-empty tokens is
hashed to 64 bits. A run found in at least `min_episodes` different episodes is shared; the words
shared runs cover form spans, joined across short gaps and kept only when long enough. The hashes
are cached in state.db, so they must stay the same from run to run: token hashes are blake2b, and
a run's hash is a fixed polynomial of its token hashes.
"""

import hashlib
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from wts.words import Word, normalize_text

RUN_WORDS = 8
MIN_EPISODES = 5
# Measured on 159 episodes, 2026-10-28 (spec §5.1): every repeated span of 10+ words was scripted;
# the ordinary phrases that repeat ("I don't know about you guys, but I") are 8-9 words. Gaps of up
# to 12 words between spans were all inside a read, an outro or the intro's weekly joke.
MIN_SPAN_WORDS = 10
MAX_GAP_WORDS = 12

_P = np.uint64(1_000_003)
_NOT_TOKEN = re.compile(r"[^a-z0-9']")


@dataclass(frozen=True)
class Params:
    run_words: int = RUN_WORDS
    min_episodes: int = MIN_EPISODES
    min_span_words: int = MIN_SPAN_WORDS
    max_gap_words: int = MAX_GAP_WORDS


def tokens(words: Sequence[Word]) -> list[str]:
    """One token per word; "" when nothing is left of it ("—")."""
    return [_NOT_TOKEN.sub("", normalize_text(w.text)) for w in words]


@lru_cache(maxsize=200_000)
def _token_hash(tok: str) -> int:
    return int.from_bytes(hashlib.blake2b(tok.encode(), digest_size=8).digest(), "little")


def _run_hash_array(toks: Sequence[str], n: int) -> np.ndarray:
    """The hash of each run of n consecutive tokens (all non-empty), in order."""
    if len(toks) < n:
        return np.zeros(0, np.uint64)
    th = np.array([_token_hash(t) for t in toks], np.uint64)
    count = len(toks) - n + 1
    h = np.zeros(count, np.uint64)
    for j in range(n):
        h = h * _P + th[j : j + count]  # uint64 arrays wrap around
    return h


def run_hashes(toks: Sequence[str], n: int) -> np.ndarray:
    """The episode's distinct run hashes, sorted; runs are taken over non-empty tokens only."""
    return np.unique(_run_hash_array([t for t in toks if t], n))


def shared_runs(per_episode: Iterable[np.ndarray], min_episodes: int) -> np.ndarray:
    """Hashes present in at least `min_episodes` of the arrays (each distinct per episode)."""
    arrays = list(per_episode)
    if not arrays:
        return np.zeros(0, np.uint64)
    values, counts = np.unique(np.concatenate(arrays), return_counts=True)
    return values[counts >= min_episodes]


def shared_digest(shared: np.ndarray) -> str:
    return hashlib.sha256(np.sort(shared).astype(np.uint64).tobytes()).hexdigest()


def find_spans(
    words: Sequence[Word], shared: np.ndarray, params: Params | None = None
) -> list[tuple[int, int]]:
    """Half-open word-index ranges into `words` that shared runs cover, sorted."""
    params = params or Params()
    toks = tokens(words)
    where = [i for i, t in enumerate(toks) if t]  # word index of each non-empty token
    n = params.run_words
    hashes = _run_hash_array([toks[i] for i in where], n)
    if not len(hashes) or not len(shared):
        return []
    marked = np.zeros(len(where), bool)
    for start in np.flatnonzero(np.isin(hashes, shared)):
        marked[start : start + n] = True
    # Stretches of marked tokens, in word indices (an empty-token word inside one is covered).
    spans: list[tuple[int, int]] = []
    k = 0
    while k < len(where):
        if not marked[k]:
            k += 1
            continue
        j = k
        while j + 1 < len(where) and marked[j + 1]:
            j += 1
        spans.append((where[k], where[j] + 1))
        k = j + 1
    joined: list[tuple[int, int]] = []
    for s, e in spans:
        if joined and s - joined[-1][1] <= params.max_gap_words:
            joined[-1] = (joined[-1][0], e)
        else:
            joined.append((s, e))
    return [(s, e) for s, e in joined if e - s >= params.min_span_words]
