"""Transcript quality guards (spec §3.3), applied to raw Whisper output in `wts chunk`."""

from wts.words import Word, normalize_text

NO_SPEECH_PROB = 0.6
LOW_LOGPROB = -1.0
MAX_NGRAM = 8
LOOP_REPEATS = 4  # phrases of 2+ words
SINGLE_WORD_LOOP_REPEATS = 8  # "yeah, yeah, yeah, yeah" is normal conversation
LOOP_SHARE = 0.5  # the loop must be at least half the segment
WPM_LOW = 80
WPM_HIGH = 260


def _is_no_speech(seg: dict) -> bool:
    return seg["no_speech_prob"] > NO_SPEECH_PROB and seg["avg_logprob"] < LOW_LOGPROB


def _has_loop(tokens: list[str]) -> bool:
    """A Whisper repetition loop: one phrase repeated back to back over most of the segment."""
    for n in range(1, MAX_NGRAM + 1):
        needed = SINGLE_WORD_LOOP_REPEATS if n == 1 else LOOP_REPEATS
        i = 0
        while i + n <= len(tokens):
            gram = tokens[i : i + n]
            repeats = 1
            while tokens[i + repeats * n : i + (repeats + 1) * n] == gram:
                repeats += 1
            if repeats >= needed and repeats * n >= LOOP_SHARE * len(tokens):
                return True
            i += 1
    return False


def _spread(texts: list[str], start_s: float, end_s: float) -> list[Word]:
    span = max(end_s - start_s, 0.0)
    step = span / len(texts) if texts else 0.0
    return [
        Word(t, round((start_s + i * step) * 1000), round((start_s + (i + 1) * step) * 1000), 0.0)
        for i, t in enumerate(texts)
    ]


def _segment_words(seg: dict) -> list[Word]:
    """Whisper's words as single tokens. A "word" like " - the" becomes two Words."""
    if not seg["words"]:
        return _spread(seg["text"].split(), seg["start"], seg["end"])
    words = []
    for w in seg["words"]:
        start, end = round(w["start"] * 1000), round(w["end"] * 1000)
        words += [Word(t, start, end, w["probability"]) for t in w["word"].split()]
    return words


def _times_ok(words: list[Word], previous_ms: int, limit_ms: float | None) -> bool:
    for w in words:
        if w.start_ms < previous_ms or (limit_ms is not None and w.start_ms > limit_ms):
            return False
        previous_ms = w.start_ms
    return True


def clean_transcript(data: dict, duration_s: float | None) -> tuple[list[Word], list[str]]:
    """`duration_s` should be the downloaded file's probed length when known."""
    flags: list[str] = []
    kept = []
    for seg in data["segments"]:
        if _is_no_speech(seg):
            continue
        if _has_loop(normalize_text(seg["text"]).split()):
            if "loop_cut" not in flags:
                flags.append("loop_cut")
            continue
        kept.append(seg)

    limit_ms = (duration_s + 1) * 1000 if duration_s else None
    words: list[Word] = []
    for seg in kept:
        seg_words = _segment_words(seg)
        previous_ms = words[-1].start_ms if words else -1
        if not _times_ok(seg_words, previous_ms, limit_ms):
            # Re-time only this segment, evenly across its own span.
            if "bad_word_times" not in flags:
                flags.append("bad_word_times")
            spread = _spread([w.text for w in seg_words], seg["start"], seg["end"])
            seg_words = [Word(s.text, s.start_ms, s.end_ms, w.prob)
                         for s, w in zip(spread, seg_words, strict=True)]
        words.extend(seg_words)

    minutes = (duration_s or (words[-1].end_ms / 1000 if words else 0)) / 60
    if minutes > 0:
        wpm = len(words) / minutes
        if wpm < WPM_LOW:
            flags.append("wpm_low")
        elif wpm > WPM_HIGH:
            flags.append("wpm_high")
    return words, flags
