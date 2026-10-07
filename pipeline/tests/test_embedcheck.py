"""`wts check-embeddings` (plan 2, Task 9). The fake Workers AI embeds each text with the same
deterministic FakeEmbedder that wrote the stored vectors, so by default it agrees with the Mac;
tests then scale, rotate or corrupt what it returns."""

import json

import httpx
import numpy as np
import pytest
from click.testing import CliRunner
from conftest import FakeEmbedder, force_status
from test_publish import set_chunks

from wts.cli import main
from wts.cloudflare import CloudflareApi, CloudflareError
from wts.db import connect
from wts.embedcheck import MIN_COSINE, NothingEmbedded, check_embeddings
from wts.net import new_client
from wts.steps import run_embed

ACCOUNT = "acct0123"
TOKEN = "cf-token-SECRET-abcdef0123456789"
AI_URL = (f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
          "/ai/run/@cf/baai/bge-base-en-v1.5")


@pytest.fixture
def conn(paths):
    """The state.db the CLI opens, so CLI tests see the episodes made here."""
    c = connect(paths.state_db)
    yield c
    c.close()


@pytest.fixture
def api():
    with new_client() as client:
        yield CloudflareApi(client, ACCOUNT, TOKEN, sleep=lambda s: None)


@pytest.fixture
def corpus(conn, make_episode, paths, cfg):
    """`make(n)` makes n embedded episodes, oldest first, and returns their ids. Each has
    boilerplate chunks among the normal ones; the embeddings skip the boilerplate."""

    def make(n: int = 6, status: str = "embedded") -> list[int]:
        ids = []
        for i in range(n):
            e = make_episode(status="chunked", published_at=f"{2010 + i}-03-14T12:00:00+00:00")
            set_chunks(conn, e, [
                (f"episode {i} we cut dovetails by hand", False),
                (f"episode {i} brought to you by rockler", True),
                (f"episode {i} then we talked about finishing walnut", False),
                (f"episode {i} and sharpening chisels on a strop", False),
                (f"episode {i} sponsor message from lee valley", True),
            ])
            ids.append(e)
        run_embed(conn, paths, cfg, ids, embedder=FakeEmbedder())
        if status != "embedded":  # `embedded` is what run_embed leaves
            for e in ids:
                force_status(conn, e, status)
        return ids

    return make


def envelope(vectors, pooling: str | None = "cls", shape=None) -> dict:
    result = {"shape": shape or [len(vectors), 768], "data": [list(map(float, v)) for v in vectors]}
    if pooling is not None:
        result["pooling"] = pooling
    return {"success": True, "errors": [], "messages": [], "result": result}


def workers_ai(respx_mock, transform=lambda v: v, **kwargs):
    """Route for the ai/run URL: each text's FakeEmbedder vector, passed through `transform`,
    in an envelope. `kwargs` go to `envelope`."""

    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["text"]
        vectors = [transform(v) for v in FakeEmbedder().embed(texts)]
        return httpx.Response(200, json=envelope(vectors, **kwargs))

    return respx_mock.post(AI_URL).mock(side_effect=handler)


def reply(respx_mock, body: dict):
    return respx_mock.post(AI_URL).mock(return_value=httpx.Response(200, json=body))


def sent(route) -> dict:
    assert route.call_count == 1  # one request, whatever n is
    return json.loads(route.calls.last.request.content)


def text_of(conn, chunk_id: int) -> str:
    return conn.execute("select text from chunks where id = ?", (chunk_id,)).fetchone()[0]


def episode_of(conn, chunk_id: int) -> int:
    return conn.execute("select episode_id from chunks where id = ?", (chunk_id,)).fetchone()[0]


# --- check_embeddings --------------------------------------------------------------------------


def test_matching_vectors_give_cosine_one(conn, paths, api, corpus, respx_mock):
    corpus()
    route = workers_ai(respx_mock)
    results = check_embeddings(conn, paths, api)
    assert len(results) == 5
    assert all(cos == pytest.approx(1.0, abs=1e-5) for _, cos in results)
    assert all(isinstance(chunk_id, int) for chunk_id, _ in results)
    assert route.call_count == 1


def test_request_asks_for_cls_pooling_and_sends_exactly_the_chosen_texts(
    conn, paths, api, corpus, respx_mock
):
    corpus()
    route = workers_ai(respx_mock)
    results = check_embeddings(conn, paths, api)
    body = sent(route)
    assert body["pooling"] == "cls"
    assert body["text"] == [text_of(conn, chunk_id) for chunk_id, _ in results]
    assert route.calls.last.request.headers["Authorization"] == f"Bearer {TOKEN}"


def test_boilerplate_texts_are_never_sent(conn, paths, api, corpus, respx_mock):
    corpus(10)
    route = workers_ai(respx_mock)
    check_embeddings(conn, paths, api, n=10)
    boilerplate = {r[0] for r in conn.execute("select text from chunks where is_boilerplate = 1")}
    assert boilerplate  # the corpus does have some
    texts = sent(route)["text"]
    assert len(texts) == 10
    assert not boilerplate & set(texts)


def test_scaled_vectors_still_pass(conn, paths, api, corpus, respx_mock):
    """Workers AI isn't assumed to return unit vectors: cosine normalises both sides."""
    corpus()
    workers_ai(respx_mock, transform=lambda v: v * 3)
    results = check_embeddings(conn, paths, api)
    assert all(cos == pytest.approx(1.0, abs=1e-5) for _, cos in results)


def test_rotated_vectors_fall_below_the_threshold(conn, paths, api, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, transform=lambda v: np.roll(v, 1))
    results = check_embeddings(conn, paths, api)
    assert results and all(cos < MIN_COSINE for _, cos in results)


def test_chunks_are_spread_across_episodes(conn, paths, api, corpus, respx_mock):
    ids = corpus(3)
    workers_ai(respx_mock)
    results = check_embeddings(conn, paths, api, n=5)
    # One chunk per episode, up to n: 3 episodes give 3 chunks.
    assert sorted(episode_of(conn, c) for c, _ in results) == sorted(ids)


def test_chunks_are_spread_by_date(conn, paths, api, corpus, respx_mock):
    ids = corpus(10)
    workers_ai(respx_mock)
    results = check_embeddings(conn, paths, api, n=5)
    picked = [ids.index(episode_of(conn, c)) for c, _ in results]
    assert picked == sorted(set(picked)) and len(picked) == 5  # oldest first, no repeats
    assert picked[0] <= 2 and picked[-1] >= 7  # reaches both ends of the back catalogue


def test_pick_is_deterministic(conn, paths, api, corpus, respx_mock):
    corpus(8)
    workers_ai(respx_mock)
    first = check_embeddings(conn, paths, api)
    second = check_embeddings(conn, paths, api)
    assert [c for c, _ in first] == [c for c, _ in second]


def test_published_episodes_count_but_other_statuses_and_missing_files_do_not(
    conn, paths, api, corpus, respx_mock
):
    ids = corpus(4, status="published")
    force_status(conn, ids[0], "error")
    force_status(conn, ids[1], "chunked")  # re-chunked: its stored vectors may be stale
    stem = conn.execute("select stem from episodes where id = ?", (ids[2],)).fetchone()[0]
    (paths.embeddings_dir / f"{stem}.npz").unlink()
    route = workers_ai(respx_mock)
    results = check_embeddings(conn, paths, api)
    assert [episode_of(conn, c) for c, _ in results] == [ids[3]]
    assert len(sent(route)["text"]) == 1


def test_a_chunk_that_changed_since_embedding_is_not_sent(conn, paths, api, corpus, respx_mock):
    """A stale .npz whose chunk is now boilerplate (or gone) must not be compared."""
    (e,) = corpus(1)
    conn.execute("update chunks set is_boilerplate = 1 where episode_id = ?", (e,))
    conn.commit()
    with pytest.raises(NothingEmbedded):
        check_embeddings(conn, paths, api)


def test_no_embeddings_is_a_clear_error_and_calls_nothing(conn, paths, api, respx_mock):
    route = respx_mock.post(AI_URL)
    with pytest.raises(NothingEmbedded, match=r"nothing embedded yet; run `wts embed`"):
        check_embeddings(conn, paths, api)
    assert route.call_count == 0


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(lambda texts: envelope([np.ones(768)] * (len(texts) - 1)), id="too-few"),
        pytest.param(lambda texts: envelope([np.ones(768)] * (len(texts) + 1)), id="too-many"),
        pytest.param(lambda texts: envelope([np.ones(100)] * len(texts), shape=[len(texts), 100]),
                     id="wrong-dimension"),
        pytest.param(lambda texts: envelope([np.ones(768)] * len(texts), shape=[1, 768]),
                     id="shape-disagrees"),
        pytest.param(lambda texts: envelope([np.ones(768)] * len(texts), pooling="mean"),
                     id="mean-pooling"),
        pytest.param(lambda texts: envelope([np.zeros(768)] * len(texts)), id="zero-vector"),
        pytest.param(lambda texts: {"success": True, "errors": [], "result": {}}, id="no-data"),
        pytest.param(lambda texts: {"success": True, "errors": [], "result": None},
                     id="no-result"),
    ],
)
def test_a_wrong_response_is_an_error(conn, paths, api, corpus, respx_mock, body):
    corpus()
    reply(respx_mock, body(["text"] * 5))  # the default corpus sends 5 texts
    with pytest.raises(CloudflareError):
        check_embeddings(conn, paths, api)


def test_a_missing_pooling_field_is_accepted(conn, paths, api, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, pooling=None)
    assert len(check_embeddings(conn, paths, api)) == 5


def test_mean_pooling_error_names_the_problem(conn, paths, api, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, pooling="mean")
    with pytest.raises(CloudflareError, match="pooling"):
        check_embeddings(conn, paths, api)


# --- CLI ---------------------------------------------------------------------------------------


@pytest.fixture
def cli_setup(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(f'cloudflare_account_id = "{ACCOUNT}"\n')
    monkeypatch.setenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", TOKEN)


def stem_of_chunk(conn, chunk_id: int) -> str:
    return conn.execute(
        "select e.stem from chunks c join episodes e on e.id = c.episode_id where c.id = ?",
        (chunk_id,)).fetchone()[0]


def test_cli_passes_and_prints_each_cosine(conn, cli_setup, corpus, respx_mock):
    corpus()
    route = workers_ai(respx_mock)
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[-1] == "ok"
    chosen = json.loads(route.calls.last.request.content)["text"]
    assert len(lines) == len(chosen) + 1
    for line, text in zip(lines, chosen, strict=False):
        chunk_id = conn.execute("select id from chunks where text = ?", (text,)).fetchone()[0]
        assert f"{chunk_id}" in line
        assert "1.0000" in line
        assert stem_of_chunk(conn, chunk_id) in line
    assert TOKEN not in result.output


def test_cli_n_option(conn, cli_setup, corpus, respx_mock):
    corpus(8)
    route = workers_ai(respx_mock)
    result = CliRunner().invoke(main, ["check-embeddings", "--n", "2"])
    assert result.exit_code == 0, result.output
    assert len(sent(route)["text"]) == 2


def test_cli_scaled_vectors_pass(conn, cli_setup, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, transform=lambda v: v * 3)
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 0, result.output


def test_cli_a_rotated_vector_fails_with_the_mismatch_message(conn, cli_setup, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, transform=lambda v: np.roll(v, 1))
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "pooling or model mismatch: cosine below 0.99" in result.output
    assert "ok" not in result.output.splitlines()


def test_cli_one_bad_chunk_fails_the_check(conn, cli_setup, corpus, respx_mock):
    corpus()
    seen = []

    def rotate_second(v):
        seen.append(v)
        return np.roll(v, 1) if len(seen) == 2 else v

    workers_ai(respx_mock, transform=rotate_second)
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "pooling or model mismatch" in result.output


def test_cli_names_a_missing_account_id(wts_home, monkeypatch):
    monkeypatch.setenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", TOKEN)
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 2
    assert "cloudflare_account_id" in result.output
    assert "[env." not in result.output  # Workers AI is account-wide: no environment needed


def test_cli_names_a_missing_token(wts_home, monkeypatch):
    monkeypatch.delenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", raising=False)
    (wts_home / "config.toml").write_text(f'cloudflare_account_id = "{ACCOUNT}"\n')
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "wts secrets set cloudflare_api_token" in result.output


def test_cli_with_nothing_embedded(cli_setup, respx_mock):
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "nothing embedded yet; run `wts embed`" in result.output
    assert "Traceback" not in result.output


def test_cli_reports_an_api_error_without_the_token(conn, cli_setup, corpus, respx_mock):
    corpus()
    respx_mock.post(AI_URL).mock(return_value=httpx.Response(
        403, json={"success": False, "result": None,
                   "errors": [{"code": 10000, "message": f"Authentication error {TOKEN}"}]}))
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "Cloudflare API error (HTTP 403)" in result.output
    assert TOKEN not in result.output


def test_cli_a_bad_response_is_an_error_not_a_crash(conn, cli_setup, corpus, respx_mock):
    corpus()
    workers_ai(respx_mock, pooling="mean")
    result = CliRunner().invoke(main, ["check-embeddings"])
    assert result.exit_code == 1
    assert "pooling" in result.output
    assert "Traceback" not in result.output


def test_cli_help_mentions_the_token_permission():
    result = CliRunner().invoke(main, ["check-embeddings", "--help"])
    assert result.exit_code == 0
    assert "Workers AI" in result.output and "Read" in result.output
