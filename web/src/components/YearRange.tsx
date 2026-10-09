// The year range chip (SearchHeader.dc.html; spec §5.2): "Any year", or the range as "2015–2020 ×".
// The chip opens a dialog with From and To selects (real `<select>`s, so phones get their pickers)
// and Apply; "Any year" in the dialog and × clear it. The range itself lives in the query text
// (lib/years.ts): this component only shows it and reports what was chosen.
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { usePopover } from "../lib/use-popover";
import { rangeLabel, START_YEAR, type YearRange as Range } from "../lib/years";

export interface YearRangeProps {
  /** The searched query's range, or null. */
  range: Range | null;
  /** The last year of the pickers. */
  thisYear: number;
  onApply: (from: number, to: number) => void;
  onClear: () => void;
}

/** A `<select>` of years. The value is set after the options exist: set before them it is lost. */
function YearSelect({ id, years, value, onChange }: { id: string; years: number[]; value: number; onChange: (year: number) => void }) {
  const select = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => {
    if (select.current) select.current.value = String(value);
  });
  return (
    <select id={id} class="year-field__select" ref={select} onChange={(e) => onChange(Number(e.currentTarget.value))}>
      {years.map((year) => (
        <option key={year} value={year}>
          {year}
        </option>
      ))}
    </select>
  );
}

export function YearRange({ range, thisYear, onApply, onClear }: YearRangeProps) {
  const chip = useRef<HTMLButtonElement>(null);
  const { open, setOpen, root, close, onKeyDown } = usePopover(chip);
  const [from, setFrom] = useState(START_YEAR);
  const [to, setTo] = useState(thisYear);
  const fromId = useId();
  const toId = useId();
  const dialogId = useId();

  const clamp = (year: number) => Math.min(Math.max(year, START_YEAR), thisYear);
  const years = Array.from({ length: Math.max(thisYear - START_YEAR + 1, 0) }, (_, i) => START_YEAR + i);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Each opening starts from the range the chip shows.
    setFrom(clamp(range?.from ?? START_YEAR));
    setTo(clamp(range?.to ?? thisYear));
    setOpen(true);
  }

  // Opening puts focus on From (a layout effect, so a quick Esc cannot land before it).
  useLayoutEffect(() => {
    if (open) document.getElementById(fromId)?.focus();
  }, [open, fromId]);

  return (
    <div class="year-range" ref={root} onKeyDown={onKeyDown}>
      <span class={`year-chip${range ? " year-chip--set" : ""}`}>
        <button
          type="button"
          class="year-chip__main"
          ref={chip}
          aria-label={`Year range: ${rangeLabel(range)}`}
          aria-haspopup="dialog"
          aria-controls={dialogId}
          aria-expanded={open ? "true" : "false"}
          onClick={toggle}
        >
          {rangeLabel(range)}
        </button>
        {range && (
          <button
            type="button"
            class="year-chip__clear"
            aria-label="Clear years"
            onClick={() => {
              setOpen(false);
              chip.current?.focus();
              onClear();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </span>
      {open && (
        // tabIndex -1: a click on the dialog's padding lands focus here, so Esc is still heard.
        <div class="popover year-range__dialog" id={dialogId} role="dialog" aria-label="Year range" tabIndex={-1}>
          <strong class="popover__title">Years</strong>
          <div class="year-range__fields">
            <div class="year-field">
              <label for={fromId}>From</label>
              <YearSelect id={fromId} years={years} value={from} onChange={setFrom} />
            </div>
            <span class="year-range__dash" aria-hidden="true">
              –
            </span>
            <div class="year-field">
              <label for={toId}>To</label>
              <YearSelect id={toId} years={years} value={to} onChange={setTo} />
            </div>
          </div>
          <div class="year-range__actions">
            <button
              type="button"
              class="popover__ghost"
              aria-label="Any year: clear range"
              onClick={() => {
                close();
                onClear();
              }}
            >
              Any year
            </button>
            <button
              type="button"
              class="popover__apply"
              onClick={() => {
                close();
                onApply(from, to);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
