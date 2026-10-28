"""Synthetic cases (spec §7.2 source 2, plan 5 Task 5): a local model writes the query for a
sampled chunk, so the right answer is that chunk."""

import json

import httpx
import pytest
from click.testing import CliRunner
from conftest import insert_episode

from wts.cli import main
from wts.evalset.cases import load_cases
from wts.evalset.generate import (
    OLLAMA_URL,
    PROMPT,
    GenerateError,
    ask_model,
    clean_query,
    generate,
    sample_chunks,
    write_synthetic,
)
from wts.net import new_client

LONG = "We talked about flattening the top of a workbench with a jack plane. " * 8


def add_chunk(conn, episode_id, seq, start_ms, text=LONG, boilerplate=0):
    conn.execute(
        "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate)"
        " values (?, ?, ?, ?, ?, '[]', ?)",
        (episode_id, seq, start_ms, start_ms + 60_000, text, boilerplate))
    conn.commit()


@pytest.fixture
def corpus(conn):
    published = insert_episode(conn, number=71, status="published")
    unpublished = insert_episode(conn, number=72, status="embedded")
    add_chunk(conn, published, 0, 0)
    add_chunk(conn, published, 1, 61_000)
    add_chunk(conn, published, 2, 122_000, boilerplate=1)
    add_chunk(conn, published, 3, 183_000, text="too short")
    add_chunk(conn, unpublished, 0, 0)
    return conn


def test_sample_takes_long_non_boilerplate_chunks_of_published_episodes(corpus):
    rows = sample_chunks(corpus, 10, seed=1)
    assert [(r["number"], r["start_ms"]) for r in rows] == [(71, 0), (71, 61_000)]


def test_the_same_seed_gives_the_same_sample(corpus):
    a = [r["start_ms"] for r in sample_chunks(corpus, 1, seed=3)]
    assert a == [r["start_ms"] for r in sample_chunks(corpus, 1, seed=3)]


@pytest.mark.parametrize(("raw", "clean"), [
    ("flattening a workbench top", "flattening a workbench top"),
    ('"Flattening a workbench top."\n', "Flattening a workbench top"),
    ("Query: flattening a bench\nBecause…", "flattening a bench"),
    ("", None),
    ("one", None),
    ("a b c d e f g h i j k l m n o p", None),  # more than 12 words
    ("year:2020 sprayer", None),  # query syntax
    ("-glue clamps", None),
    # A thinking model that ignores `think: false` puts its reasoning first, in tags.
    ("<think>\nThe passage is about cauls.\n</think>\n\nkeeping a glue-up flat", "keeping a glue-up flat"),
    # The show's name or "podcast"/"episode" matches every episode's intro, not the passage
    # (2026-10-27: a fifth of the generated queries had them).
    ("Wood Talk podcast sharpening discussion", None),
    ("woodtalk Halloween candy tradition", None),
    ("Renaissance festival medieval fair podcast episode", None),
    ("which episode covered milk paint", None),
    ("podcasting setup for a shop", "podcasting setup for a shop"),
])
def test_clean_query(raw, clean):
    assert clean_query(raw) == clean


def test_the_prompt_keeps_the_show_out_of_the_query():
    instruction = PROMPT.split("\n\n")[-1]
    assert "Don't name the show or use the words podcast or episode" in instruction


def test_ask_model_posts_to_ollama(respx_mock):
    route = respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        return_value=httpx.Response(200, json={"response": "flattening a bench top"}))
    with new_client() as client:
        assert ask_model(client, "qwen2.5:7b", LONG, seed=4) == "flattening a bench top"
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "qwen2.5:7b" and sent["stream"] is False
    assert sent["options"] == {"temperature": 0, "seed": 4}
    # A thinking model (qwen3) answers at once, without its reasoning in the reply.
    assert sent["think"] is False
    assert LONG.strip() in sent["prompt"]


def test_ask_model_at_another_ollama(respx_mock):
    route = respx_mock.post("https://ollama.example.org/api/generate").mock(
        return_value=httpx.Response(200, json={"response": "a b c"}))
    with new_client() as client:
        ask_model(client, "m", LONG, seed=1, url="https://ollama.example.org/")
    assert route.called


def test_another_ollama_not_reachable_names_it(respx_mock):
    respx_mock.post("https://ollama.example.org/api/generate").mock(
        side_effect=httpx.ConnectError("refused"))
    with new_client() as client, pytest.raises(GenerateError, match="ollama.example.org"):
        ask_model(client, "m", LONG, seed=1, url="https://ollama.example.org")


def test_generate_uses_the_url(corpus, respx_mock):
    route = respx_mock.post("https://ollama.example.org/api/generate").mock(
        return_value=httpx.Response(200, json={"response": "flattening a workbench top"}))
    with new_client() as client:
        cases, _ = generate(corpus, client, "m", count=1, seed=1, url="https://ollama.example.org")
    assert route.called and len(cases) == 1


def test_ollama_not_running_says_start_it(respx_mock):
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(side_effect=httpx.ConnectError("refused"))
    with new_client() as client, pytest.raises(GenerateError, match="Ollama app"):
        ask_model(client, "m", LONG, seed=1)


def test_a_missing_model_says_pull_it(respx_mock):
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        return_value=httpx.Response(404, json={"error": "model 'm' not found"}))
    with new_client() as client, pytest.raises(GenerateError, match="ollama pull m"):
        ask_model(client, "m", LONG, seed=1)


def test_generate_writes_loadable_cases_and_counts_the_skipped(corpus, respx_mock, tmp_path):
    answers = iter(["leveling a bench surface", ""])
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        side_effect=lambda request: httpx.Response(200, json={"response": next(answers)}))
    with new_client() as client:
        cases, skipped = generate(corpus, client, "m", count=2, seed=1)
    assert skipped == 1
    assert cases == [{"id": "syn-071-0000", "query": "leveling a bench surface",
                      "tag": "paraphrase", "expect": [{"episode": 71, "at": "0:00"}]}]
    write_synthetic(cases, tmp_path / "synthetic.yaml", header="# generated")
    text = (tmp_path / "synthetic.yaml").read_text()
    assert text.startswith("# generated\n")
    [case] = load_cases(tmp_path)
    assert case.mode == "both" and case.expect[0].at_s == 0


def test_a_query_made_of_the_passages_own_words_is_tagged_exact(corpus, respx_mock):
    # LONG says "flattening the top of a workbench with a jack plane": the first reply is all its
    # words (stems: "flatten" for "flattened"), the second is not.
    answers = iter(["flattened workbench top", "leveling a bench surface"])
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        side_effect=lambda request: httpx.Response(200, json={"response": next(answers)}))
    with new_client() as client:
        cases, _ = generate(corpus, client, "m", count=2, seed=1)
    assert [(c["query"], c["tag"]) for c in cases] == [
        ("flattened workbench top", "exact"), ("leveling a bench surface", "paraphrase")]


def test_cli_needs_a_model(wts_home, monkeypatch):
    r = CliRunner().invoke(main, ["eval", "generate"])
    assert r.exit_code == 2 and "eval_model" in r.output
