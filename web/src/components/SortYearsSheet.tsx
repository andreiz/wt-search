// The phone's Sort & years bottom sheet (ROUND-2-phone.md "Sort & years sheet (phone)"; spec §5.2).
// The choices are staged: Show results and Done report sort and years together (one search, one
// history entry); Esc and a tap on the scrim close without changes. The sheet is rendered only
// while open, so each opening starts from the props. Focus starts on the checked sort, stays
// inside (Tab wraps), and the caller returns it to the button on close.
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SortOrder } from "../lib/url";
import { START_YEAR, type YearRange } from "../lib/years";
import { sortLabel } from "./SortMenu";
import { YearSelect } from "./YearRange";

const SORTS: SortOrder[] = ["relevance", "newest", "oldest"];
const FOCUSABLE = "button:not([tabindex='-1']), select";

export interface SortYearsSheetProps {
  sort: SortOrder;
  range: YearRange | null;
  /** The last year of the pickers. */
  thisYear: number;
  onApply: (sort: SortOrder, range: YearRange | null) => void;
  onClose: () => void;
}

export function SortYearsSheet({ sort, range, thisYear, onApply, onClose }: SortYearsSheetProps) {
  const clamp = (year: number) => Math.min(Math.max(year, START_YEAR), thisYear);
  const [staged, setStaged] = useState(sort);
  const [any, setAny] = useState(range === null);
  const [from, setFrom] = useState(clamp(range?.from ?? START_YEAR));
  const [to, setTo] = useState(clamp(range?.to ?? thisYear));
  const sheet = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const fromId = useId();
  const toId = useId();
  const years = Array.from({ length: Math.max(thisYear - START_YEAR + 1, 0) }, (_, i) => START_YEAR + i);

  // A layout effect, so a quick Esc cannot land before the focus is inside.
  useLayoutEffect(() => {
    group.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }, []);

  function apply() {
    onApply(staged, any ? null : { from, to });
    onClose();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // Closing is all this Esc does: not the compact header's controls behind it.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    const target = event.target as HTMLElement;
    if (event.shiftKey && (target === first || target === sheet.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && target === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function onSortKeyDown(event: KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = (index + step + SORTS.length) % SORTS.length;
    const next = SORTS[at];
    if (!next) return;
    setStaged(next);
    group.current?.querySelectorAll<HTMLElement>("[role='radio']")[at]?.focus();
  }

  return (
    <>
      <div class="sheet-scrim" onClick={onClose} />
      {/* tabIndex -1: a tap on the sheet's padding lands focus here, so Esc and Tab are still heard. */}
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={sheet} onKeyDown={onKeyDown}>
        <div class="sheet__grabber" aria-hidden="true" />
        <div class="sheet__title-row">
          <h2 class="sheet__title" id={titleId}>
            Sort &amp; years
          </h2>
          <button type="button" class="sheet__done" onClick={apply}>
            Done
          </button>
        </div>
        <div class="sheet__section">
          <span class="sheet__label">Sort</span>
          <div class="sheet__sort" role="radiogroup" aria-label="Sort" ref={group}>
            {SORTS.map((option, index) => {
              const selected = option === staged;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  class="sheet__sort-option"
                  aria-checked={selected ? "true" : "false"}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setStaged(option)}
                  onKeyDown={(event) => onSortKeyDown(event, index)}
                >
                  {sortLabel(option)}
                </button>
              );
            })}
          </div>
        </div>
        <div class="sheet__section">
          <div class="sheet__label-row">
            <span class="sheet__label">Years</span>
            <button type="button" class="sheet__any" onClick={() => setAny(true)}>
              Any year
            </button>
          </div>
          <div class="sheet__years">
            <div class="year-field">
              <label for={fromId}>From</label>
              <YearSelect
                id={fromId}
                years={years}
                value={any ? START_YEAR : from}
                onChange={(year) => {
                  setAny(false);
                  setFrom(year);
                  // Choosing From after clearing leaves To at the last year, as the selects showed.
                  if (any) setTo(thisYear);
                }}
              />
            </div>
            <div class="year-field">
              <label for={toId}>To</label>
              <YearSelect
                id={toId}
                years={years}
                value={any ? thisYear : to}
                onChange={(year) => {
                  setAny(false);
                  setTo(year);
                  if (any) setFrom(START_YEAR);
                }}
              />
            </div>
          </div>
        </div>
        <button type="button" class="sheet__apply" onClick={apply}>
          Show results
        </button>
      </div>
    </>
  );
}
