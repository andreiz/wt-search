CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    guid TEXT UNIQUE NOT NULL,
    number INTEGER,
    title TEXT NOT NULL,
    published_at TEXT NOT NULL,
    duration_s INTEGER,
    audio_url TEXT NOT NULL,
    page_url TEXT,
    stem TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    error_step TEXT,
    error_reason TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    in_scope INTEGER NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]',
    audio_path TEXT,
    transcript_path TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    word_times TEXT NOT NULL,
    is_boilerplate INTEGER NOT NULL DEFAULT 0,
    UNIQUE (episode_id, seq)
);

CREATE TABLE bp_sentences (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL,
    norm_text TEXT NOT NULL
);
CREATE INDEX bp_sentences_episode ON bp_sentences (episode_id);

CREATE TABLE bp_bands (
    band_key INTEGER NOT NULL,
    sentence_id INTEGER NOT NULL
);
CREATE INDEX bp_bands_key ON bp_bands (band_key);
CREATE INDEX bp_bands_sentence ON bp_bands (sentence_id);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    command TEXT,
    machine TEXT,
    started_at TEXT,
    finished_at TEXT,
    counts TEXT,
    errors INTEGER
);

CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
