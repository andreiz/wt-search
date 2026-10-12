"""What the review page shows for one episode: its words, sentences, chunks and weak spots.

The words are the cleaned and corrected ones `wts chunk` produces (`prepare_episode`), so the
page shows what search has.
"""

import json
import re
import sqlite3
from collections.abc import Sequence
from difflib import SequenceMatcher
from pathlib import Path

from wts.chunking import prepare_episode
from wts.corrections import CorrectionRule
from wts.words import Word

LOW_PROB = 0.5  # a word Whisper was less sure of than this counts as unsure

# Whisper is often unsure of small words, fillers and whatever starts a sentence ("And", "Like,",
# "Yeah."), and almost always right about them: in three real episodes they were 200 of every 300
# words under LOW_PROB, half of them the first word of a sentence. They are not marked, so the
# marks that are left are worth a look. Function words and fillers only: nothing that means
# something in a shop ("saw", "oak", "up", "off", "set").
SMALL_WORDS = frozenset(
    """
a an the and or but if then so than as because of at by for from in into on onto to with about
is are was were be been being am do does did doing have has had having
i me my we us our you your he him his she her it its they them their
this that these those there here what which who whom whose when where why how
can could would should will shall may might must not no just very any some also too
i'm i've i'd i'll it's that's there's what's let's you're we're they're
don't doesn't didn't can't won't isn't wasn't
yeah yes yep like well right okay ok oh uh um mm hmm huh ah
""".split()  # noqa: SIM905 — a block of words is easier to edit than a list literal
)
_EDGES = re.compile(r"^[\W_]+|[\W_]+$")


def is_unsure(text: str, prob: float) -> bool:
    """Whether the page marks this word: Whisper doubted it, and it is not a small word."""
    if prob >= LOW_PROB:
        return False
    word = _EDGES.sub("", text.lower().replace("’", "'"))
    return bool(word) and word not in SMALL_WORDS


def corrected_spans(heard: Sequence[Word], shown: Sequence[Word]) -> list[list]:
    """Where corrections changed the words: `[index, count, text Whisper wrote]`, in order.

    `index` and `count` are the corrected words in `shown` (`count` is 0 where a rule deleted
    words: the text then belongs before word `index`, which can be one past the end). A word is
    the same when its text and start are, so the comparison has almost nothing to try.
    """
    matcher = SequenceMatcher(
        None,
        [(w.text, w.start_ms) for w in heard],
        [(w.text, w.start_ms) for w in shown],
        autojunk=False,
    )
    return [
        [j1, j2 - j1, " ".join(w.text.strip() for w in heard[i1:i2])]
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
        if tag != "equal" and i2 > i1
    ]


def episode_payload(
    conn: sqlite3.Connection, row: sqlite3.Row, corrections: Sequence[CorrectionRule]
) -> dict:
    sentences, _ = prepare_episode(row, corrections)
    shown = [w for s in sentences for w in s.words]
    heard = [w for s in prepare_episode(row, [])[0] for w in s.words] if corrections else shown
    words = [[w.text, w.start_ms, w.end_ms, w.prob] for w in shown]
    fixes = corrected_spans(heard, shown)
    # A corrected word keeps Whisper's doubt about what it replaced, but it has been dealt with.
    fixed = {i for index, count, _ in fixes for i in range(index, index + count)}
    firsts, index = [], 0
    for s in sentences:
        firsts.append(index)
        index += len(s.words)
    chunks = [
        {key: c[key] for key in ("id", "seq", "start_ms", "end_ms", "is_boilerplate")}
        for c in conn.execute(
            "select id, seq, start_ms, end_ms, is_boilerplate from chunks "
            "where episode_id = ? order by seq",
            (row["id"],),
        )
    ]
    return {
        "episode": {
            "id": row["id"],
            "number": row["number"],
            "title": row["title"],
            "published_at": row["published_at"],
            "stem": row["stem"],
            "duration_s": row["duration_s"],
            "flags": json.loads(row["flags"]),
            "reviewed_at": row["reviewed_at"],
            "has_audio": bool(row["audio_path"]) and Path(row["audio_path"]).is_file(),
        },
        "words": words,
        "unsure": [
            i for i, w in enumerate(words) if i not in fixed and is_unsure(w[0], w[3])
        ],
        "fixes": fixes,
        "sentences": firsts,
        "chunks": chunks,
        "worst": worst_stretches(words),
    }


def worst_stretches(
    words: Sequence[Sequence], window_ms: int = 60_000, top: int = 5, min_words: int = 20
) -> list[dict]:
    """The stretches with the largest share of unsure words (`is_unsure`), worst first.

    The windows of `spikes/transcript_peek.py worst`: fixed and consecutive from 0 (0-60 s,
    60-120 s, ...), by each word's start; a stretch with fewer than `min_words` words is mostly
    music or silence, so its share means little and it is skipped. Words are
    `[text, start_ms, end_ms, prob]`.
    """
    stretches_words: dict[int, list[Sequence]] = {}
    for word in words:
        stretches_words.setdefault(word[1] // window_ms, []).append(word)
    stretches = [
        (k, sum(is_unsure(w[0], w[3]) for w in ws) / len(ws), sum(w[3] for w in ws) / len(ws))
        for k, ws in stretches_words.items()
        if len(ws) >= min_words
    ]
    # Ties go to the lower mean probability, then the earlier stretch.
    stretches.sort(key=lambda s: (-s[1], s[2], s[0]))
    return [{"start_ms": k * window_ms, "share": share} for k, share, _ in stretches[:top]]


def next_flagged(conn: sqlite3.Connection) -> sqlite3.Row | None:
    """The oldest episode (by `published_at`) with flags, not yet reviewed, and a transcript."""
    return conn.execute(
        "select * from episodes where flags != '[]' and reviewed_at is null "
        "and transcript_path is not null and transcript_path != '' "
        "order by published_at, id limit 1"
    ).fetchone()


def chunk_position(conn: sqlite3.Connection, chunk_id: int) -> tuple[int, int] | None:
    """`(episode_id, start_ms)` of a local chunk, or None if there is no such chunk."""
    row = conn.execute(
        "select episode_id, start_ms from chunks where id = ?", (chunk_id,)
    ).fetchone()
    return (row["episode_id"], row["start_ms"]) if row else None
