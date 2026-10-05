"""Stable, human-readable file name stems (spec §3.4)."""

import re
import unicodedata
from collections.abc import Callable
from datetime import date

# Episode numbers appear in many house styles: "#85", "WT127", "WT 607", "Wood Talk 595",
# "WoodTalk 599", "Ep. 313", "Episode 400", a leading "552 -" or a trailing "| 609".
_MARKED = re.compile(
    r"(?:(?:\bwood\s*talk|\bwt|\bep(?:isode)?\.?)[\s\-:#|–—]*|#\s*)(\d{1,4})\b", re.IGNORECASE
)
_LEADING = re.compile(r"^\s*(\d{1,4})\s*[-–—:|]")
_TRAILING = re.compile(r"(?:^|[\s|:–—-])(\d{1,4})\s*$")
_EDGE_SEPARATORS = re.compile(r"^[\s|:–—.-]+|[\s|:–—-]+$")


def _plausible_bare_number(n: int, itunes_number: int | None) -> bool:
    if itunes_number is not None:
        return n == itunes_number
    return 10 <= n < 1900  # not a year, not "5 Tips"


def split_title(title: str, itunes_number: int | None) -> tuple[int | None, str]:
    """The episode number (iTunes field wins) and the title with the number marker removed."""
    number, clean = itunes_number, title
    marked = _MARKED.search(clean)
    if marked:
        number = number if number is not None else int(marked[1])
        clean = clean[: marked.start()] + clean[marked.end() :]
    else:
        for pattern in (_LEADING, _TRAILING):
            bare = pattern.search(clean)
            if bare and _plausible_bare_number(int(bare[1]), itunes_number):
                number = int(bare[1])
                clean = clean[: bare.start(1)] + clean[bare.end(1) :]
                break
    return number, _EDGE_SEPARATORS.sub("", clean) or title


def slugify(title: str, max_len: int = 60) -> str:
    title = title.replace("'", "").replace("’", "")  # "doesn't" → "doesnt", not "doesn-t"
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
