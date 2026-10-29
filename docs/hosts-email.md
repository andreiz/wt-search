# For the intro email to the hosts

What to tell or ask Marc, Shannon and Matt when the maintainer contacts them before the public
launch (spec §10 item 1). Add to it as things come up; the email itself is the maintainer's to
write. Started 2026-10-28.

## Tell them

- **Sponsor reads, intros and announcements are left out of search results** (spec §3.5,
  2026-10-28), so a search finds discussion rather than a Rockler read. Nothing is removed: the
  reads stay in the transcript view, marked "Intro, sponsor or announcement", `include:ads`
  searches them, and every play link opens the real episode on YouTube or the podcast, reads and
  all. Offer to change the label or the behaviour if they'd rather.
- **The transcripts are machine-made** (Whisper), with misheard names and terms fixed by hand as
  they're reported (`pipeline/corrections.yaml`). There is a "Report a transcript error" form.
- **Searches are logged anonymously** to improve results (the footer says so).
- **Downloads use a bot User-Agent**, so they get no inserted ads and don't count as listener
  downloads in their stats (likely: hosts usually filter bots; spec §3.2, §10 item 4). Check
  they're fine with that.

## Ask them

- Whether they're happy for **full transcripts to be public**: search and the transcript view
  together could be paged through to copy them (spec §6 item 7). If not: tighter limits on
  `/api/context`.
- Whether the **YouTube uploads are the same edit** as the podcast audio (spec §10 item 1; the
  play links assume the same timeline, with per-platform offsets as the fallback).
- Whether they're OK with the **name**: the site is called "Wood Talk Search" and the footer says
  "made with the hosts' blessing", which isn't true until they say yes.
- **Where the site should live.** The introduction links the staging site on its `workers.dev`
  address (maintainer, 2026-10-29). Options to discuss: a Wood Talk–named domain
  (woodtalksearch.com, woodtalk.fm and others looked unregistered on 2026-10-29), which could be
  theirs to own; a subdomain of woodtalkshow.com (its DNS is at Hover, so it would need their
  help); or a subdomain of the maintainer's 10fathoms.org (its DNS would first move to
  Cloudflare). Whichever it is, its DNS has to be on Cloudflare (plan Task 17).
- Whether the **code repository can be public**: its test fixtures hold transcript excerpts (the
  first 15 minutes of a few episodes; plan `2026-10-05-m1-pipeline-core.md` Task 14 note).
