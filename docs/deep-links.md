# Deep links

Which time-parameter formats actually open each platform at a given time (spec §4.6,
§10 item 2). Checked by hand, because none of the platforms documents this.

`worker/src/links.ts` builds every link. YouTube carries a time (`&t=<s>s`) and so does
Spotify (`?t=<s>`): Spotify's own share sheet, with "share from current time" on, made
`https://open.spotify.com/episode/<id>?si=…&utm_source=copy-link&t=1057` (2026-10-07), so
the Worker uses that parameter without the tracking ones. Apple links carry no time until a
row below says a format works; then the format goes into `links.ts` and its test is changed
on purpose.

On Apple Podcasts and Spotify a link lands early, whatever the format: ads are inserted at
play time into a pre-roll slot and, on many episodes, one or two mid-roll slots, each 0–4
minutes and different on every listen (spec §4.6). Our times are on the show's own
timeline, so the link is early by the ads before that point, never late. The card shows the
time as text for this reason. When checking a format, judge it by whether the player seeks
at all, not by landing on the exact word.

The bare Apple URL, `https://podcasts.apple.com/podcast/id251471480?i=<episode id>`, has
no country or slug. Whether it opens the episode on each device is itself to be checked:
the Apple rows below cover it as well as the time.

**2026-10-07, Checkpoint F:** the maintainer opened YouTube and Spotify links from
`wts search` on staging, on desktop; both started at the cue. Phones are still to check.

| Platform | Device | Format | Result |
| --- | --- | --- | --- |
| YouTube | iOS app | `&t=<s>s` (what the Worker uses) | not checked |
| YouTube | Android app | `&t=<s>s` (what the Worker uses) | not checked |
| YouTube | Desktop web | `&t=<s>s` (what the Worker uses) | works (2026-10-07) |
| Apple Podcasts | iOS app | `&t=<s>` appended to the `?i=` URL | not checked |
| Apple Podcasts | Android app | `&t=<s>` appended to the `?i=` URL | not checked |
| Apple Podcasts | Desktop web | `&t=<s>` appended to the `?i=` URL | not checked |
| Spotify | iOS app | `?t=<s>` (what the Worker uses; the app's own share format) | not checked |
| Spotify | Android app | `?t=<s>` (what the Worker uses) | not checked |
| Spotify | Desktop web | `?t=<s>` (what the Worker uses) | works (2026-10-07) |
