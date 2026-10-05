"""Transcript quality guards (spec §3.3), applied to raw Whisper output in `wts chunk`."""

from wts.words import Word, normalize_text

NO_SPEECH_PROB = 0.6
LOW_LOGPROB = -1.0
MAX_NGRAM = 8
LOOP_REPEATS = 4
WPM_LOW = 80
WPM_HIGH = 260


def _is_no_speech(seg: dict) -> bool:
    return seg["no_speech_prob"] > NO_SPEECH_PROB and seg["avg_logprob"] < LOW_LOGPROB


def _has_loop(tokens: list[str]) -> bool:
    for n in range(1, MAX_NGRAM + 1):
        for i in range(len(tokens) - n * LOOP_REPEATS + 1):
            gram = tokens[i : i + n]
            if all(tokens[i + k * n : i + (k + 1) * n] == gram for k in range(1, LOOP_REPEATS)):
                return True
    return False


def _spread(texts: list[str], start_s: float, end_s: float) -> list[Word]:
    span = max(end_s - start_s, 0.0)
    step = span / len(texts) if texts else 0.0
    return [
        Word(t, round((start_s + i * step) * 1000), round((start_s + (i + 1) * step) * 1000), 0.0)
        for i, t in enumerate(texts)
    ]


def _segment_words(seg: dict) -> list[Word]:
    if not seg["words"]:
        return _spread(seg["text"].split(), seg["start"], seg["end"])
    return [
        Word(w["word"].strip(), round(w["start"] * 1000), round(w["end"] * 1000), w["probability"])
        for w in seg["words"]
        if w["word"].strip()
    ]


def _times_ok(words: list[Word], duration_s: int | None) -> bool:
    limit_ms = (duration_s + 1) * 1000 if duration_s else None
    previous = -1
    for w in words:
        if w.start_ms < previous or (limit_ms is not None and w.start_ms > limit_ms):
            return False
        previous = w.start_ms
    return True


def clean_transcript(data: dict, duration_s: int | None) -> tuple[list[Word], list[str]]:
    flags: list[str] = []
    kept = []
    for seg in data["segments"]:
        if _is_no_speech(seg):
            continue
        if _has_loop(normalize_text(seg["text"]).split()):
            continue
        kept.append(seg)

    per_segment = [_segment_words(s) for s in kept]
    words = [w for ws in per_segment for w in ws]
    if not _times_ok(words, duration_s):
        flags.append("bad_word_times")
        words = []
        for seg, ws in zip(kept, per_segment, strict=True):
            spread = _spread([w.text for w in ws], seg["start"], seg["end"])
            words.extend(Word(s.text, s.start_ms, s.end_ms, w.prob) for s, w in zip(spread, ws))

    minutes = (duration_s or (words[-1].end_ms / 1000 if words else 0)) / 60
    if minutes > 0:
        wpm = len(words) / minutes
        if wpm < WPM_LOW:
            flags.append("wpm_low")
        elif wpm > WPM_HIGH:
            flags.append("wpm_high")
    return words, flags
