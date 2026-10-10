// The related-passages fold (Screen.dc.html; spec §5.3): after the keyword cards, one dashed
// button "Show N related passages"; opened, a heading with Hide above the related cards. Focus
// follows the toggle: opening lands on Hide, hiding returns to the Show button.
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

const SUB = "Matched on meaning, not the exact words";

export function RelatedFold({
  count,
  open,
  onToggle,
  children,
}: {
  /** How many related passages (hits) are folded. */
  count: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The related cards; shown only while open. */
  children: ComponentChildren;
}) {
  const show = useRef<HTMLButtonElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);

  useEffect(() => {
    if (!toggled.current) return;
    (open ? hide : show).current?.focus();
  }, [open]);

  function toggle(next: boolean) {
    toggled.current = true;
    onToggle(next);
  }

  if (!open) {
    return (
      <button type="button" class="fold" ref={show} aria-expanded="false" onClick={() => toggle(true)}>
        <span class="fold__text">
          <span class="fold__title">{`Show ${count} related ${count === 1 ? "passage" : "passages"}`}</span>{" "}
          <span class="fold__sub">{SUB}</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true" class="fold__chevron">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    );
  }
  return (
    <section class="fold-open">
      <div class="fold-open__head">
        <span class="fold__text">
          <span class="fold__title">Related passages</span> <span class="fold__sub">{SUB}</span>
        </span>
        <button type="button" class="fold-open__hide" ref={hide} aria-expanded="true" onClick={() => toggle(false)}>
          Hide
        </button>
      </div>
      {children}
    </section>
  );
}
