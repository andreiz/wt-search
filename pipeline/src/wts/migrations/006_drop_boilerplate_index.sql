-- The MinHash/LSH boilerplate index is gone (detection is shelved until the full corpus is
-- available), so its fingerprint tables only take up space. `chunks.is_boilerplate` stays: the
-- embed and publish steps still honour it. Dropping a table drops its indexes.
DROP TABLE IF EXISTS bp_bands;
DROP TABLE IF EXISTS bp_sentences;
