"""Stable, human-readable file name stems (spec §3.4)."""

import re
import unicodedata
from collections.abc import Callable
from datetime import date


def slugify(title: str, max_len: int = 60) -> str:
    ascii_text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    if len(slug) > max_len:
        cut = slug[: max_len + 1]
        slug = cut.rsplit("-", 1)[0] if "-" in cut else slug[:max_len]
    return slug or "untitled"


def make_stem(
    published_at: date, number: int | None, title: str, taken: Callable[[str], bool]
) -> str:
    parts = [published_at.isoformat()]
    if number is not None:
        parts.append(f"ep{number:03d}")
    parts.append(slugify(title))
    base = "_".join(parts)
    stem, n = base, 1
    while taken(stem):
        n += 1
        stem = f"{base}-{n}"
    return stem
