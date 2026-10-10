// Keyboard shortcuts (spec §5.7): `/` focuses the search box; ArrowDown/ArrowUp and j/k move
// focus between result cards. Esc belongs to the popovers and forms themselves.
//
// `handleKeydown` returns whether it acted; it calls `preventDefault` only when it did, so a
// key typed in a field, or an arrow that should scroll the page, is left alone.

export interface KeyTargets {
  /** The search box. */
  input: HTMLElement | null;
  /** The results list; its cards carry `data-result`. */
  list: HTMLElement | null;
}

const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Whether a key pressed on this element is text the person is typing (or a choice they are making). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return FIELDS.has(target.tagName) || target.isContentEditable || target.contentEditable === "true";
}

function cards(list: HTMLElement | null): HTMLElement[] {
  return list ? [...list.querySelectorAll<HTMLElement>("[data-result]")] : [];
}

/** Move focus one card on from the focused one (`step` 1 or -1), stopping at the ends. */
function move(list: HTMLElement | null, step: 1 | -1, fromOutside: "first" | "none"): boolean {
  const all = cards(list);
  if (all.length === 0) return false;
  const active = document.activeElement;
  const current = all.findIndex((card) => card === active || card.contains(active));
  let next: number;
  if (current === -1) {
    if (fromOutside === "none" || step === -1) return false;
    next = 0;
  } else {
    next = Math.min(Math.max(current + step, 0), all.length - 1);
  }
  all[next]?.focus();
  return true;
}

export function handleKeydown(event: KeyboardEvent, targets: KeyTargets): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  if (isTypingTarget(target)) return false;
  // Popovers and menus own their keys.
  if (target instanceof Element && target.closest("[role='menu'], [role='dialog']")) return false;
  // Inside an open transcript the arrows scroll the paragraphs; j and k still change card.
  if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    target instanceof Element &&
    target.closest("[data-transcript]")
  ) {
    return false;
  }

  let acted = false;
  switch (event.key) {
    case "/":
      if (targets.input) {
        targets.input.focus();
        acted = true;
      }
      break;
    case "j":
      acted = move(targets.list, 1, "first");
      break;
    case "k":
      acted = move(targets.list, -1, "none");
      break;
    // The arrows act only from inside the list: elsewhere they scroll the page.
    case "ArrowDown":
      acted = move(targets.list, 1, "none");
      break;
    case "ArrowUp":
      acted = move(targets.list, -1, "none");
      break;
  }
  if (acted) event.preventDefault();
  return acted;
}
