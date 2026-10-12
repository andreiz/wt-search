"""Insert one rule into corrections.yaml as text, keeping its comments and order (spec §3.3).

The file is edited line by line, never loaded and dumped: untouched lines stay byte for byte.
The new text is loaded again and must equal the old rules plus the new one, or nothing is
returned.
"""

import json
import re
from collections import Counter

import yaml

from wts.corrections import CorrectionRule, _match_words, rules_from_text

_PLAIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9 '.-]*")
_PLAIN_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
_LINE = re.compile(r"[^\n]*\n|[^\n]+")


class RuleExists(Exception):
    """The scope already has a rule with the same match words."""


class EditFailed(Exception):
    """The edited text did not load as the old rules plus the new one."""


def _scalar(s: str, plain: re.Pattern[str] = _PLAIN) -> str:
    if plain.fullmatch(s) and s == s.strip():
        return s
    return json.dumps(s, ensure_ascii=False)


def _content(line: str) -> str:
    return line.rstrip("\r\n")


def _indent(line: str) -> int:
    c = _content(line)
    return len(c) - len(c.lstrip(" "))


def _is_blank(line: str) -> bool:
    return not _content(line).strip()


def _is_comment(line: str) -> bool:
    return _content(line).lstrip().startswith("#")


def _block_end(lines: list[str], start: int, stop: int, max_indent: int) -> int:
    """The index after the block that starts at `start`: the next real line indented at most
    `max_indent` (comments and blank lines do not end a block)."""
    for j in range(start + 1, stop):
        if not _is_blank(lines[j]) and not _is_comment(lines[j]) and _indent(lines[j]) <= max_indent:
            return j
    return stop


def _last_line(lines: list[str], start: int, end: int, child_indent: int) -> int:
    """The last line of the block to insert after: not blank, not a comment that sits left of
    the block's own lines (it introduces whatever comes next)."""
    for j in range(end - 1, start, -1):
        if _is_blank(lines[j]):
            continue
        if _is_comment(lines[j]) and _indent(lines[j]) < child_indent:
            continue
        return j
    return start


def _find(lines: list[str], pattern: str, start: int = 0, stop: int | None = None) -> int | None:
    rx = re.compile(pattern)
    for j in range(start, len(lines) if stop is None else stop):
        if rx.fullmatch(_content(lines[j])):
            return j
    return None


def _insert(lines: list[str], after: int, new: list[str], eol: str) -> None:
    if not lines[after].endswith("\n"):
        lines[after] += eol
    lines[after + 1 : after + 1] = [n + eol for n in new]


def _append(lines: list[str], new: list[str], eol: str) -> None:
    if lines:
        if not lines[-1].endswith("\n"):
            lines[-1] += eol
        if not _is_blank(lines[-1]):
            lines.append(eol)
    lines.extend(n + eol for n in new)


def _edited(text: str, key: str, value: str, episode: str | None) -> str:
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = _LINE.findall(text)
    rule = f"{_scalar(key)}: {_scalar(value)}"

    if episode is None:
        head = _find(lines, r"global:\s*(#.*)?")
        if head is None:
            _append(lines, ["global:", f"  {rule}"], eol)
        else:
            end = _block_end(lines, head, len(lines), 0)
            _insert(lines, _last_line(lines, head, end, 1), [f"  {rule}"], eol)
        return "".join(lines)

    stem = _scalar(episode, _PLAIN_STEM)
    head = _find(lines, r"episodes:\s*(#.*)?")
    if head is None:
        _append(lines, ["episodes:", f"  {stem}:", f"    {rule}"], eol)
        return "".join(lines)
    end = _block_end(lines, head, len(lines), 0)
    stem_head = _find(lines, rf"  {re.escape(stem)}\s*:\s*(#.*)?", head + 1, end)
    if stem_head is None:
        _insert(lines, _last_line(lines, head, end, 1), [f"  {stem}:", f"    {rule}"], eol)
    else:
        stem_end = _block_end(lines, stem_head, end, 2)
        _insert(lines, _last_line(lines, stem_head, stem_end, 4), [f"    {rule}"], eol)
    return "".join(lines)


def add_rule(text: str, key: str, value: str, episode: str | None) -> str:
    """The file's text with one rule inserted (global, or under `episodes:` → `episode`).

    Raises ValueError for a key with no match words, RuleExists for a duplicate in the same
    scope, and EditFailed when the new text does not load as the old rules plus the new one.
    """
    match = _match_words(key)
    if not match:
        raise ValueError(f"key {key!r} has no words to match")
    old = rules_from_text(text)
    if any(r.replace is not None and r.match == match and r.episode == episode for r in old):
        where = f"episode {episode}" if episode else "the global rules"
        raise RuleExists(f"{where} already has a rule for {' '.join(match)!r}")
    new_text = _edited(text, key, value, episode)
    try:
        new = rules_from_text(new_text)
    except yaml.YAMLError as exc:
        raise EditFailed(f"the edited corrections.yaml does not parse: {exc}") from exc
    if Counter(new) != Counter([*old, CorrectionRule(match, value, episode)]):
        raise EditFailed("the edited corrections.yaml does not load as the old rules plus one")
    return new_text
