// The page (spec §5.1, §5.2, §5.6, §5.7; design: Screen.dc.html, SearchHeader.dc.html): the
// header with the search bar and controls, `<main>` with the summary, results and pager, and the
// footer. The whole state is in the URL (use-search.ts); this file wires it to the components.
//
// The year range is not state: it is the `year:` tokens of the query (lib/years.ts), so the chip
// reads the searched query and Apply and × rewrite the text in the box and search it.
//
// The states of spec §5.6 are here: the empty state (with /api/info, asked once while it is
// shown), no results, the Exact truncation note, the degraded-Smart notice, the rate limit with
// its countdown, the error with Retry, and the maintenance banner above the header. The banner
// shows when a search, a context request or /api/info answers `maintenance`, and goes when a
// later search succeeds. Not here yet: the real footer (Task 13). The
// result cards are ResultList's, and More transcript and "+N nearby" are theirs too (Task 10);
// Report (Task 13) is not wired, so that control does nothing yet. "Search this episode" puts
// `ep:N` into the searched query and searches, like the year chip. The Episodes row (TitleHits)
// shows above the passages when the answer has episodes whose title matched; its "Search this
// episode" only fills the box with `ep:N`.
import { useEffect, useRef, useState } from "preact/hooks";
import { Banner } from "./components/Banner";
import { EmptyState, NoResults } from "./components/EmptyState";
import { HowItWorks } from "./components/HowItWorks";
import { ModeSwitch } from "./components/ModeSwitch";
import { Notice } from "./components/Notice";
import { Pagination } from "./components/Pagination";
import { ResultList } from "./components/ResultList";
import { SearchBar } from "./components/SearchBar";
import { Skeleton } from "./components/Skeleton";
import { SortMenu, sortLabel } from "./components/SortMenu";
import { Summary } from "./components/Summary";
import { SyntaxHelp } from "./components/SyntaxHelp";
import { TitleHits } from "./components/TitleHits";
import { YearRange } from "./components/YearRange";
import { nextCompact } from "./lib/compact";
import { setEpisode } from "./lib/episode";
import { count } from "./lib/format";
import { handleKeydown } from "./lib/keys";
import { normalizeQuery } from "./lib/url";
import { clearRange, effectiveRange, rangeLabel, setRange } from "./lib/years";
import { useCountdown } from "./use-countdown";
import { useInfo } from "./use-info";
import { useSearch } from "./use-search";
import { ReportMaintenance } from "./use-transcript";

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

/** The maintenance message lives here, so the page and the transcripts under it can both set it. */
export function App() {
  const [maintenance, setMaintenance] = useState<string | null>(null);
  return (
    <ReportMaintenance.Provider value={setMaintenance}>
      <Page maintenance={maintenance} setMaintenance={setMaintenance} />
    </ReportMaintenance.Provider>
  );
}

function Page({ maintenance, setMaintenance }: { maintenance: string | null; setMaintenance: (message: string | null) => void }) {
  const { state, view, submit, setMode, setSort, goPage, retry } = useSearch();

  // A maintenance answer from the search shows the banner; the next good search clears it.
  useEffect(() => {
    if (view.kind === "maintenance") setMaintenance(view.message);
    else if (view.kind === "ok") setMaintenance(null);
  }, [view]);

  // Rate limited: Search is off until the countdown ends, and nothing retries by itself.
  const waiting = useCountdown(view.kind === "rate_limited" ? view.retryAfterS : null, view);
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
  const info = useInfo(!searching, setMaintenance);

  // The box shows what is searched: no emoji, no stray spaces.
  function searchFor(raw: string) {
    if (waiting > 0) return;
    const q = normalizeQuery(raw);
    setText(q);
    submit(q);
  }

  // "Search this episode" in the Episodes row: `ep:N` alone in the box, the cursor at its end.
  // It does not search: the title's word is often not in the transcript.
  const cursorAtEnd = useRef(false);
  function fillEpisode(number: number) {
    cursorAtEnd.current = true;
    setText(`ep:${number}`);
    inputRef.current?.focus();
  }
  useEffect(() => {
    const input = inputRef.current;
    if (!cursorAtEnd.current || !input || input.value !== text) return;
    cursorAtEnd.current = false;
    input.setSelectionRange(text.length, text.length);
  }, [text]);

  const thisYear = new Date().getFullYear();
  const range = effectiveRange(state.q, thisYear);

  // An older cached answer may lack `episodes`.
  const titleHits = view.kind === "ok" && view.data.page === 1 ? (view.data.episodes ?? []) : [];

  const smartEnd = view.kind === "ok" && view.data.mode === "smart" && !view.data.has_more && view.data.page > 1;

  // After "Switch to Exact" the popover is gone with its button: focus goes to the results heading.
  function switchToExact() {
    setMode("exact");
    headingRef.current?.focus({ preventScroll: true });
  }

  return (
    <div class="page">
      {maintenance !== null && <Banner message={maintenance} />}
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
              disabled={waiting > 0}
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
        <div class="summary-row">
          <div class="status" role="status" aria-live="polite">
            {view.kind === "loading" && "Searching…"}
            {view.kind === "ok" && <Summary data={view.data} />}
          </div>
          {view.kind === "ok" && view.data.mode === "smart" && view.data.results.length > 0 && (
            <HowItWorks onSwitchToExact={switchToExact} />
          )}
        </div>
        {searching ? (
          <>
            <h2 class="visually-hidden" tabIndex={-1} ref={headingRef}>
              Search results
            </h2>
            {view.kind === "loading" && <Skeleton />}
            {titleHits.length > 0 && <TitleHits episodes={titleHits} onSearchEpisode={fillEpisode} />}
            {view.kind === "ok" && view.data.mode === "smart" && view.data.smart_degraded && (
              <Notice tone="info">
                {view.data.smart_degraded === "unavailable"
                  ? "Meaning search is unavailable right now; these are keyword matches."
                  : "Meaning search is paused; these are keyword matches."}
              </Notice>
            )}
            {view.kind === "ok" && view.data.results.length === 0 && view.data.page === 1 && titleHits.length === 0 && (
              <NoResults
                mode={view.data.mode}
                hasYears={range !== null}
                onSmart={() => setMode("smart")}
              />
            )}
            {view.kind === "ok" && view.data.results.length > 0 && (
              <ResultList
                key={view.id}
                results={view.data.results}
                page={view.data.page}
                listRef={listRef}
                q={state.q}
                onSearchEpisode={(number) => searchFor(setEpisode(state.q, number))}
              />
            )}
            {view.kind === "rate_limited" && (
              <Notice tone="warning">
                Too many searches from here; try again in a minute.{" "}
                {waiting > 0 ? (
                  <span class="notice__countdown" aria-hidden="true">{`Try again in ${waiting} s`}</span>
                ) : (
                  "You can search again now."
                )}
              </Notice>
            )}
            {(view.kind === "unavailable" || view.kind === "network") && (
              <Notice
                tone="danger"
                action={
                  <button type="button" class="notice__button" onClick={retry}>
                    Retry
                  </button>
                }
              >
                Something went wrong.
              </Notice>
            )}
            {view.kind === "ok" && view.data.mode === "exact" && view.data.truncated && !view.data.has_more && (
              <Notice tone="info">
                {`Showing the best 200 of ${count(view.data.total, view.data.total_capped)} matches — add words, a "phrase" or a year to narrow it.`}
              </Notice>
            )}
            {view.kind === "ok" && <Pagination data={view.data} onPage={onPage} />}
            {smartEnd && <p class="end-note">That's the end of the top results. Exact search lists every match.</p>}
          </>
        ) : (
          <EmptyState info={info} onPick={searchFor} />
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
