// The phone's one button for sort and years (ROUND-2-phone.md §1 "Sort & years button"; spec §5.2):
// a sliders icon and the year label, a dot when the sort is not Best match, the accent style when
// a year is set. It opens the Sort & years sheet; desktop keeps the sort menu and the year chip.
import type { RefObject } from "preact";
import type { SortOrder } from "../lib/url";
import { rangeLabel, type YearRange } from "../lib/years";
import { sortLabel } from "./SortMenu";

export interface SortYearsButtonProps {
  sort: SortOrder;
  range: YearRange | null;
  open: boolean;
  onOpen: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function SortYearsButton({ sort, range, open, onOpen, buttonRef }: SortYearsButtonProps) {
  return (
    <button
      type="button"
      class={`sort-years-button${range ? " sort-years-button--set" : ""}`}
      ref={buttonRef}
      aria-haspopup="dialog"
      aria-expanded={open ? "true" : "false"}
      aria-label={`Sort and years: ${sortLabel(sort)}, ${rangeLabel(range)}`}
      onClick={onOpen}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M2 4h12M2 8h12M2 12h12" />
          <circle cx="5.5" cy="4" r="1.6" />
          <circle cx="10.5" cy="8" r="1.6" />
          <circle cx="6.5" cy="12" r="1.6" />
        </g>
      </svg>
      {rangeLabel(range)}
      {sort !== "relevance" && <span class="sort-years-button__dot" aria-hidden="true" />}
    </button>
  );
}
