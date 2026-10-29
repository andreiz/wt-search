-- Each chunked episode's distinct 8-word run hashes (boilerplate spec 2026-10-28 §5.2), written by
-- `wts chunk` from the same words it chunks, so the corpus can be counted without re-reading
-- every transcript.
CREATE TABLE run_hashes (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    hashes BLOB NOT NULL
);
