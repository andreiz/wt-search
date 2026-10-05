# Platform API fixtures

These files are **hand-built in the shape of each API's real response, not recorded**. The
network where Task 5 was written blocked itunes.apple.com and there were no Spotify or YouTube
keys. The titles, dates and Acast guids are the real ones for episodes 610-615; the Apple track
ids, Spotify ids and YouTube video ids are made up.

At Checkpoint D (the first real `wts feed` with keys), compare them with real responses. Where
the shapes differ, replace each file with a trimmed recording (about 5 items, IDs kept) and fix
the matchers and tests to follow.

| File | Endpoint |
|---|---|
| `apple_lookup.json` | `itunes.apple.com/lookup?id=251471480&media=podcast&entity=podcastEpisode` |
| `spotify_token.json` | `POST accounts.spotify.com/api/token` |
| `spotify_episodes_page1.json`, `spotify_episodes_page2.json` | `GET api.spotify.com/v1/shows/{id}/episodes` (page 2 is `next` of page 1; page 1 holds a `null` item) |
| `youtube_channels.json` | `channels.list?part=contentDetails&forHandle=@WoodTalk` |
| `youtube_playlist_page1.json`, `youtube_playlist_page2.json` | `playlistItems.list?part=snippet&maxResults=50` (page 2 is `nextPageToken` of page 1) |
| `youtube_videos.json` | `videos.list?part=contentDetails&id=...` |
| `youtube_error_403.json` | a `quotaExceeded` error body |

The WT379 video (`PT1H4M15S`, a livestream) stands in for a livestream-era upload whose length
differs from the feed's 50:39. The 3 s length rule is applied at publish, not in matching.
