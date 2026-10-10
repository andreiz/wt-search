-- Title search (spec §4.4, "Title hits"): an FTS5 index over episodes.title, tokenized like
-- chunks_fts, so a word that is only in a title ("Kregger") finds its episode. External
-- content, kept in sync by triggers; as with chunks_fts, the delete and update triggers pass
-- the *old* title, and writers upsert with ON CONFLICT DO UPDATE (INSERT OR REPLACE would skip
-- the delete trigger).
CREATE VIRTUAL TABLE episodes_fts USING fts5(
    title, content='episodes', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;

CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title) VALUES ('delete', old.id, old.title);
    INSERT INTO episodes_fts(rowid, title) VALUES (new.id, new.title);
END;

-- The episodes already published.
INSERT INTO episodes_fts(episodes_fts) VALUES ('rebuild');
