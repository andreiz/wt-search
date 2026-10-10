// The ⋯ menu of a hit row (spec §5.3), the same at every width: the links the chip does not play
// (Show page, Apple, Spotify), then More transcript and Report transcript error. A menu button
// with arrow-key movement: Esc, a press outside or Tab closes it, and Esc or a choice returns
// focus to ⋯ (SortMenu.tsx works the same way).
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PlayLink } from "../lib/platforms";
import { menuName } from "../lib/platforms";

const ITEMS = "[role='menuitem']";

export function MoreMenu({
  plays,
  time,
  moreOpen,
  buttonRef,
  onMore,
  onReport,
}: {
  /** The links the chip does not play, in menu order (`menuPlays`). */
  plays: PlayLink[];
  /** The hit's time, "1:09:51". */
  time: string;
  /** Whether the More transcript view is open: "More transcript" then reads as expanded, and closes it. */
  moreOpen: boolean;
  /** The ⋯ button, for the row to return focus to when the view it opened collapses. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  onMore: () => void;
  onReport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = buttonRef;

  // On opening, focus the first item; a press outside closes the menu.
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const away = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = [...(root.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (at + 1) % items.length;
        break;
      case "ArrowUp":
        next = (at - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div class="more-menu" ref={root}>
      <button
        type="button"
        class="more-menu__button"
        ref={button}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
        onKeyDown={onButtonKeyDown}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div class="more-menu__list" role="menu" aria-label="Actions" onKeyDown={onMenuKeyDown}>
          {plays.map((play) => (
            <a
              key={play.key}
              role="menuitem"
              class="menu-item"
              tabIndex={-1}
              href={play.href}
              target="_blank"
              rel="noopener"
              aria-label={menuName(play, time)}
              onClick={close}
            >
              {play.key === "page" ? "Show page" : `Play on ${play.name}`}
              <span class="menu-item__sub">
                {play.key === "page"
                  ? `plays from ${time}, may play an ad first`
                  : `at ${time} · may start minutes early`}
              </span>
            </a>
          ))}
          {plays.length > 0 && <div class="menu-rule" role="separator" />}
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            tabIndex={-1}
            aria-expanded={moreOpen ? "true" : "false"}
            onClick={() => {
              close();
              onMore();
            }}
          >
            More transcript
          </button>
          <div class="menu-rule" role="separator" />
          <button
            type="button"
            role="menuitem"
            class="menu-item menu-item--quiet"
            tabIndex={-1}
            onClick={() => {
              close();
              onReport();
            }}
          >
            Report transcript error
          </button>
        </div>
      )}
    </div>
  );
}
