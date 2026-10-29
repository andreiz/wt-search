import numpy as np
from conftest import ws

from wts.boilerplate import Params, find_spans, run_hashes, shared_digest, shared_runs, tokens

READ = (
    "go to rockler dot com and use the code wood talk to save ten percent on your whole order today"
)


def eps_with(shared_text: str, k: int) -> list[np.ndarray]:
    return [
        run_hashes(tokens(ws(f"unique{i} words here {shared_text} tail{i} end")), 8)
        for i in range(k)
    ]


def test_tokens_one_per_word():
    assert tokens(ws("Hello, — 623 Wood-Talk")) == [
        "hello", "", "sixhundredandtwentythree", "woodtalk",
    ]


def test_run_hashes_stable_and_distinct():
    a = run_hashes(tokens(ws(READ + " " + READ)), 8)
    assert a.dtype == np.uint64 and a.tolist() == sorted(set(a.tolist()))
    assert set(run_hashes(tokens(ws(READ)), 8).tolist()) <= set(a.tolist())
    assert np.array_equal(run_hashes(tokens(ws(READ)), 8), run_hashes(tokens(ws(READ)), 8))
    assert len(run_hashes(tokens(ws("too short")), 8)) == 0


def test_shared_runs_counts_episodes():
    assert len(shared_runs(eps_with(READ, 4), 5)) == 0
    assert len(shared_runs(eps_with(READ, 5), 5)) > 0
    assert len(shared_runs([], 5)) == 0


def test_find_spans_covers_the_read_only():
    shared = shared_runs(eps_with(READ, 5), 5)
    words = ws(f"we talked about glue {READ} and then about clamps")
    ((s, e),) = find_spans(words, shared, Params(min_span_words=10))
    assert " ".join(w.text for w in words[s:e]) == READ


def test_short_spans_dropped_and_gaps_bridged():
    shared = shared_runs(eps_with(READ, 5), 5)
    words = ws(f"intro {READ} joke {READ} outro")
    no_gap = Params(min_span_words=40, max_gap_words=0)
    assert find_spans(words, shared, no_gap) == []  # each piece is 20 words
    assert find_spans(words, shared, Params(min_span_words=30, max_gap_words=1)) == [(1, 42)]
    assert find_spans(words, shared, Params(min_span_words=10, max_gap_words=0)) == [
        (1, 21), (22, 42),
    ]


def test_empty_token_inside_a_span_is_covered():
    shared = shared_runs(eps_with(READ, 5), 5)
    half = READ.split()
    words = ws(" ".join(half[:9] + ["—"] + half[9:]))
    assert find_spans(words, shared, Params(min_span_words=10)) == [(0, len(words))]


def test_span_at_episode_edges_and_short_episode():
    shared = shared_runs(eps_with(READ, 5), 5)
    assert find_spans(ws(READ), shared, Params(min_span_words=10)) == [(0, 20)]
    assert find_spans(ws("hi"), shared) == []
    assert find_spans([], shared) == []


def test_digest_depends_on_content():
    assert shared_digest(np.array([1, 2], np.uint64)) != shared_digest(np.array([1, 3], np.uint64))
    assert shared_digest(np.array([1, 2], np.uint64)) == shared_digest(np.array([1, 2], np.uint64))
