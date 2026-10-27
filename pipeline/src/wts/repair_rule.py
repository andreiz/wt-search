"""The automatic rule: is a proposed repair clear-cut enough to apply without a look?

Repair spec §5.3. Five checks; a repair that fails none is clear-cut (applied without review only
when `repair_auto` is on), one that fails any waits for the maintainer with the failed numbers.
All times are milliseconds.
"""

from collections.abc import Sequence
from difflib import SequenceMatcher

from wts.guards import _has_loop
from wts.repair import Proposal
from wts.words import Word, normalize_text

MIN_ANCHOR = 5
RATE = (1.5, 4.5)  # new words per second of uncovered speech
CONFIDENT_PROB = 0.5
CONFIDENT_SHARE = 0.8
AGREE = 0.9
MIN_REPEAT_TOKENS = 4
STOCK_PHRASES = (
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "like and subscribe",
)


def _tokens(words: Sequence[Word]) -> list[str]:
    return normalize_text(" ".join(w.text for w in words)).split()


def _contains_run(haystack: list[str], needle: list[str]) -> bool:
    n = len(needle)
    return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))


def judge(
    p: Proposal, second: Proposal | None, speech_ms: int, nearby: Sequence[Word]
) -> list[int]:
    """The numbers of the checks `p` fails (1-5); empty when it is clear-cut."""
    failed = []
    after = _tokens(p.after)

    # 1. Both edges are pinned by matching words.
    if p.left_anchor < MIN_ANCHOR or p.right_anchor < MIN_ANCHOR:
        failed.append(1)

    # 2. The number of new words fits the speech they fill.
    new_words = len(p.after) - len(p.before)
    if speech_ms <= 0 or not RATE[0] <= new_words / (speech_ms / 1000) <= RATE[1]:
        failed.append(2)

    # 3. Most words are ones the model is sure of.
    sure = sum(w.prob >= CONFIDENT_PROB for w in p.after)
    if not p.after or sure / len(p.after) < CONFIDENT_SHARE:
        failed.append(3)

    # 4. Not a loop, a copy of a neighbouring sentence, or a stock phrase.
    text = " ".join(after)
    if (
        _has_loop(after)
        or (len(after) >= MIN_REPEAT_TOKENS and _contains_run(_tokens(nearby), after))
        or any(phrase in text for phrase in STOCK_PHRASES)
    ):
        failed.append(4)

    # 5. A second pass, shifted, says nearly the same.
    if second is None or (
        SequenceMatcher(None, after, _tokens(second.after), autojunk=False).ratio() < AGREE
    ):
        failed.append(5)

    return failed
