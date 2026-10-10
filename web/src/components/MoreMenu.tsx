// The ⋯ menu of a hit row (DenseResult.dc.html; spec §5.3): on a phone the platforms the row
// does not show, then More transcript, Episode page (a link, with "jump to mm:ss" because the
// page has no player) and Report transcript error. A menu button with arrow-key movement: Esc,
// a press outside or Tab closes it, and Esc or a choice returns focus to ⋯ (SortMenu.tsx works
// the same way).
import { useEffect, useRef, useState } from "preact/hooks";
import type { Platform } from "../lib/platforms";
import { playName } from "../lib/platforms";

const ITEMS = "[role='menuitem']";

export function MoreMenu({
  extra,
  pageHref,
  time,
  onMore,
  onReport,
}: {
  /** Phone only: the platforms the row does not show as pills. */
  extra: Platform[];
  /** The Wood Talk page link from the API, when the episode has one. */
  pageHref: string | undefined;
  /** The hit's time, "1:09:51". */
  time: string;
  onMore: () => void;
  onReport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

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
          {extra.map((platform) => (
            <a
              key={platform.key}
              role="menuitem"
              class="menu-item"
              tabIndex={-1}
              href={platform.href}
              target="_blank"
              rel="noopener"
              aria-label={playName(platform, time, "menu")}
              onClick={close}
            >
              Play on {platform.name}
              <span class="menu-item__sub">at {time} · may start early (ads)</span>
            </a>
          ))}
          {extra.length > 0 && <div class="menu-rule" role="separator" />}
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            tabIndex={-1}
            onClick={() => {
              close();
              onMore();
            }}
          >
            More transcript
          </button>
          {pageHref && (
            <a
              role="menuitem"
              class="menu-item"
              tabIndex={-1}
              href={pageHref}
              target="_blank"
              rel="noopener"
              aria-label={`Episode page, jump to ${time}`}
              onClick={close}
            >
              Episode page
              <span class="menu-item__sub">jump to {time}</span>
            </a>
          )}
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
