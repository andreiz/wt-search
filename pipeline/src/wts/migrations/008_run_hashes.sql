-- Each chunked episode's distinct 8-word run hashes (boilerplate spec 2026-10-28 §5.2), written by
-- `wts chunk` from the same words it chunks, so the corpus can be counted without re-reading
-- every transcript.
CREATE TABLE run_hashes (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    hashes BLOB NOT NULL
);

-- The shared runs the stored chunks were last cut against (one row), so the next run re-cuts
-- only the episodes that hold a run that has since crossed the threshold either way.
CREATE TABLE shared_runs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    n INTEGER NOT NULL,
    hashes BLOB NOT NULL
);
