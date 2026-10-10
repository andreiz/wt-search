// The page (spec §5.1, §5.2, §5.6, §5.7; design: Screen.dc.html, SearchHeader.dc.html): the
// header with the search bar and controls, `<main>` with the summary, results and pager, and the
// footer. The whole state is in the URL (use-search.ts); this file wires it to the components.
//
// The year range is not state: it is the `year:` tokens of the query (lib/years.ts), so the chip
// reads the searched query and Apply and × rewrite the text in the box and search it.
//
// Not here yet: the real footer (Task 13), the notices, empty and error states (Task 11). The
// result cards are ResultList's, and More transcript and "+N nearby" are theirs too (Task 10);
// Report (Task 13) is not wired, so that control does nothing yet. "Search this episode" puts
// `ep:N` into the searched query and searches, like the year chip.
import { useEffect, useRef, useState } from "preact/hooks";
import { ModeSwitch } from "./components/ModeSwitch";
import { Pagination } from "./components/Pagination";
import { ResultList } from "./components/ResultList";
import { SearchBar } from "./components/SearchBar";
import { Skeleton } from "./components/Skeleton";
import { SortMenu, sortLabel } from "./components/SortMenu";
import { Summary } from "./components/Summary";
import { SyntaxHelp } from "./components/SyntaxHelp";
import { YearRange } from "./components/YearRange";
import { nextCompact } from "./lib/compact";
import { setEpisode } from "./lib/episode";
import { handleKeydown } from "./lib/keys";
import { normalizeQuery } from "./lib/url";
import { clearRange, effectiveRange, rangeLabel, setRange } from "./lib/years";
import { useSearch, type View } from "./use-search";

function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      setCompact((was) => nextCompact(was, window.scrollY, maxY));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return compact;
}

/** One plain message per kind of failed answer, until the notices of Task 11. */
function failureText(view: Exclude<View, { kind: "idle" | "loading" | "ok" }>): string {
  switch (view.kind) {
    case "maintenance":
      return view.message;
    case "rate_limited":
      return "Too many searches from here; try again in a minute.";
    default:
      return "Something went wrong.";
  }
}

export function App() {
  const { state, view, submit, setMode, setSort, goPage } = useSearch();
  const [text, setText] = useState(state.q);
  const [controlsOpen, setControlsOpen] = useState(false);
  const scrolled = useCompact();
  const compact = scrolled && !controlsOpen;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  // The box shows the search the URL holds (after Back and Forward too).
  useEffect(() => setText(state.q), [state.q]);

  useEffect(() => {
    if (!scrolled) setControlsOpen(false);
  }, [scrolled]);

  const summaryRef = useRef<HTMLButtonElement>(null);

  // Esc in the reopened controls (or on their button) closes them and returns to the button. The
  // sort menu stops its own Esc, so with it open the first Esc closes only the menu.
  function onHeaderKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !controlsOpen || event.defaultPrevented) return;
    const target = event.target as Element;
    if (!target.closest("#search-controls") && target !== summaryRef.current) return;
    event.preventDefault();
    setControlsOpen(false);
    summaryRef.current?.focus();
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleKeydown(event, { input: inputRef.current, list: listRef.current });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // A page change lands on the results heading, at the top of the results.
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, [state.page]);

  function onPage(page: number) {
    focusHeading.current = true;
    goPage(page);
  }

  const searching = state.q !== "";

  // The box shows what is searched: no emoji, no stray spaces.
  function searchFor(raw: string) {
    const q = normalizeQuery(raw);
    setText(q);
    submit(q);
  }

  const thisYear = new Date().getFullYear();
  const range = effectiveRange(state.q, thisYear);

  return (
    <div class="page">
      <header
        class={`site-header${scrolled ? " site-header--scrolled" : ""}${compact ? " site-header--compact" : ""}`}
        onKeyDown={onHeaderKeyDown}
      >
        <div class="column site-header__inner">
          <div class="site-header__brand-row">
            <a class="brand" href="/">
              Wood Talk Search
            </a>
            <span class="site-header__note">Unofficial · fan-made</span>
          </div>
          <div class="search-sticky">
            <SearchBar
              value={text}
              onInput={setText}
              onSubmit={() => searchFor(text)}
              inputRef={inputRef}
            />
          </div>
          <div class="controls" id="search-controls">
            <ModeSwitch mode={state.mode} onChange={setMode} />
            <SortMenu sort={state.sort} onChange={setSort} />
            <YearRange
              range={range}
              thisYear={thisYear}
              onApply={(from, to) => searchFor(setRange(text, from, to))}
              onClear={() => searchFor(clearRange(text))}
            />
            <span class="controls__spacer" />
            <SyntaxHelp
              onPick={(example) => {
                setText(example);
                inputRef.current?.focus();
              }}
            />
          </div>
        </div>
        {/* A toggle for the controls, on a scrolled phone page, in both states. It hangs below the header and adds no height. */}
        <button
          type="button"
          class="compact-summary"
          ref={summaryRef}
          aria-expanded={controlsOpen ? "true" : "false"}
          aria-controls="search-controls"
          onClick={() => setControlsOpen(!controlsOpen)}
        >
          {`${state.mode === "exact" ? "Exact" : "Smart"} · ${sortLabel(state.sort)} · ${rangeLabel(range)}`}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <main class="column main">
        {/* One live region for the whole page, in the DOM before any search, so what it says is announced. */}
        <div class="status" role="status" aria-live="polite">
          {view.kind === "loading" && "Searching…"}
          {view.kind === "ok" && <Summary data={view.data} />}
        </div>
        {searching ? (
          <>
            <h2 class="visually-hidden" tabIndex={-1} ref={headingRef}>
              Search results
            </h2>
            {view.kind === "loading" && <Skeleton />}
            {view.kind === "ok" && (
              <ResultList
                key={view.id}
                results={view.data.results}
                page={view.data.page}
                listRef={listRef}
                onSearchEpisode={(number) => searchFor(setEpisode(state.q, number))}
              />
            )}
            {view.kind !== "idle" && view.kind !== "loading" && view.kind !== "ok" && (
              <p class="message" role="alert">
                {failureText(view)}
              </p>
            )}
            {view.kind === "ok" && <Pagination data={view.data} onPage={onPage} />}
          </>
        ) : (
          <section class="empty">
            <h1 class="empty__title">Find the moment it was said.</h1>
          </section>
        )}
      </main>
      <footer class="site-footer">
        <div class="column site-footer__inner">
          <p class="site-footer__line">
            <strong>Unofficial</strong> · made with the hosts' blessing
          </p>
          <p class="site-footer__line">Searches are logged anonymously to improve results.</p>
        </div>
      </footer>
    </div>
  );
}
