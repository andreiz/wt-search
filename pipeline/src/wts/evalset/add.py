"""Adding a hand-written case to eval/queries.yaml from the review page, and where a passage
lands in a search answer (spec §7.2).

The file is appended to as text, never loaded and dumped, so its comments and layout stay. The
new text is loaded again and must hold the old cases plus the new one, or nothing is returned.
"""

import json
import re

import yaml

from wts.evalset.cases import MODES, TAGS, CaseError, _case
from wts.evalset.score import TOLERANCE_S, clock
from wts.links import parse_time

MAX_ID = 48


class CaseExists(Exception):
    """A case with the same words already expects (or rules out) this passage."""


def case_id(query: str, taken: set[str]) -> str:
    """A slug of the query, cut at a word, made unique among `taken`."""
    words = re.findall(r"[a-z0-9]+", query.lower())
    slug = ""
    for word in words:
        longer = f"{slug}-{word}" if slug else word
        if len(longer) > MAX_ID:
            break
        slug = longer
    slug = slug or (words[0][:MAX_ID] if words else "case")
    candidate, n = slug, 2
    while candidate in taken:
        candidate = f"{slug}-{n}"
        n += 1
    return candidate


def _scalar(text: str) -> str:
    """`text` plain if YAML reads it back unchanged, otherwise double-quoted."""
    try:
        if yaml.safe_load(f"q: {text}") == {"q": text}:
            return text
    except yaml.YAMLError:
        pass
    return json.dumps(text, ensure_ascii=False)


def _load(text: str) -> list:
    try:
        data = yaml.safe_load(text) or []
    except yaml.YAMLError as exc:
        raise CaseError(f"queries.yaml: not valid YAML: {exc}") from exc
    if not isinstance(data, list):
        raise CaseError("queries.yaml: expected a list of cases")
    return data


def _same_passage(item: dict, episode: int, at_s: int | None) -> bool:
    if not isinstance(item, dict) or item.get("episode") != episode:
        return False
    theirs = item.get("at")
    if theirs is None or at_s is None:
        return theirs is None and at_s is None
    try:  # an unquoted 40:54 arrives as PyYAML's base-60 int, already seconds
        theirs_s = theirs if isinstance(theirs, int) else parse_time(str(theirs))
    except ValueError:
        return False
    return abs(theirs_s - at_s) <= TOLERANCE_S


def append_case(text: str, *, query: str, tag: str, mode: str, episode: int,
                at_s: int | None, absent: bool) -> tuple[str, str]:
    """`(new text, the new case's id)`.

    ValueError for input no case may hold, CaseError for a file that doesn't load, CaseExists
    for a case that already says this.
    """
    query = query.strip() if isinstance(query, str) else ""
    if not query or tag not in TAGS or mode not in MODES:
        raise ValueError("a case needs a query, a known tag and a known mode")
    if not isinstance(episode, int) or isinstance(episode, bool) or episode < 1:
        raise ValueError("episode must be a number from 1")
    if at_s is not None and (not isinstance(at_s, int) or isinstance(at_s, bool) or at_s < 0):
        raise ValueError("at must be whole seconds from 0")

    old = _load(text)
    key = "expect_absent" if absent else "expect"
    for raw in old:
        if not isinstance(raw, dict) or str(raw.get("query", "")).strip().casefold() != query.casefold():
            continue
        if any(_same_passage(item, episode, at_s) for item in raw.get(key) or []):
            raise CaseExists(f"case {raw.get('id')!r} already has this")

    new_id = case_id(query, {str(raw.get("id")) for raw in old if isinstance(raw, dict)})
    item = f"{{episode: {episode}" + (f', at: "{clock(at_s)}"' if at_s is not None else "") + "}"
    lines = [f"- id: {_scalar(new_id)}",f"  query: {_scalar(query)}", f"  tag: {tag}"]
    if mode != "both":
        lines.append(f"  mode: {mode}")
    lines.append(f"  {key}: [{item}]")
    entry = "\n".join(lines) + "\n"

    if not text.strip():
        new_text = entry
    else:
        new_text = (text if text.endswith("\n") else text + "\n") + "\n" + entry
    new = _load(new_text)
    if new[:-1] != old or len(new) != len(old) + 1:
        raise CaseError("queries.yaml: the appended case did not load as one more case")
    added = _case(new[-1], "queries.yaml", len(new))
    if added.id != new_id or added.query != query:
        raise CaseError("queries.yaml: the appended case did not load as written")
    return new_text, new_id


def locate(results: list[dict], episode: int, at_s: int | None) -> dict:
    """1-based ranks in `results`: the first card at the passage (within the tolerance, or any
    card of the episode when there is no time) and the first card of the episode."""
    rank = episode_rank = None
    for n, result in enumerate(results, 1):
        ep = result.get("episode") if isinstance(result, dict) else None
        if not isinstance(ep, dict) or ep.get("number") != episode:
            continue
        if episode_rank is None:
            episode_rank = n
        near = at_s is None or abs(result.get("hit_ms", 0) / 1000 - at_s) <= TOLERANCE_S
        if near and rank is None:
            rank = n
    return {"rank": rank, "episode_rank": episode_rank}
