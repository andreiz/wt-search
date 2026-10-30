// The footer (spec §5.7; design README "Footer"; Screen.dc.html): the unofficial line, links to
// the show, and the note about search logs. With `feedback`, "Send feedback" toggles the inline
// feedback form (spec §5.5) below the links; closing it (Cancel, ×, or the button again)
// returns focus to the button.
import { useRef, useState } from "preact/hooks";
import { FeedbackForm } from "./FeedbackForm";

/** "fan-made" until the hosts agree (spec §10 item 1); then "made with the hosts' blessing". */
export const TAGLINE = "fan-made";

/** The show's own pages. These are the show's hosts, not ours, so they are fixed here. */
export const SHOW_LINKS = [
  { label: "Wood Talk on YouTube", href: "https://www.youtube.com/@WoodTalk" },
  { label: "Podcast", href: "https://shows.acast.com/woodtalk" },
  { label: "Website", href: "https://www.woodtalkshow.com/" },
] as const;

export function Footer({ feedback = false }: { feedback?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  return (
    <footer class="site-footer">
      <div class="column site-footer__inner">
        <p class="site-footer__line">
          <strong>Unofficial</strong> · {TAGLINE}
        </p>
        <nav class="site-footer__links" aria-label="The show">
          {SHOW_LINKS.map((link) => (
            <a key={link.href} class="site-footer__link" href={link.href} target="_blank" rel="noopener">
              {link.label}
            </a>
          ))}
          {feedback && (
            <button
              type="button"
              class="site-footer__link site-footer__link--button"
              ref={button}
              aria-expanded={open ? "true" : "false"}
              aria-controls={open ? "feedback-form" : undefined}
              onClick={() => (open ? close() : setOpen(true))}
            >
              Send feedback
            </button>
          )}
        </nav>
        {feedback && open && (
          <div id="feedback-form" class="site-footer__form">
            <FeedbackForm onClose={close} />
          </div>
        )}
        <p class="site-footer__line">Searches are logged anonymously to improve results.</p>
      </div>
    </footer>
  );
}
