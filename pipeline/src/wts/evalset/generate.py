"""Synthetic test cases (spec §7.2, source 2): a local model, through Ollama on the Mac, writes
the query a listener would type to find a randomly sampled passage, so the right answer is that
passage. Seeded, so a rerun over the same chunks gives the same file."""

import random
import re
import sqlite3
from pathlib import Path

import httpx
import yaml

from wts.evalset.add import all_said
from wts.evalset.score import clock

OLLAMA_URL = "http://localhost:11434"
TIMEOUT_S = 120  # a cold model takes a while to load
MIN_CHARS = 400  # a chunk shorter than this rarely holds a findable topic
MAX_WORDS = 12
PROMPT = """Here is a passage from Wood Talk, a woodworking podcast:

{text}

A listener remembers this part of the show and wants to find it again. Write the search \
query they would type, 3 to 10 words. Describe what was discussed in your own words; don't \
copy distinctive phrases from the passage. Don't name the show or use the words podcast or \
episode: the search only covers this show. Reply with the query only."""
_SYNTAX = re.compile(r"(^|\s)-|\w:\S")  # an exclusion or a filter like year:2020
# The show's name, "podcast" or "episode" matches every episode's intro rather than the passage
# (2026-10-27: a fifth of the generated queries had them, against 159 intros).
_SHOW = re.compile(r"\bwood\s*talk|\bpodcasts?\b|\bepisodes?\b", re.IGNORECASE)
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)  # a thinking model's reasoning


class GenerateError(Exception):
    """Ollama can't be used; the message says what to do."""


def sample_chunks(conn: sqlite3.Connection, count: int, seed: int) -> list[sqlite3.Row]:
    rows = conn.execute(
        "select e.number, c.start_ms, c.text from chunks c join episodes e on e.id = c.episode_id"
        " where e.status = 'published' and e.number is not null and c.is_boilerplate = 0"
        " and length(c.text) >= ? order by e.number, c.start_ms", (MIN_CHARS,)).fetchall()
    picked = random.Random(seed).sample(rows, min(count, len(rows)))
    return sorted(picked, key=lambda r: (r["number"], r["start_ms"]))


def clean_query(text: str) -> str | None:
    """The model's reply as a query, or None when it isn't usable as one."""
    text = _THINK.sub("", text)
    line = next((ln for ln in text.strip().splitlines() if ln.strip()), "")
    line = re.sub(r"^(search )?query:\s*", "", line.strip(), flags=re.IGNORECASE)
    line = line.strip().strip("\"'“”").rstrip(".").strip()
    words = line.split()
    if (not 2 <= len(words) <= MAX_WORDS or _SYNTAX.search(line) or '"' in line
            or _SHOW.search(line)):
        return None
    return line


def ask_model(client: httpx.Client, model: str, text: str, *, seed: int,
              url: str = OLLAMA_URL) -> str:
    url = url.rstrip("/")
    try:
        # `think: false`: a thinking model (qwen3) answers at once; other models ignore it.
        resp = client.post(f"{url}/api/generate", timeout=TIMEOUT_S, json={
            "model": model, "prompt": PROMPT.format(text=text.strip()), "stream": False,
            "think": False, "options": {"temperature": 0, "seed": seed}})
    except httpx.TransportError as exc:
        raise GenerateError(f"can't reach Ollama at {url} ({type(exc).__name__}): start the "
                            "Ollama app, or run `ollama serve`, or set ollama_url") from exc
    if resp.status_code == 404:
        raise GenerateError(f"model {model} is not installed: `ollama pull {model}`")
    if resp.status_code >= 400:
        raise GenerateError(f"Ollama answered HTTP {resp.status_code}")
    return str(resp.json().get("response", ""))


def generate(conn: sqlite3.Connection, client: httpx.Client, model: str, *, count: int,
             seed: int, url: str = OLLAMA_URL) -> tuple[list[dict], int]:
    cases, skipped = [], 0
    for i, row in enumerate(sample_chunks(conn, count, seed)):
        query = clean_query(ask_model(client, model, row["text"], seed=seed + i, url=url))
        if query is None:
            skipped += 1
            continue
        at = clock(row["start_ms"] // 1000)
        # The model often reuses the passage's words; then Exact finds it and it's no paraphrase.
        tag = "exact" if all_said(query, row["text"]) else "paraphrase"
        cases.append({"id": f"syn-{row['number']:03d}-{at.replace(':', ''):0>4}",
                      "query": query, "tag": tag,
                      "expect": [{"episode": row["number"], "at": at}]})
    return cases, skipped


def write_synthetic(cases: list[dict], path: Path, *, header: str) -> None:
    body = yaml.safe_dump(cases, sort_keys=False, allow_unicode=True, width=100)
    path.write_text(f"{header}\n{body}")
