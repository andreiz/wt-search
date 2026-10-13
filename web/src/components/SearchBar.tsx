// The search row (SearchHeader.dc.html; spec §5.2): the input with its icon, `/` hint and clear
// button, and the Search button. It searches only on submit (Enter or the button), never on typing.
import type { Ref } from "preact";
import { useRef } from "preact/hooks";
import { count } from "../lib/format";

/** The Worker cuts queries at 200 code points (worker/src/query.ts MAX_QUERY_CHARS). */
export const MAX_QUERY_LENGTH = 200;

/** "Phone" is below 600 px (design README "Layout"). */
function isPhone(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 599.98px)").matches;
}

/** A finger, not a mouse: the device brings up a keyboard on screen. */
function isTouch(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export interface SearchBarProps {
  value: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  inputRef?: Ref<HTMLInputElement>;
  /** The Search button is off (while the rate limit's countdown runs); typing still works. */
  disabled?: boolean;
  /**
   * How many episodes are indexed, for the placeholder ("Search 625 episodes"). Known only once
   * /api/info has answered, which the empty state asks for; until then, and if it fails, the
   * placeholder says "the episodes". The design's mock has the number written in.
   */
  episodes?: number | null;
}

export function SearchBar({ value, onInput, onSubmit, inputRef, disabled = false, episodes }: SearchBarProps) {
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;

  return (
    <form
      class="search-row"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        // A phone's keyboard stays up over the results while the box has focus, also after a tap
        // on Search (Safari keeps the focus where it was). With a mouse the focus stays: the
        // next thing typed is usually a changed query.
        if (isTouch() && "current" in input) input.current?.blur();
        onSubmit();
      }}
    >
      <div class="search-field">
        <svg class="search-field__icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M13 13l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input
          ref={input}
          class="search-field__input"
          type="text"
          name="q"
          aria-label="Search the transcripts"
          placeholder={`Search ${episodes ? `${count(episodes, false)} episodes` : "the episodes"}${isPhone() ? "" : " — tools, joinery, finishes…"}`}
          maxLength={MAX_QUERY_LENGTH}
          value={value}
          onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          enterkeyhint="search"
        />
        {value === "" ? (
          <kbd class="search-field__hint" aria-hidden="true">
            /
          </kbd>
        ) : (
          <button
            type="button"
            class="search-field__clear"
            aria-label="Clear search"
            onClick={() => {
              onInput("");
              (input as { current: HTMLInputElement | null }).current?.focus();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        )}
      </div>
      <button type="submit" class="search-row__button" disabled={disabled}>
        Search
      </button>
    </form>
  );
}
