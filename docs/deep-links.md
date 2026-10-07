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
| YouTube | iOS app | `&t=<s>s` (what the Worker uses) | works, precise (2026-10-07) |
| YouTube | Android app | `&t=<s>s` (what the Worker uses) | not checked |
| YouTube | Desktop web | `&t=<s>s` (what the Worker uses) | works (2026-10-07) |
| Apple Podcasts | iOS app | `&t=<s>` (what the Worker uses; the app's own share format) | works, lands early (play-time ads; 2026-10-07) |
| Apple Podcasts | Android (web) | `&t=<s>` (what the Worker uses) | not checked |
| Apple Podcasts | Desktop web / Mac app | `&t=<s>` (what the Worker uses) | not checked |
| Spotify | iOS app | `?t=<s>` (what the Worker uses; the app's own share format) | works, sometimes 30–60 s early (play-time ads; 2026-10-07) |
| Spotify | Android app | `?t=<s>` (what the Worker uses) | not checked |
| Spotify | Desktop web | `?t=<s>` (what the Worker uses) | works (2026-10-07) |
