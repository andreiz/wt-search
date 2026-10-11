// The footer (spec §5.7; design README "Footer"; Screen.dc.html): the unofficial line, links to
// the show, and the note about search logs. "Send feedback" is shown once it has a form to open
// (Task 13).

/** Spec §10 item 1 is still open (the hosts have not been asked): the phrase lives here only. */
export const BLESSING = "made with the hosts' blessing";

/** The show's own pages. These are the show's hosts, not ours, so they are fixed here. */
export const SHOW_LINKS = [
  { label: "Wood Talk on YouTube", href: "https://www.youtube.com/@WoodTalk" },
  { label: "Podcast", href: "https://shows.acast.com/woodtalk" },
  { label: "Website", href: "https://www.woodtalkshow.com/" },
] as const;

export function Footer({ onFeedback }: { onFeedback?: () => void }) {
  return (
    <footer class="site-footer">
      <div class="column site-footer__inner">
        <p class="site-footer__line">
          <strong>Unofficial</strong> · {BLESSING}
        </p>
        <nav class="site-footer__links" aria-label="The show">
          {SHOW_LINKS.map((link) => (
            <a key={link.href} class="site-footer__link" href={link.href} target="_blank" rel="noopener">
              {link.label}
            </a>
          ))}
          {onFeedback && (
            <button type="button" class="site-footer__link site-footer__link--button" onClick={onFeedback}>
              Send feedback
            </button>
          )}
        </nav>
        <p class="site-footer__line">Searches are logged anonymously to improve results.</p>
      </div>
    </footer>
  );
}
