# Test search set

Searches with known right answers, scored against a deployed environment (spec §7.2).

- `queries.yaml`: written by hand. Add a case for every "it should have found X" moment, and
  for searches that work now (they catch a change that breaks them). The quickest way is `t` in
  `wts review`, which fills in the episode and time, and can check the search first.
- `synthetic.yaml`: written by `wts eval generate` (don't edit by hand; regenerate and review
  the diff).
- `baseline.json`: the scores a run is compared with; `wts eval run --update` replaces it.
- `reports/`: one JSON per run (not committed).

```
cd pipeline
uv run wts eval run                  # staging (run_env); exits 1 on a drop > 0.02
uv run wts eval run --only paraphrase
uv run wts eval run --update         # accept the new scores as the baseline
uv run wts eval run --param rerank=1   # a debug override on every Related request
uv run wts eval generate --model qwen2.5:7b   # needs the Ollama app running, or:
uv run wts eval generate --model qwen3.6:35b --ollama-url https://ollama.example.org
```
