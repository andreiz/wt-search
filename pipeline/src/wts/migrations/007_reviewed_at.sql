-- When the maintainer marked an episode as reviewed in `wts review` (set by a button on the
-- page, never automatically), so `wts review --next-flagged` moves on to the next one.
ALTER TABLE episodes ADD COLUMN reviewed_at TEXT;
