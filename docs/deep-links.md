# Deep links

Which time-parameter formats actually open each platform at a given time (spec §4.6,
§10 item 2). Checked by hand, because none of the platforms documents this.

`worker/src/links.ts` builds every link, and every one carries the cue time. YouTube uses
`&t=<s>s`. Spotify and Apple use what their own share sheets make when sharing from the
current time (2026-10-07):

- Spotify: `https://open.spotify.com/episode/<id>?si=…&utm_source=copy-link&t=1057`. The
  Worker sends `…/episode/<id>?t=<s>`, without the tracking parameters.
- Apple: `https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=<id>&t=1160`.
  The Worker uses exactly this form (US storefront and the show's slug included), replacing
  the bare `…/podcast/id251471480?i=<id>` it used before, which was never checked.

On Apple Podcasts and Spotify a link lands early, whatever the format: ads are inserted at
play time into a pre-roll slot and, on many episodes, one or two mid-roll slots, each 0–4
minutes and different on every listen (spec §4.6). Our times are on the show's own
timeline, so the link is early by the ads before that point, never late. The card shows the
time as text for this reason. When checking a format, judge it by whether the player seeks
at all, not by landing on the exact word.

- Show page: Acast's episode page takes `?seek=<s>`, e.g.
  `https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616?seek=1734`. The time
  is the cue on the show's own timeline (lead-in, no platform offset). Tried on WT616 on
  2026-10-09 in a desktop browser: the page's player starts at the time. An ad may play first.
  Since 2026-10-11 the Worker (`pageLink`) and `wts links` build the page's address from the
  episode's feed guid, not from the feed's link:
  `https://shows.acast.com/woodtalk/episodes/<guid, URL-encoded>?seek=<s>`, e.g.
  `…/episodes/6968079fe9172b83203dbacf?seek=600` (597) and
  `…/episodes/http%3A%2F%2Farchive.org%2Fdownload%2Fwt089%2FWT_071.mp3?seek=4184` (71, whose
  guid is its first host's audio URL). The feed links to the Acast page for only the 47 newest
  of 626 episodes; the rest link to `woodtalkshow.com`, which cannot seek. That link is now the
  card's "Show notes" (`links.notes`), with no time.

The Apple link names the US storefront (`/us/`), as the share sheet did. Listeners in other
countries should be redirected to their own store; worth a look if one reports otherwise.

**2026-10-07, Checkpoint F:** the maintainer opened YouTube and Spotify links from
`wts search` on staging, on desktop; both started at the cue. Then on the phone (iOS
assumed: the Apple Podcasts app): YouTube precise; Apple early; Spotify sometimes 30–60 s
early. That is the play-time ad gap above, varying per listen, so no fixed offset can
correct it without sometimes landing late. YouTube's precision also confirms our cue
times on the show's own timeline.

| Platform | Device | Format | Result |
| --- | --- | --- | --- |
| YouTube | iOS app | `&t=<s>s` (what the Worker uses) | works, precise (2026-10-07); not for a second moment in a video the app already has open (below, 2026-10-29) |
| YouTube | Android app | `&t=<s>s` (what the Worker uses) | not checked |
| YouTube | Desktop web | `&t=<s>s` (what the Worker uses) | works (2026-10-07) |
| Apple Podcasts | iOS app | `&t=<s>` (what the Worker uses; the app's own share format) | works, lands early (play-time ads; 2026-10-07); opens the app's transcript at the passage, ▶ to play; a second moment in the same episode works (2026-10-29) |
| Apple Podcasts | Android (web) | `&t=<s>` (what the Worker uses) | not checked |
| Apple Podcasts | Desktop web / Mac app | `&t=<s>` (what the Worker uses) | not checked |
| Spotify | iOS app | `?t=<s>` (what the Worker uses; the app's own share format) | works, sometimes 30–60 s early (play-time ads; 2026-10-07); a second moment in the same episode works (2026-10-29) |
| Spotify | Android app | `?t=<s>` (what the Worker uses) | not checked |
| Spotify | Desktop web | `?t=<s>` (what the Worker uses) | works (2026-10-07) |
| Show page (Acast) | Desktop web | `?seek=<s>` (what the Worker uses) | works; an ad may play first (WT616, 2026-10-09) |
| Show page (Acast, by guid) | iOS Safari and desktop web | `/episodes/<guid, URL-encoded>?seek=<s>` (what the Worker uses since 2026-10-11) | works (episodes 71 and 597, maintainer, 2026-10-11) |

**2026-10-29, Checkpoint H (iPhone, maintainer):** with the YouTube app already showing an
episode, a link to another moment in **the same video** only brings the app forward, paused,
without seeking. A link into a different episode seeks correctly. Tried on ep617
(`9bIin0tVcj0`) at 2:00 then 10:00, force-quitting the app between formats, with four formats:
`watch?v=…&t=<s>s` (current), `youtu.be/…?t=<s>`, `&t=<s>s` plus a random extra parameter per
tap, and `&start=<s>`. None seeked. The app makes this decision, so no link format can fix
it, and a web page can't make iOS open a YouTube link in Safari instead of the app. Known
limitation for launch. The fix would be an embedded player on the site (backlog §7).
The same test on Apple Podcasts and Spotify (ep617 2:00 then 10:00, then ep616 5:00): both
move to the second moment. Spotify plays from it. Apple Podcasts opens its own transcript
of the episode scrolled to that passage, with a ▶ beside it, and doesn't start playing: the
mini-player at the bottom keeps showing what played before, even another episode. Tapping
the ▶ plays from the passage. That extra tap is the app's choice; no link can skip it.
