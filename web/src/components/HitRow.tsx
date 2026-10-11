// One hit of a result card (spec §5.3; docs/design/card-separation-options.html, option A): the
// timestamp chip (the hit's one play control), the excerpt, ⋯, and "+N nearby" under the excerpt.
// Desktop is a three-column grid (chip, excerpt, ⋯); below 600 px the chip takes its own first row
// (CSS only, the DOM is the same). The excerpt opens More transcript on a click, unless text is
// selected. Keyboard order follows the visual order: chip, ⋯, "+N nearby", then the expanded view.
//
// The expanded view (spec §5.4) opens in this row, inside the card: radius 3 from the excerpt
// or the menu's More transcript, radius 6 from "+N nearby". While open it replaces the chip and
// the excerpt (its own row for the hit has the time and the play link); ⋯ and "+N nearby" stay
// above it (beside it, for a row without "+N nearby"). It takes focus when it opens, and
// when it collapses focus returns to the control that opened it: "+N nearby", or ⋯ for the other
// two (the excerpt is plain text for selecting, so it is not a control).
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { anchorDelta } from "../lib/anchor";
import { excerpt } from "../lib/excerpt";
import { chipName, hitTime, menuPlays, primaryPlay } from "../lib/platforms";
import { OpenReport } from "../use-forms";
import { useTranscript } from "../use-transcript";
import { MoreMenu } from "./MoreMenu";
import { PlayIcon } from "./PlayIcon";
import { ReportForm } from "./ReportForm";
import { Transcript } from "./Transcript";

/** The text the person has selected, if all of it lies inside one of `scopes`; else null. */
function selectionWithin(scopes: (Element | null)[]): string | null {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const inside = (node: Node | null) => node !== null && scopes.some((scope) => scope?.contains(node));
  return inside(selection.anchorNode) && inside(selection.focusNode) ? text : null;
}

export interface HitActions {
  onReport: (hit: SearchResult) => void;
  /** "Search this episode" in the expanded view: search the current query within episode `number`. */
  onSearchEpisode: (number: number) => void;
}

/** A scroll to apply once the DOM it is about is there: `top` is the hit's viewport top at the click. */
interface Pending {
  kind: "open" | "close";
  top: number | null;
  scrollY: number;
  /** Opening this collapsed another hit's view, so the page moved under the reader at once. */
  moved?: boolean;
}

/**
 * The bottom edge of what the site header covers now. On a phone, once compact, the header's
 * box stays as tall as before but only the search row and the summary button under it show (see
 * components.css), so the lower of those two is the edge.
 */
function headerBottom(): number {
  const header = document.querySelector(".site-header");
  if (!header) return 0;
  const compactPhone =
    header.classList.contains("site-header--compact") && !!window.matchMedia?.("(max-width: 599.98px)").matches;
  const search = compactPhone ? header.querySelector(".search-sticky") : null;
  if (!search) return header.getBoundingClientRect().bottom;
  const summary = header.querySelector(".compact-summary");
  return Math.max(search.getBoundingClientRect().bottom, summary ? summary.getBoundingClientRect().bottom : 0);
}

/**
 * Scroll the window (instantly) so `target` is at `recordedTop`, kept clear of the sticky header
 * and, when the view is open, of its sticky strip (`strip`).
 */
function place(target: Element, recordedTop: number | null, strip: Element | null) {
  const rect = target.getBoundingClientRect();
  const delta = anchorDelta({
    recordedTop,
    top: rect.top,
    height: rect.height,
    headerBottom: headerBottom(),
    stripBottom: strip ? strip.getBoundingClientRect().bottom : null,
    viewportHeight: window.innerHeight,
  });
  if (delta !== 0) window.scrollBy(0, delta);
}

/**
 * `place`, then once more on the next frame: the scroll can make the phone's header compact
 * (app.tsx), which changes what is under it. The second pass keeps the element where it landed
 * and clear of the header as it is now; it does nothing if the reader has scrolled since.
 */
function settle(target: Element, recordedTop: number | null, strip: Element | null) {
  // The strip is sticky: where it is before the scroll says nothing about where it is after.
  // So scroll for the header first, then, with the strip in its new place, keep clear of it.
  place(target, recordedTop, null);
  if (strip) place(target, target.getBoundingClientRect().top, strip);
  const landed = target.getBoundingClientRect().top;
  const scrollY = window.scrollY;
  requestAnimationFrame(() => {
    if (target.isConnected && window.scrollY === scrollY) place(target, landed, strip);
  });
}

export function HitRow({
  hit,
  first,
  q = "",
  onReport,
  onSearchEpisode,
}: HitActions & {
  hit: SearchResult;
  /** The first row of its card has no rule above it. */
  first: boolean;
  /** The searched query, so the expanded view marks its words in the nearby paragraphs. */
  q?: string;
}) {
  const time = hitTime(hit);
  const play = primaryPlay(hit);
  const view = excerpt(hit.text, hit.ranges);
  const transcript = useTranscript(hit.chunk_id, q);
  const { shown } = transcript;

  const moreButton = useRef<HTMLButtonElement>(null);
  const nearbyButton = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  const excerptText = useRef<HTMLParagraphElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const opener = useRef<"more" | "nearby">("more");
  const pending = useRef<Pending | null>(null);
  const regionId = `transcript-${hit.chunk_id}`;

  // The report form (spec §5.5): one is open on the page; it starts from the selection, if that
  // lies in this card's excerpt or open transcript, else from the excerpt.
  const ownReport = useState<number | null>(null);
  const [reportOpen, setReportOpen] = useContext(OpenReport) ?? ownReport;
  const reporting = reportOpen === hit.chunk_id;
  const [quote, setQuote] = useState("");

  function startReport() {
    setQuote(selectionWithin([excerptText.current, region.current]) ?? view.segments.map((s) => s.text).join(""));
    setReportOpen(hit.chunk_id);
    onReport(hit);
  }

  function closeReport() {
    setReportOpen(null);
    moreButton.current?.focus();
  }

  // Opening, or moving between the two views, puts focus on the region (without scrolling: the
  // layout effect below has already put the page where it should be).
  useEffect(() => {
    if (shown !== null) region.current?.focus({ preventScroll: true });
  }, [shown]);

  // Keep the reader's place. The hit's viewport top is recorded at the click (`pending`); once the
  // DOM it is about exists, and before paint, the window is scrolled so the hit's paragraph
  // (open) or excerpt (collapse) is at that top, less whatever the page has scrolled since the
  // click. A reader who has scrolled that place off the screen is only rescued from having the
  // hit off screen. Collapsing then returns focus to the opener, without scrolling.
  useLayoutEffect(() => {
    const wanted = pending.current;
    if (!wanted) return;
    if (wanted.kind === "open") {
      if (shown === null) return;
      const target = transcript.entry?.kind === "ok" ? region.current?.querySelector(".passage--hit") : null;
      if (!target) {
        // Still loading. If another view collapsed above this row, the row has jumped: hold the
        // view where the excerpt was until its paragraphs are there. This runs in the click's own
        // task, so the reader cannot have scrolled; the browser may have (scroll anchoring).
        if (wanted.moved && region.current) {
          place(region.current, wanted.top, strip.current);
          wanted.moved = false;
          wanted.scrollY = window.scrollY;
        }
        return;
      }
      pending.current = null;
      // The page may have moved while the passage loaded (a flick still settling on a phone, or
      // the reader scrolling): the hit goes where its excerpt would be now. A reader who has
      // scrolled that place off the screen is only rescued from having the hit off screen too.
      const drift = wanted.moved ? 0 : window.scrollY - wanted.scrollY;
      const top = wanted.top === null ? null : wanted.top - drift;
      const onScreen = top !== null && (drift === 0 || (top >= headerBottom() && top < window.innerHeight));
      settle(target, onScreen ? top : null, strip.current);
    } else if (shown === null) {
      pending.current = null;
      // A collapse is applied in the click's own task, so the reader cannot have scrolled since
      // (the browser may have clamped the scroll position to the shorter page).
      if (excerptText.current && wanted.top !== null) settle(excerptText.current, wanted.top, null);
      (opener.current === "nearby" ? nearbyButton : moreButton).current?.focus({ preventScroll: true });
    }
  }, [shown, transcript.entry]);

  /** Note where the hit is on screen: its paragraph if the view is open, else its excerpt. */
  function recordOpen() {
    const target = region.current?.querySelector(".passage--hit") ?? excerptText.current;
    if (!target) return;
    pending.current = {
      kind: "open",
      top: target.getBoundingClientRect().top,
      scrollY: window.scrollY,
      moved: transcript.otherOpen,
    };
  }

  function collapse() {
    const paragraph = region.current?.querySelector(".passage--hit");
    pending.current = {
      kind: "close",
      top: paragraph ? paragraph.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
    };
    transcript.hide();
  }

  function openMore() {
    opener.current = "more";
    recordOpen();
    transcript.show(3);
  }

  function onExcerptClick() {
    // Selecting text (to report it) must not open the passage.
    if (window.getSelection()?.toString()) return;
    openMore();
  }

  const open = shown !== null;
  const nearbyShown = hit.folded.length > 0;

  return (
    <div class={`hit${first ? "" : " hit--ruled"}${open ? " hit--open" : ""}${open && !nearbyShown ? " hit--bare" : ""}`}>
      {/* While the view is open it replaces the chip and the excerpt: its own row for the hit has the time and the play link. */}
      {open ? null : play ? (
        <a
          class="hit__time"
          href={play.href}
          target="_blank"
          rel="noopener"
          aria-label={chipName(play, time)}
          title={chipName(play, time)}
        >
          <PlayIcon size={9} />
          {time}
        </a>
      ) : (
        <span class="hit__time hit__time--text">{time}</span>
      )}
      {!open && (
        <p class="hit__excerpt" ref={excerptText} title="Show full passage" onClick={onExcerptClick}>
          {view.cutStart && "… "}
          {view.segments.map((segment, index) =>
            segment.mark ? <mark key={index}>{segment.text}</mark> : segment.text,
          )}
          {view.cutEnd && " …"}
        </p>
      )}
      {/* Closed, the strip is transparent to the row's grid (display: contents). Open, it is the
          sticky bar of "+N nearby", Show less and ⋯ above the view; one element in both states, so
          ⋯ keeps its state when the view opens. */}
      <div class="hit__strip" ref={strip}>
      <MoreMenu
        plays={menuPlays(hit)}
        time={time}
        moreOpen={shown === 3}
        buttonRef={moreButton}
        onMore={() => (shown === 3 ? collapse() : openMore())}
        onReport={startReport}
      />
      {nearbyShown && (
        <button
          type="button"
          class="hit__nearby"
          ref={nearbyButton}
          aria-expanded={shown === 6 ? "true" : "false"}
          aria-controls={shown === 6 ? regionId : undefined}
          onClick={() => {
            if (shown === 6) {
              collapse();
              return;
            }
            opener.current = "nearby";
            recordOpen();
            transcript.show(6);
          }}
        >
          {`+${hit.folded.length} nearby`}
        </button>
      )}
      {open && (
        <button type="button" class="hit__less" aria-label="Show less transcript" onClick={collapse}>
          Show less
        </button>
      )}
      </div>
      {shown !== null && (
        <Transcript
          id={regionId}
          hit={hit}
          radius={shown}
          entry={transcript.entry}
          regionRef={region}
          onRetry={() => {
            transcript.retry();
            region.current?.focus({ preventScroll: true });
          }}
          onClose={collapse}
          onSearchEpisode={onSearchEpisode}
        />
      )}
      {reporting && (
        <div class="hit__report">
          <ReportForm chunkId={hit.chunk_id} initialQuote={quote} onClose={closeReport} />
        </div>
      )}
    </div>
  );
}
