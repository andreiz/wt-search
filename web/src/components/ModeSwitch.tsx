// The Smart / Exact segmented control (SearchHeader.dc.html; spec §5.2): a radio group with a
// one-line tooltip each. Only the selected radio is in the tab order; the arrows move the choice.
import { useRef } from "preact/hooks";
import type { Mode } from "../lib/url";

const OPTIONS: { mode: Mode; label: string; tip: string }[] = [
  { mode: "smart", label: "Smart", tip: "Matches meaning as well as words" },
  { mode: "exact", label: "Exact", tip: "Exact keywords only, with counts" },
];

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const group = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
    if (!next) return;
    onChange(next.mode);
    group.current?.querySelectorAll<HTMLElement>("[role='radio']")[OPTIONS.indexOf(next)]?.focus();
  }

  return (
    <div class="mode-switch" role="radiogroup" aria-label="Search mode" ref={group}>
      {OPTIONS.map((option, index) => {
        const selected = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            class="mode-switch__option"
            aria-checked={selected ? "true" : "false"}
            tabIndex={selected ? 0 : -1}
            title={option.tip}
            onClick={() => {
              if (!selected) onChange(option.mode);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
