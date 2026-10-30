// The page (spec §5.1, §5.2, §5.6, §5.7; design: Screen.dc.html, SearchHeader.dc.html): the
// header with the search bar and controls, `<main>` with the summary, results and pager, and the
// footer. The whole state is in the URL (use-search.ts); this file wires it to the components.
//
// The year range is not state: it is the `year:` tokens of the query (lib/years.ts), so the chip
// reads the searched query and Apply and × rewrite the text in the box and search it.
//
// The states of spec §5.6 are here: the empty state (with /api/info, asked once while it is
// shown), no results, the Exact truncation note, the degraded-Related notice, the rate limit with
// its countdown, the error with Retry, and the maintenance banner above the header. The banner
// shows when a search, a context request or /api/info answers `maintenance`, and goes when a
// later search succeeds (a report or feedback that answers `maintenance` raises it too). The
// footer is components/Footer.tsx, with its "Send feedback" form. The
// result cards are ResultList's, and More transcript and "+N nearby" are theirs too (Task 10);
// so is "Report transcript error", which opens a form under the hit (Task 13). /api/info is also
// where the forms get the Turnstile site key: the first form to open asks for it (`FormSite`,
// use-forms.ts), still at most one request per page load. "Search this episode" puts
// `ep:N` into the searched query and searches, like the year chip. The Episodes row (TitleHits)
// shows above the passages when the answer has episodes whose title matched; its "Search this
// episode" only fills the box with `ep:N`.
import { useEffect, useRef, useState } from "preact/hooks";
import { AcrossButton } from "./components/AcrossButton";
import { Banner } from "./components/Banner";
import { EmptyState, NoResults } from "./components/EmptyState";
import { Footer } from "./components/Footer";
import { HowItWorks } from "./components/HowItWorks";
import { ModeSwitch } from "./components/ModeSwitch";
import { Notice } from "./components/Notice";
import { Pagination } from "./components/Pagination";
import { ResultList } from "./components/ResultList";
import { SearchBar } from "./components/SearchBar";
import { Skeleton } from "./components/Skeleton";
import { SortMenu } from "./components/SortMenu";
import { Summary } from "./components/Summary";
import { SortYearsButton } from "./components/SortYearsButton";
import { SortYearsSheet } from "./components/SortYearsSheet";
import { SyntaxHelp } from "./components/SyntaxHelp";
import { TitleHits } from "./components/TitleHits";
import { YearRange } from "./components/YearRange";
import { nextCompact } from "./lib/compact";
import { setEpisode } from "./lib/episode";
import { count } from "./lib/format";
import { handleKeydown } from "./lib/keys";
import { normalizeQuery, type SortOrder } from "./lib/url";
import { clearRange, effectiveRange, setRange, type YearRange as Range } from "./lib/years";
import { useCountdown } from "./use-countdown";
import { FormSiteContext, type FormSite } from "./use-forms";
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
  const scrolled = useCompact();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  // The box shows the search the URL holds (after Back and Forward too).
  useEffect(() => setText(state.q), [state.q]);

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
  const [formOpened, setFormOpened] = useState(false);
  const { data: info, failed: infoFailed } = useInfo(!searching || formOpened, setMaintenance);
  const formSite: FormSite = {
    status: info ? (info.turnstile_site_key ? "ready" : "unavailable") : infoFailed ? "unavailable" : "loading",
    siteKey: info?.turnstile_site_key ?? null,
    ask: () => setFormOpened(true),
  };

  // The box shows what is searched: no emoji, no stray spaces. With `sort`, the same search
  // changes it (the Sort & years sheet).
  function searchFor(raw: string, sort?: SortOrder) {
    if (waiting > 0) return;
    const q = normalizeQuery(raw);
    setText(q);
    submit(q, sort);
  }

  // "Tips ?": an example goes in the box, which takes the focus; nothing is searched.
  function pickTip(example: string) {
    setText(example);
    inputRef.current?.focus();
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

  // The phone's Sort & years sheet. It applies sort and years in one search, and only when
  // something changed; closing returns focus to its button.
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  function closeSheet() {
    setSheetOpen(false);
    sheetButtonRef.current?.focus();
  }
  function applySheet(sort: SortOrder, next: Range | null) {
    const same = next === null ? range === null : range !== null && range.from === next.from && range.to === next.to;
    if (sort === state.sort && same) return;
    const q = next ? setRange(text, next.from, next.to) : clearRange(text);
    // With nothing to search, a new sort is only remembered for the next search.
    if (q === "" && state.q === "") setSort(sort);
    else searchFor(q, sort !== state.sort ? sort : undefined);
  }

  // An older cached answer may lack `episodes`.
  const titleHits = view.kind === "ok" && view.data.page === 1 ? (view.data.episodes ?? []) : [];

  const relatedEnd = view.kind === "ok" && view.data.mode === "related" && !view.data.has_more && view.data.page > 1;
  const relatedDegraded = view.kind === "ok" && view.data.mode === "related" && !!view.data.smart_degraded;

  // A short Exact list (1–4 matches, an exact count) offers the related passages under it.
  const fewExact =
    view.kind === "ok" &&
    view.data.mode === "exact" &&
    view.data.page === 1 &&
    view.data.results.length > 0 &&
    view.data.total < 5 &&
    !view.data.total_capped;

  // After "Switch to Exact" the popover is gone with its button: focus goes to the results heading.
  function switchToExact() {
    setMode("exact");
    headingRef.current?.focus({ preventScroll: true });
  }

  return (
    <FormSiteContext.Provider value={formSite}>
    <div class="page">
      {maintenance !== null && <Banner message={maintenance} />}
      <header
        class={`site-header${scrolled ? " site-header--scrolled site-header--compact" : ""}`}
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
              episodes={info?.episodes}
            />
          </div>
          <div class="controls" id="search-controls">
            <ModeSwitch mode={state.mode} onChange={setMode} />
            {/* Both sets are in the DOM; CSS shows the desktop pair, or the phone's one button. */}
            <div class="controls__desktop">
              <SortMenu sort={state.sort} onChange={setSort} />
              <YearRange
                range={range}
                thisYear={thisYear}
                onApply={(from, to) => searchFor(setRange(text, from, to))}
                onClear={() => searchFor(clearRange(text))}
              />
            </div>
            <div class="controls__phone">
              <SortYearsButton
                sort={state.sort}
                range={range}
                open={sheetOpen}
                onOpen={() => setSheetOpen(true)}
                buttonRef={sheetButtonRef}
              />
            </div>
          </div>
        </div>
      </header>
      <main class="column main">
        {/* One live region for the whole page, in the DOM before any search, so what it says is announced. */}
        <div class="summary-row">
          <div class="status" role="status" aria-live="polite">
            {view.kind === "loading" && "Searching…"}
            {view.kind === "ok" && <Summary data={view.data} />}
          </div>
          {view.kind === "ok" && view.data.mode === "related" && view.data.results.length > 0 && (
            <HowItWorks onSwitchToExact={switchToExact} />
          )}
          {/* Before any search the start page's TRY label carries it instead. */}
          {searching && <SyntaxHelp onPick={pickTip} />}
        </div>
        {searching ? (
          <>
            <h2 class="visually-hidden" tabIndex={-1} ref={headingRef}>
              Search results
            </h2>
            {view.kind === "loading" && <Skeleton />}
            {titleHits.length > 0 && <TitleHits episodes={titleHits} onSearchEpisode={fillEpisode} />}
            {view.kind === "ok" && view.data.mode === "related" && view.data.smart_degraded && (
              <>
                <Notice tone="info">
                  {view.data.smart_degraded === "unavailable"
                    ? "Related search is unavailable right now."
                    : "Related search is paused."}
                </Notice>
                <AcrossButton to="exact" onClick={() => setMode("exact")} />
              </>
            )}
            {view.kind === "ok" &&
              !relatedDegraded &&
              view.data.results.length === 0 &&
              view.data.page === 1 &&
              titleHits.length === 0 && (
                <NoResults
                  mode={view.data.mode}
                  hasYears={range !== null}
                  onRelated={() => setMode("related")}
                  onExact={() => setMode("exact")}
                />
              )}
            {view.kind === "ok" && view.data.results.length > 0 && (
              <ResultList
                key={view.id}
                results={view.data.results}
                page={view.data.page}
                related={view.data.mode === "related"}
                listRef={listRef}
                q={state.q}
                onSearchEpisode={(number) => searchFor(setEpisode(state.q, number))}
              />
            )}
            {view.kind === "rate_limited" && (
              <Notice tone="warning">
                Too many searches from here.{" "}
                {/* The countdown is hidden from screen readers (it would announce every second), so
                    they hear the wait in words instead. */}
                {waiting > 0 && <span class="visually-hidden">Try again in a minute. </span>}
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
            {fewExact && view.kind === "ok" && view.data.mode === "exact" && (
              <div class="few">
                <p>
                  <strong>{`Only ${view.data.total} exact ${view.data.total === 1 ? "match" : "matches"}.`}</strong>
                  {" Related passages match the meaning, not just the words."}
                </p>
                <AcrossButton to="related" onClick={() => setMode("related")} />
              </div>
            )}
            {view.kind === "ok" && !fewExact && <Pagination data={view.data} onPage={onPage} />}
            {relatedEnd && <p class="end-note">That's the end of the related passages.</p>}
          </>
        ) : (
          <EmptyState info={info} onPick={searchFor} onTip={pickTip} />
        )}
      </main>
      <Footer feedback />
      {sheetOpen && <SortYearsSheet sort={state.sort} range={range} thisYear={thisYear} onApply={applySheet} onClose={closeSheet} />}
    </div>
    </FormSiteContext.Provider>
  );
}
