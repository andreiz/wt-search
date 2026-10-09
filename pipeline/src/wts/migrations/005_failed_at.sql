-- When a step last failed (state.fail). `wts run` reports "failed this run" from this, not from
-- updated_at, which a feed refresh also bumps: an episode parked in `error` would otherwise
-- look newly failed after every refresh. Existing errors take their updated_at.
ALTER TABLE episodes ADD COLUMN failed_at TEXT;
UPDATE episodes SET failed_at = updated_at WHERE status = 'error';
