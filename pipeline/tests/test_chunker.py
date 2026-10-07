import json
from itertools import pairwise
from pathlib import Path

from wts.chunker import build_chunks, decode_word_times, encode_word_times
from wts.words import Sentence, Word


def sent(words: int, start_ms: int = 0, word_ms: int = 300, label: str = "w") -> Sentence:
    ws = [
        Word(f"{label}{i}" + ("." if i == words - 1 else ""), start_ms + i * word_ms,
             start_ms + (i + 1) * word_ms - 1, 0.9)
        for i in range(words)
    ]
    return Sentence(tuple(ws))


def sentences_every(duration_ms: int, n: int) -> list[Sentence]:
    words = 10
    return [sent(words, i * duration_ms, duration_ms // words, label=f"s{i}w") for i in range(n)]


def one_sentence(duration_ms: int, words: int) -> Sentence:
    step = duration_ms // words
    return Sentence(tuple(Word(f"w{i}", i * step, (i + 1) * step - 1, 0.9) for i in range(words)))


def last_sentence_text(chunk, sents):
    inside = [s for s in sents if s.start_ms >= chunk.start_ms and s.end_ms <= chunk.end_ms]
    return inside[-1].text


def test_word_times_roundtrip():
    starts = [12_000, 12_300, 12_310, 13_000]
    enc = encode_word_times(starts, 12_000)
    assert enc == "0,300,10,690" and decode_word_times(enc, 12_000) == starts


def test_word_times_match_worker_fixture():
    # The Worker's decoder (worker/src/wordtimes.ts) is tested against the same cases.
    path = Path(__file__).resolve().parents[2] / "worker/test/fixtures/word_times.json"
    cases = json.loads(path.read_text())
    assert cases
    for case in cases:
        times, start, encoded = case["times"], case["start_ms"], case["encoded"]
        assert encode_word_times(times, start) == encoded, case["name"]
        assert decode_word_times(encoded, start) == times, case["name"]


def test_chunks_about_30s_with_one_sentence_overlap():
    sents = sentences_every(5_000, n=20)  # 20 sentences, 5 s each
    chunks = build_chunks(sents, [False] * 20)
    assert len(chunks) > 1
    assert all(30_000 <= c.end_ms - c.start_ms + 1 <= 45_000 for c in chunks[:-1])
    for a, b in pairwise(chunks):
        assert b.text.startswith(last_sentence_text(a, sents))
    assert [c.seq for c in chunks] == list(range(len(chunks)))
    assert chunks[-1].end_ms == sents[-1].end_ms  # nothing dropped at the end
    assert all(len(c.text.split()) == len(c.word_times.split(",")) for c in chunks)


def test_word_times_decode_to_real_word_starts():
    sents = sentences_every(5_000, n=8)
    chunk = build_chunks(sents, [False] * 8)[1]
    starts = decode_word_times(chunk.word_times, chunk.start_ms)
    all_words = {w.text: w.start_ms for s in sents for w in s.words}
    assert starts == [all_words[t] for t in chunk.text.split()]


def test_unpunctuated_monologue_is_split_under_max():
    sents = [one_sentence(duration_ms=200_000, words=500)]
    chunks = build_chunks(sents, [False])
    assert len(chunks) >= 5 and all(c.end_ms - c.start_ms + 1 <= 45_000 for c in chunks)
    assert chunks[-1].end_ms == sents[0].end_ms


def test_long_last_sentence_is_not_repeated_as_its_own_chunk():
    sents = [sent(10, 0, 500), sent(31, 5_000, 1_000), sent(10, 36_000, 500)]
    chunks = build_chunks(sents, [False] * 3)
    texts = [c.text for c in chunks]
    assert sents[1].text not in texts  # never a chunk that is only the repeated overlap
    assert chunks[-1].end_ms == sents[-1].end_ms


def test_short_episode_gives_one_chunk():
    chunks = build_chunks([sent(5)], [False])
    assert len(chunks) == 1 and chunks[0].text == "w0 w1 w2 w3 w4."


def test_no_sentences_gives_no_chunks():
    assert build_chunks([], []) == []


def test_boilerplate_threshold_60_percent():
    assert build_chunks([sent(6), sent(4, 2000)], [True, False])[0].is_boilerplate is True
    assert build_chunks([sent(5), sent(5, 2000)], [True, False])[0].is_boilerplate is False
