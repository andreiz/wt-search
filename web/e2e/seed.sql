-- The smoke test's corpus (web/e2e/smoke.spec.ts): three episodes and nineteen chunks, written
-- through the real tables the way `wts publish` and worker/test/seed.ts do, so the FTS triggers
-- in schema/0001_init.sql and 0003_title_search.sql fill chunks_fts and episodes_fts. Run after
-- `wrangler d1 migrations apply`, on an empty database (ids are fixed).
--
-- "glue" is in all three episodes, so a search has hits in more than one episode and sorting by
-- date reorders them. Episode 3 has two glue chunks in a row (one hit, with a nearby match
-- folded under it). Every chunk has neighbours, so More transcript has something to show.
-- Chunks are 30 s apart from 10:00 in, so the lead-in cue is not clamped to 0. word_times is
-- 400 ms per word (worker/test/seed.ts wordTimes).

-- Episode 1 has every platform and a feed link to the show's own site (its "Show notes"); 2 has
-- YouTube and a feed link that is the Acast page (so no notes); 3 has the two audio platforms and
-- no feed link. Every episode's show page link is its Acast page, built from the guid.
-- Apple and Spotify carry an offset (the ad gap), YouTube none.
INSERT INTO episodes (id, guid, number, title, published_at, year, duration_s, page_url,
                      youtube_video_id, apple_episode_id, spotify_episode_id,
                      offset_youtube_s, offset_apple_s, offset_spotify_s)
VALUES
  (1, 'e2e-guid-001', 101, 'Hide Glue and Hot Pots', '2018-03-01T08:00:00Z', 2018, 3600,
   'https://example.com/episodes/101', 'yt101', '1000000101', 'sp101ABC', 0, 25, 30),
  (2, 'e2e-guid-002', 202, 'The Workbench Top Episode', '2020-06-15T08:00:00Z', 2020, 4200,
   'https://shows.acast.com/wood-talk/episodes/202', 'yt202', NULL, NULL, 0, 0, 0),
  (3, 'e2e-guid-003', 303, 'Squeeze Out and Scrapers', '2022-09-10T08:00:00Z', 2022, 3900,
   NULL, NULL, '1000000303', 'sp303XYZ', 0, 20, 20);

INSERT INTO chunks (id, episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate)
VALUES
  (101, 1, 0, 600000, 630000, 'Welcome to the show, today we start with a long argument about hide glue and hot pots.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (102, 1, 1, 630000, 660000, 'Everyone has a favorite glue, but nobody agrees on open time or clamp pressure.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (103, 1, 2, 660000, 690000, 'Then a tangent about router tables and dust collection in a small garage shop.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (104, 1, 3, 690000, 720000, 'Later we answer listener mail about sharpening chisels on waterstones and diamond plates.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (105, 1, 4, 720000, 750000, 'Finally we talk about finishing, shellac, and why the can always lies about drying time.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (106, 1, 5, 750000, 780000, 'Before we go, a reminder that dovetails are not a personality, no matter what the internet says.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),

  (201, 2, 0, 600000, 630000, 'Our next topic is the workbench top, and how to flatten one with a jack plane and winding sticks.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (202, 2, 1, 630000, 660000, 'Some people prefer a router sled, but the noise and the dust are a lot to take.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (203, 2, 2, 660000, 690000, 'This week we compare PVA glue and polyurethane glue for outdoor furniture and cutting boards.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (204, 2, 3, 690000, 720000, 'The consensus is that PVA is fine indoors, but outdoors you want something waterproof like epoxy.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (205, 2, 4, 720000, 750000, 'Then we spend a while on bandsaw tuning, blade tension, and why your resaw drifts.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (206, 2, 5, 750000, 780000, 'Next up is the HVLP sprayer our friend bought, and whether lacquer is worth the trouble.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),

  (301, 3, 0, 600000, 630000, 'A listener asks about wood movement in tabletops and how much room the breadboard ends need.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (302, 3, 1, 630000, 660000, 'We close with shop tours, clamp storage, and a long sigh about the price of walnut lumber.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (303, 3, 2, 660000, 690000, 'Glue squeeze out is the topic here, and whether to wipe it wet or scrape it once it gels.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (304, 3, 3, 690000, 720000, 'A scraper beats sandpaper here because sanding pushes glue into the pores and it blotches under stain.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (305, 3, 4, 720000, 750000, 'Moving on, the guys debate hand planes, specifically the number four and whether a number five beats it.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (306, 3, 5, 750000, 780000, 'Someone wrote in about tear out on curly maple, and the answer is a sharp iron and a tight mouth.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0),
  (307, 3, 6, 780000, 810000, 'Last, we talk about turning, bowl gouges, and green wood that warps while it dries on the shelf.',
   '0,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400,400', 0);

-- What a publish leaves in meta: a corpus version past the migration's '0' (it is part of the
-- Worker's cache key), and the time of the publish.
UPDATE meta SET value = '1' WHERE key = 'corpus_version';
INSERT INTO meta (key, value) VALUES ('last_published_at', '2026-10-01T12:00:00Z');
