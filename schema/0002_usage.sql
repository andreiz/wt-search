-- The daily smart-search budget (spec §4.8 item 2), written by the Worker only: one row per
-- UTC day. `smart` counts uncached smart searches; the alerted_* flags record which ntfy
-- alerts (half the budget, past it) went out that day, so each is sent once.
CREATE TABLE usage (
    day TEXT PRIMARY KEY,                   -- UTC date, YYYY-MM-DD
    smart INTEGER NOT NULL DEFAULT 0,
    alerted_half INTEGER NOT NULL DEFAULT 0,
    alerted_full INTEGER NOT NULL DEFAULT 0
);
