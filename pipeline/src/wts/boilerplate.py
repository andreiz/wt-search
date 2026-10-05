"""Repeated-content detection: sponsor reads, plugs, intros/outros, inserted ads (spec §3.5).

Deterministic and local. Each sentence's fingerprint is a MinHash over its shingles; LSH band
keys stored in state.db find candidate matches in other episodes, which are then verified with an
exact Jaccard similarity.
"""

import hashlib
import sqlite3
from collections.abc import Sequence
from functools import lru_cache

from datasketch import MinHash

from wts.words import Sentence

MIN_WORDS = 6
# Word sets, not 5-word phrases: one misheard word in a 16-word sponsor read drops 5-word-phrase
# similarity to ~0.4, but word-set similarity stays ~0.87. Sentences must still have 6+ words.
SHINGLE_K = 1
NUM_PERM = 128
BANDS, ROWS = 16, 8
JACCARD = 0.8
MIN_EPISODES = 5


def shingles(norm: str, k: int = SHINGLE_K) -> set[str]:
    words = norm.split()
    if len(words) <= k:
        return {" ".join(words)}
    return {" ".join(words[i : i + k]) for i in range(len(words) - k + 1)}


_TEMPLATE = MinHash(num_perm=NUM_PERM, seed=1)  # building permutations is costly; do it once


@lru_cache(maxsize=200_000)
def band_keys(norm: str) -> tuple[int, ...]:
    m = MinHash(
        num_perm=NUM_PERM, seed=1, permutations=_TEMPLATE.permutations, scheme=_TEMPLATE.scheme
    )
    m.update_batch([s.encode() for s in shingles(norm)])
    values = m.hashvalues
    keys = []
    for b in range(BANDS):
        digest = hashlib.blake2b(
            b.to_bytes(1, "big") + values[b * ROWS : (b + 1) * ROWS].tobytes(), digest_size=8
        ).digest()
        keys.append(int.from_bytes(digest, "big", signed=True))
    return tuple(keys)


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a or b else 0.0


class BoilerplateIndex:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def replace_episode(self, episode_id: int, sentences: Sequence[Sentence]) -> None:
        wanted = [s.norm for s in sentences if len(s.norm.split()) >= MIN_WORDS]
        stored = [
            r[0]
            for r in self.conn.execute(
                "select norm_text from bp_sentences where episode_id = ? order by id", (episode_id,)
            )
        ]
        if stored == wanted:
            return  # unchanged: skip rewriting thousands of band rows
        with self.conn:
            self.conn.execute(
                "delete from bp_bands where sentence_id in "
                "(select id from bp_sentences where episode_id = ?)",
                (episode_id,),
            )
            self.conn.execute("delete from bp_sentences where episode_id = ?", (episode_id,))
            for norm in wanted:
                cur = self.conn.execute(
                    "insert into bp_sentences (episode_id, norm_text) values (?, ?)",
                    (episode_id, norm),
                )
                self.conn.executemany(
                    "insert into bp_bands (band_key, sentence_id) values (?, ?)",
                    [(k, cur.lastrowid) for k in band_keys(norm)],
                )

    def is_boilerplate(self, episode_id: int, norm: str) -> bool:
        if len(norm.split()) < MIN_WORDS:
            return False
        keys = band_keys(norm)
        marks = ", ".join("?" for _ in keys)
        candidates = self.conn.execute(
            "select distinct s.episode_id, s.norm_text from bp_bands b "
            f"join bp_sentences s on s.id = b.sentence_id where b.band_key in ({marks}) "
            "and s.episode_id != ?",
            (*keys, episode_id),
        ).fetchall()
        mine = shingles(norm)
        episodes = {
            c["episode_id"] for c in candidates if _jaccard(mine, shingles(c["norm_text"])) >= JACCARD
        }
        return len(episodes) + 1 >= MIN_EPISODES

    def mask(self, episode_id: int, sentences: Sequence[Sentence]) -> list[bool]:
        return [self.is_boilerplate(episode_id, s.norm) for s in sentences]
