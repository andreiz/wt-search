// The sort menu (SearchHeader.dc.html; spec §5.2): a menu button and a 180 px menu of three
// radio items. Esc or a click elsewhere closes it; choosing closes it and returns focus to the button.
import { useEffect, useRef, useState } from "preact/hooks";
import type { SortOrder } from "../lib/url";

const OPTIONS: { sort: SortOrder; label: string }[] = [
  { sort: "relevance", label: "Relevance" },
  { sort: "newest", label: "Newest" },
  { sort: "oldest", label: "Oldest" },
];

export function sortLabel(sort: SortOrder): string {
  return OPTIONS.find((o) => o.sort === sort)?.label ?? "Relevance";
}

export function SortMenu({ sort, onChange }: { sort: SortOrder; onChange: (sort: SortOrder) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // On opening, focus the current option; a press outside closes the menu.
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
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

  function onKeyDown(event: KeyboardEvent) {
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
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  return (
    <div class="sort-menu" ref={root}>
      <button
        type="button"
        class="sort-menu__button"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        aria-label={`Sort: ${sortLabel(sort)}`}
        onClick={() => setOpen(!open)}
      >
        {sortLabel(sort)}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      {open && (
        <div class="sort-menu__list" role="menu" aria-label="Sort by" onKeyDown={onKeyDown}>
          {OPTIONS.map((option) => {
            const selected = option.sort === sort;
            return (
              <button
                key={option.sort}
                type="button"
                role="menuitemradio"
                class="sort-menu__item"
                aria-checked={selected ? "true" : "false"}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  close();
                  if (!selected) onChange(option.sort);
                }}
              >
                {option.label}
                <span class="sort-menu__check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
