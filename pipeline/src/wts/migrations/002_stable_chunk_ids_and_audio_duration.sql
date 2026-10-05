-- Duration of the file we actually downloaded (ffprobe), which can differ from the feed's
-- itunes:duration when ads are inserted. Used for transcript timing checks.
ALTER TABLE episodes ADD COLUMN audio_duration_s REAL;

-- AUTOINCREMENT so a deleted chunk's id is never handed out again for different text
-- (chunk ids become Vectorize ids and are referenced by listener reports).
CREATE TABLE chunks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    word_times TEXT NOT NULL,
    is_boilerplate INTEGER NOT NULL DEFAULT 0,
    UNIQUE (episode_id, seq)
);
INSERT INTO chunks_new SELECT id, episode_id, seq, start_ms, end_ms, text, word_times,
    is_boilerplate FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
