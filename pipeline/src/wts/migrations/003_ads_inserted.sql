-- 1 when every download attempt came back with ads inserted (spec §3.2): the stored copy is
-- the shortest one we got, and its timeline is offset from the show's own.
ALTER TABLE episodes ADD COLUMN ads_inserted INTEGER NOT NULL DEFAULT 0;
