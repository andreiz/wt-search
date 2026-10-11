// What the dialogs of the controls row share (the year range and the syntax help; the sort menu
// has its own, for a menu's arrow keys): open or closed, a press outside closes, Esc closes and
// returns focus to the button, and Tab off either end of the dialog closes it.
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const FOCUSABLE = "select, button, input, [tabindex]:not([tabindex='-1'])";

export function usePopover(returnTo: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  /** The element holding the button and the dialog: a press inside it is not "outside". */
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  /** Close; focus goes back to the button unless it is going somewhere else. */
  function close(refocus = true) {
    setOpen(false);
    if (refocus) returnTo.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      // Closing is all this Esc does: not the phone controls behind it, not the page.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = root.current?.querySelector<HTMLElement>("[role='dialog']");
    if (!dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const target = event.target as HTMLElement;
    // Leaving backwards from the first control (or the dialog itself) lands on the button, and
    // forwards from the last on the next control after the dialog: either way the dialog is done.
    const leaving = event.shiftKey ? target === items[0] || target === dialog : target === items.at(-1);
    if (leaving) close(false);
  }

  return { open, setOpen, root, close, onKeyDown };
}
