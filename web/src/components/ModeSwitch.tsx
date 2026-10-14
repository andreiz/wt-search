// The Exact / Related (beta) segmented control (SearchHeader.dc.html; spec §5.2): a radio group
// with a one-line tooltip each. Related is the internal mode "related". Only the selected radio is
// in the tab order; the arrows move the choice.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import type { Mode } from "../lib/url";
import { BetaTag } from "./BetaTag";

const OPTIONS: { mode: Mode; label: ComponentChildren; name: string; tip: string }[] = [
  { mode: "exact", label: "Exact", name: "Exact", tip: "Passages that contain your words, with a count" },
  {
    mode: "related",
    label: (
      <>
        Related <BetaTag />
      </>
    ),
    name: "Related, beta",
    tip: "Passages about the same thing that don't contain all your words. Still rough.",
  },
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
            aria-label={option.name}
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
