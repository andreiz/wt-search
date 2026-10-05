"""Title and date helpers and the error type shared by the platform matchers (spec §3.2)."""

import re
import unicodedata
from datetime import UTC, date, datetime

from wts.stems import split_title

_APOSTROPHES = re.compile("['’‘ʼ]")  # dropped without a space: "don't" → "dont"
_NOT_WORD = re.compile(r"[\W_]+")


class PlatformError(Exception):
    """A matcher failure whose message is safe to log (it never carries a URL or a secret)."""


def normalize_title(title: str) -> str:
    """A title reduced to what every platform agrees on, for equality matching.

    Lowercase, episode-number markers removed (every style `split_title` knows), apostrophes
    dropped (smart or straight), accents folded, other punctuation turned into single spaces.
    """
    clean = split_title(title, None)[1].lower()
    clean = _APOSTROPHES.sub("", clean)
    folded = unicodedata.normalize("NFKD", clean)
    clean = "".join(c for c in folded if not unicodedata.combining(c))
    return _NOT_WORD.sub(" ", clean).strip()


def day_of(timestamp: str) -> date:
    """The UTC calendar date of an ISO 8601 date or datetime (naive values count as UTC)."""
    moment = datetime.fromisoformat(timestamp)
    if moment.tzinfo is not None:
        moment = moment.astimezone(UTC)
    return moment.date()
