-- Platform IDs matched by `wts feed` (spec §3.2, §4.6). youtube_duration_s is the matched
-- video's length; the 3 s length rule is applied when publishing, so the match stays here for
-- the review tool even when D1 gets no YouTube link.
ALTER TABLE episodes ADD COLUMN apple_episode_id TEXT;
ALTER TABLE episodes ADD COLUMN spotify_episode_id TEXT;
ALTER TABLE episodes ADD COLUMN youtube_video_id TEXT;
ALTER TABLE episodes ADD COLUMN youtube_duration_s INTEGER;
ALTER TABLE episodes ADD COLUMN offset_apple_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN offset_spotify_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN offset_youtube_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN platforms_checked_at TEXT;

-- What each environment has (plan 2, decision 1). An episode's row is written only after
-- every call of its publish succeeded; digest decides whether it is due again.
CREATE TABLE publications (
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    env TEXT NOT NULL,
    digest TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (episode_id, env)
);

-- Vector ids sent to each environment's Vectorize index, so ids of removed chunks can be
-- deleted there after a re-chunk.
CREATE TABLE published_vectors (
    env TEXT NOT NULL,
    chunk_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    PRIMARY KEY (env, chunk_id)
);
CREATE INDEX published_vectors_episode ON published_vectors (env, episode_id);
