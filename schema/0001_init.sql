-- D1 schema (spec §4.1): the contract between the pipeline (wts publish) and the Worker.
-- Applied to D1 by `wrangler d1 migrations apply`, and to an in-memory SQLite by the
-- pipeline's tests (pipeline/tests/test_schema_contract.py).
--
-- Ids come from the pipeline's state.db (episodes.id, and chunks.id, which is AUTOINCREMENT
-- there and never reused); D1 never assigns them. chunks.id is also the Vectorize vector id.

CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    guid TEXT UNIQUE NOT NULL,
    number INTEGER,
    title TEXT NOT NULL,
    published_at TEXT NOT NULL,
    year INTEGER NOT NULL,          -- from published_at, for year:/before:/after: filters
    duration_s INTEGER,
    audio_url TEXT,
    page_url TEXT,
    apple_episode_id TEXT,
    spotify_episode_id TEXT,
    youtube_video_id TEXT,          -- null unless the video's length matches (spec §4.6)
    offset_apple_s INTEGER NOT NULL DEFAULT 0,
    offset_spotify_s INTEGER NOT NULL DEFAULT 0,
    offset_youtube_s INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX episodes_year ON episodes (year);
CREATE INDEX episodes_number ON episodes (number);

CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id),
    seq INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    word_times TEXT NOT NULL,       -- delta-encoded word start offsets in ms (chunker.py)
    is_boilerplate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chunks_episode_seq ON chunks (episode_id, seq);

-- External-content FTS5 index over chunks.text. The triggers keep it in sync; the delete
-- and update triggers must pass the *old* values, or the index keeps stale terms.
-- Note: INSERT OR REPLACE does not fire the delete trigger (recursive_triggers is off), so
-- writers upsert with ON CONFLICT DO UPDATE instead.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Listener transcript-error reports (spec §4.4), written by the Worker.
CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    chunk_id INTEGER,
    created_at TEXT NOT NULL,
    quoted_text TEXT,
    suggested_text TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open'     -- open | resolved | rejected
);
CREATE INDEX reports_status ON reports (status);

-- corpus_version (part of the Worker's cache key), last_published_at.
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
INSERT INTO meta (key, value) VALUES ('corpus_version', '0');
