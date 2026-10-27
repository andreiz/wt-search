// The review page of `wts review` (spec 3.7). Loaded as an ES module by index.html.
//
// It reads the token, episode, time and report from its own URL, fetches the
// episode payload, and shows the transcript beside an <audio> element: the
// current word is highlighted and scrolled to, clicking a word seeks, keys
// control playback, a native <dialog> previews and saves a correction, another
// adds a test search for a passage to eval/queries.yaml, and, when the URL has
// `report`, a panel shows a listener's report. Repairs (stretches a fresh pass filled in) are
// listed in the bar; one opens in a panel above the transcript, beside the transcript's own words,
// to be accepted or rejected.
//
// Everything that comes from the server is inserted with textContent or
// createElement, never innerHTML. No inline script or style (the page's CSP
// forbids both).
//
// Sections: helpers, API, rendering, following playback, keyboard and
// selection, the edit dialog, the test-search dialog, the report panel, the repairs panel,
// startup.

const SCROLL_PAUSE_MS = 5000;
const SEEK_STEP_S = 5;
const SPEEDS_OK = new Set(["0.75", "1", "1.25", "1.5", "1.75", "2"]);
const BOOSTS_OK = new Set(["1", "2", "4", "8"]);

const params = new URLSearchParams(location.search);
const token = params.get("t") || "";
const episodeParam = params.get("episode");
const atParam = params.get("at");
const reportParam = params.get("report");

const $ = (id) => document.getElementById(id);
const audio = $("player");
const transcriptEl = $("transcript");
const editDialog = $("edit-dialog");
const testDialog = $("test-dialog");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// What the page currently shows.
const S = {
  ep: null, // the episode object
  words: [], // [[text, start_ms, end_ms, prob]]
  starts: [], // start_ms of each word, for binary search
  spans: [], // the <span data-i> of each word
  breaks: [], // word indexes where paragraphs start
  lowIdx: [], // indexes of the unsure words, as the server chose them (data.py `is_unsure`)
  cur: -1, // index of the word marked `now`
  virtualMs: 0, // the "current time" when there is no audio
  pausedUntil: 0, // auto-scroll is paused until this time (Date.now())
  raf: 0,
  report: null, // the report object once loaded
  repairs: [], // the episode's repairs, as the server sent them (time order)
  repairOpen: null, // id of the repair the panel shows
  stopAtMs: null, // "Play" on a repair pauses the audio at this time
  lastSelection: null, // {lo, hi} of the last selection inside the transcript
  keyAt: new Map(), // word index -> the struck-out text before it, as a rule's key names it
  fixStart: new Map(), // corrected word -> the first word of its correction
  joinedKey: new Map(), // a joined word ("three-eighths") -> its key ("three eighths")
};

// ---------------------------------------------------------------- helpers

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function stripPunct(s) {
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function normWord(s) {
  return stripPunct(s.toLowerCase());
}

// First index whose value is >= v.
function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Index of the last word that starts at or before ms (-1 if none).
function wordIndexAt(ms) {
  const starts = S.starts;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function setStatus(text) {
  $("status").textContent = text || "";
}

function showMessage(text) {
  const m = $("message");
  m.textContent = text;
  m.hidden = false;
}

// -------------------------------------------------------------------- API

// Never throws on an HTTP error: resolves to {status, data}. status 0 means
// the server could not be reached.
async function api(path, body) {
  const headers = { "X-Review-Token": token };
  const init = { headers };
  if (body !== undefined) {
    init.method = "POST";
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(path, init);
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    return { status: r.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

// -------------------------------------------------------------- rendering

function currentMs() {
  return S.ep && S.ep.has_audio ? audio.currentTime * 1000 : S.virtualMs;
}

function renderHeader() {
  const ep = S.ep;
  $("title").textContent = `${ep.number}. ${ep.title}`;
  $("meta").textContent = ep.published_at ? String(ep.published_at).slice(0, 10) : "";
  document.title = `${ep.number}: ${ep.title}`;

  const flags = $("flags");
  flags.replaceChildren(...(ep.flags || []).map((f) => el("li", "", f)));
  flags.hidden = !(ep.flags && ep.flags.length);

  renderReviewedButton();
  $("add-test").hidden = false;

  const url = `/audio/${ep.id}?t=${encodeURIComponent(token)}`;
  audio.hidden = !ep.has_audio;
  $("no-audio").hidden = !!ep.has_audio;
  $("speed").disabled = !ep.has_audio;
  $("boost").disabled = !ep.has_audio;
  if (ep.has_audio && audio.getAttribute("src") !== url) audio.setAttribute("src", url);
  // An episode keeps the boost it was last given: the quiet ones are the same ones every time.
  const saved = stored(boostKey(ep));
  $("boost").value = BOOSTS_OK.has(saved) ? saved : "1";
  setBoost(Number($("boost").value));
}

// --- Boost ---------------------------------------------------------------------------------
// The player's own volume stops at the file's level, and the files differ a lot (episode 71 is
// 15 dB under episode 597). A boost sends the sound through a gain and then a limiter, so loud
// moments are held down rather than clipped. The audio graph is made only when a boost is first
// asked for: once made, the player's sound runs through it for good.
let boostGraph = null;

function boostKey(ep) {
  return `wts-review-boost-${ep.id}`;
}

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // a private window: the boost just isn't remembered
  }
}

function setBoost(times) {
  if (!boostGraph) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (times === 1 || !Context) return;
    const context = new Context();
    const gain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    context.createMediaElementSource(audio).connect(gain).connect(limiter).connect(context.destination);
    boostGraph = { context, gain };
  }
  boostGraph.gain.gain.value = times;
  resumeBoost();
}

// A graph made before the first click starts out suspended, and then the player is silent.
function resumeBoost() {
  if (boostGraph && boostGraph.context.state === "suspended") boostGraph.context.resume().catch(() => {});
}

function renderReviewedButton() {
  const b = $("reviewed");
  const on = !!S.ep.reviewed_at;
  b.hidden = false;
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.textContent = on ? "Reviewed" : "Mark reviewed";
  b.title = on ? `Reviewed ${S.ep.reviewed_at}` : "";
}

function renderWorst(worst) {
  const list = $("worst-list");
  list.replaceChildren();
  for (const w of worst || []) {
    const b = el("button", "", `${fmtTime(w.start_ms)} · ${Math.round(w.share * 100)}%`);
    b.type = "button";
    b.title = "Jump to this stretch";
    b.addEventListener("click", () => {
      seekMs(w.start_ms, { play: false });
      b.blur();
    });
    list.append(b);
  }
  $("worst").hidden = !(worst && worst.length);
}

// Where paragraphs start: each chunk's first word at or after its start_ms,
// so a word is rendered once even where chunks overlap. Returns
// [{index, boilerplate}] sorted by index, always starting at word 0.
function paragraphStarts(payload) {
  const { words, starts } = S;
  const byIndex = new Map();
  for (const c of payload.chunks || []) {
    const i = lowerBound(starts, c.start_ms);
    if (i >= words.length) continue;
    byIndex.set(i, (byIndex.has(i) ? byIndex.get(i) : true) && !!c.is_boilerplate);
  }
  if (byIndex.size === 0) {
    // No chunks: break at sentence starts, about every 100 words.
    let last = 0;
    byIndex.set(0, false);
    for (const s of payload.sentences || []) {
      if (s - last >= 100) {
        byIndex.set(s, false);
        last = s;
      }
    }
  }
  if (!byIndex.has(0)) byIndex.set(0, false);
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, boilerplate]) => ({ index, boilerplate }));
}

function renderTranscript(payload) {
  const words = payload.words || [];
  S.words = words;
  S.starts = words.map((w) => w[1]);
  S.spans = new Array(words.length);
  S.lowIdx = (payload.unsure || []).filter((i) => Number.isInteger(i) && i >= 0 && i < words.length);
  const unsure = new Set(S.lowIdx);
  // Corrections, shown inline: what Whisper wrote, struck out, before the words that replaced
  // it. `wasAt` is by the index of the word the struck-out text goes before.
  const wasAt = new Map();
  const fixed = new Set();
  for (const fix of payload.fixes || []) {
    const [index, count, was] = fix;
    if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index > words.length) continue;
    wasAt.set(index, wasAt.has(index) ? `${wasAt.get(index)} ${was}` : String(was));
    for (let i = index; i < index + count && i < words.length; i++) fixed.add(i);
  }
  S.keyAt = new Map();
  S.fixStart = new Map();
  for (const [index, count, was, key] of payload.fixes || []) {
    if (!wasAt.has(index)) continue;
    const text = String(key || was);
    S.keyAt.set(index, S.keyAt.has(index) ? `${S.keyAt.get(index)} ${text}` : text);
    for (let i = index; i < index + count && i < words.length; i++) S.fixStart.set(i, index);
  }
  S.joinedKey = new Map((payload.joined || []).map(([index, key]) => [index, String(key)]));
  const wasNode = (index) => {
    const del = el("del", "was", wasAt.get(index));
    del.title = "What Whisper wrote, before a correction";
    return del;
  };
  S.cur = -1;

  const starts = paragraphStarts(payload);
  S.breaks = starts.map((p) => p.index);

  const frag = document.createDocumentFragment();
  for (let p = 0; p < starts.length; p++) {
    const from = starts[p].index;
    const to = p + 1 < starts.length ? starts[p + 1].index : words.length;
    const para = el("p", starts[p].boilerplate ? "para boilerplate" : "para");
    const time = el("button", "time", fmtTime(words[from][1]));
    time.type = "button";
    time.tabIndex = -1;
    time.dataset.ms = String(words[from][1]);
    time.title = "Play from here";
    const text = el("span", "text");
    for (let i = from; i < to; i++) {
      const w = words[i];
      const span = document.createElement("span");
      span.dataset.i = String(i);
      span.textContent = String(w[0]).trim();
      if (unsure.has(i)) span.className = "low";
      if (fixed.has(i)) span.classList.add("fixed");
      S.spans[i] = span;
      if (i > from) text.append(" ");
      if (wasAt.has(i)) text.append(wasNode(i), " ");
      text.append(span);
    }
    // Words a rule deleted at the very end of the episode.
    if (to === words.length && wasAt.has(to)) text.append(" ", wasNode(to));
    para.append(time, text);
    frag.append(para);
  }
  transcriptEl.replaceChildren(frag);
}

// Draw (or redraw) the whole page from an episode payload. With `keep`,
// the scroll position is kept and playback is left alone.
function render(payload, keep) {
  const y = window.scrollY;
  S.ep = payload.episode;
  renderHeader();
  renderWorst(payload.worst);
  renderTranscript(payload);
  renderRepairs(payload.repairs);
  markReported();
  if (keep) window.scrollTo({ top: y, behavior: "instant" });
  setCurrent(wordIndexAt(currentMs() + 30), "none");
}

// ------------------------------------------------------ following playback

function setCurrent(i, scrollMode) {
  if (i === S.cur && scrollMode !== "force") return;
  if (S.cur >= 0 && S.spans[S.cur]) S.spans[S.cur].classList.remove("now");
  S.cur = i;
  if (i < 0 || !S.spans[i]) return;
  S.spans[i].classList.add("now");
  if (scrollMode !== "none") keepInView(S.spans[i], scrollMode === "force");
}

// Keep the word within the middle third of the window below the sticky bar.
function keepInView(span, force) {
  if (!force && Date.now() < S.pausedUntil) return;
  const r = span.getBoundingClientRect();
  const top = stickyTop();
  const third = (window.innerHeight - top) / 3;
  if (r.top >= top + third && r.bottom <= top + 2 * third) return;
  span.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
}

// scrollIntoView centres in the part of the window the sticky bar doesn't cover: the bar's
// height is the page's scroll padding, kept up to date as the bar grows (a repairs line, a
// wrapped title) or shrinks.
function trackBarHeight() {
  syncStickyTop();
  if (typeof ResizeObserver !== "function") return;
  const watch = new ResizeObserver(syncStickyTop);
  watch.observe($("bar"));
  watch.observe($("repair-panel")); // sticky under the bar while open
}

function syncStickyTop() {
  document.documentElement.style.setProperty("--bar-h", `${$("bar").offsetHeight}px`);
  document.documentElement.style.scrollPaddingTop = `${stickyTop()}px`;
}

// How much of the top of the window sticky things cover: the bar, and the repair panel when
// it is open.
function stickyTop() {
  const panel = $("repair-panel");
  return $("bar").offsetHeight + (panel.hidden ? 0 : panel.offsetHeight);
}

function tick() {
  if (S.stopAtMs !== null && S.ep && S.ep.has_audio && currentMs() >= S.stopAtMs) {
    S.stopAtMs = null;
    audio.pause();
  }
  setCurrent(wordIndexAt(currentMs() + 30), "auto");
}

function frameLoop() {
  tick();
  S.raf = audio.paused || audio.ended ? 0 : requestAnimationFrame(frameLoop);
}

function startFrames() {
  if (!S.raf) S.raf = requestAnimationFrame(frameLoop);
}

function stopFrames() {
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
}

function seekMs(ms, { play }) {
  S.stopAtMs = null; // a seek by hand ends a repair's "Play"
  ms = Math.max(0, ms);
  if (S.ep && S.ep.has_audio) {
    try {
      audio.currentTime = ms / 1000;
    } catch {
      // metadata not loaded yet; loadedmetadata applies the pending start
    }
    if (play) audio.play().catch(() => {});
  } else {
    S.virtualMs = ms;
  }
  const i = wordIndexAt(ms + 30);
  setCurrent(i, "force");
  // Before the first word (music at the start) there is no word to bring into view.
  if (i < 0) window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function seekWord(i, play) {
  if (i >= 0 && i < S.words.length) seekMs(S.words[i][1], { play });
}

function pauseAutoScroll() {
  S.pausedUntil = Date.now() + SCROLL_PAUSE_MS;
}

function togglePlay() {
  if (!S.ep || !S.ep.has_audio) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function jumpChunk(dir) {
  if (!S.breaks.length) return;
  const times = S.breaks.map((i) => S.words[i][1]);
  const now = currentMs();
  if (dir > 0) {
    const next = times.find((t) => t > now + 50);
    if (next !== undefined) seekMs(next, { play: false });
    return;
  }
  let k = wordIndexOfLast(times, now + 50);
  if (k >= 0 && now - times[k] < 2000) k -= 1;
  seekMs(times[Math.max(k, 0)], { play: false });
}

// Index of the last element <= v in an ascending array (-1 if none).
function wordIndexOfLast(arr, v) {
  let k = -1;
  for (let j = 0; j < arr.length && arr[j] <= v; j++) k = j;
  return k;
}

function nextLowWord() {
  const k = lowerBound(S.lowIdx, S.cur + 1);
  if (k < S.lowIdx.length) seekWord(S.lowIdx[k], false);
  else setStatus("No more unsure words after this point.");
}

function prevLowWord() {
  const k = lowerBound(S.lowIdx, S.cur) - 1; // the last one before the current word
  if (k >= 0) seekWord(S.lowIdx[k], false);
  else setStatus("No unsure words before this point.");
}

// ------------------------------------------------- selection and keyboard

// Word index at one edge of a range, or null if it can't be told quickly.
function edgeIndex(node, offset, isStart) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    const span = parent && parent.closest("[data-i]");
    if (span) {
      const i = Number(span.dataset.i);
      if (isStart && offset >= node.length) return i + 1;
      if (!isStart && offset === 0) return i - 1;
      return i;
    }
    // A space between words.
    const sib = isStart ? node.nextElementSibling : node.previousElementSibling;
    return sib && sib.dataset.i !== undefined ? Number(sib.dataset.i) : null;
  }
  if (node.nodeType === Node.ELEMENT_NODE && node.dataset && node.dataset.i !== undefined) {
    const i = Number(node.dataset.i);
    return !isStart && offset === 0 ? i - 1 : i;
  }
  return null;
}

// The {lo, hi} word indexes of the selection, if it is inside the transcript.
function selectedWordRange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !S.words.length) return null;
  const range = sel.getRangeAt(0);
  if (!transcriptEl.contains(range.commonAncestorContainer)) return null;
  let lo = edgeIndex(range.startContainer, range.startOffset, true);
  let hi = edgeIndex(range.endContainer, range.endOffset, false);
  if (lo === null || hi === null) {
    lo = -1;
    hi = -1;
    for (let i = 0; i < S.spans.length; i++) {
      if (range.intersectsNode(S.spans[i])) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    if (lo < 0) return null;
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, S.words.length - 1);
  return lo <= hi ? { lo, hi } : null;
}

// The words lo..hi as Whisper wrote them: a rule is matched against that, never against the
// result of another rule, so for a corrected word the struck-out text is what a key must say.
// And before split words are joined: "three-eighths" is Whisper's "three" and "-eighths", the
// key `three eighths`. The server sends both as key text (`keyAt`, `joinedKey`).
function rangeText({ lo, hi }) {
  const parts = [];
  const done = new Set();
  for (let i = lo; i <= hi; i++) {
    const start = S.fixStart.has(i) ? S.fixStart.get(i) : i;
    // Struck-out text before this word: its own correction's, or words a rule deleted
    // (inside the range only).
    if (S.keyAt.has(start) && !done.has(start) && (S.fixStart.has(i) || i > lo)) {
      done.add(start);
      parts.push(S.keyAt.get(start));
    }
    if (S.fixStart.has(i)) continue;
    const t = S.joinedKey.has(i) ? S.joinedKey.get(i) : String(S.words[i][0]).trim();
    if (t) parts.push(t);
  }
  return stripPunct(parts.join(" "));
}

function onSelectionChange() {
  const r = editDialog.open || testDialog.open ? null : selectedWordRange();
  S.lastSelection = r;
  $("edit-selection").hidden = !r;
}

// With nothing selected, `e` edits the current word: after `n`, that is the unsure word.
function editSelection() {
  const r = selectedWordRange() || S.lastSelection || (S.cur >= 0 ? { lo: S.cur, hi: S.cur } : null);
  if (!r) {
    setStatus("Select the words to fix first.");
    return;
  }
  // In lower case, as a rule's key is written: matching ignores case, and a capital here only
  // invites one in the right text (which would then be used everywhere).
  openEdit(rangeText(r).toLowerCase(), "");
}

// Select whole words lo..hi, as a drag across them would.
function selectWords(lo, hi) {
  const first = S.spans[lo].firstChild;
  const last = S.spans[hi].firstChild;
  if (!first || !last) return;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Shift-click selects a word without seeking, or stretches the selection to it. On mousedown,
// before the browser makes its own selection (from wherever the last click was to here).
function onTranscriptMouseDown(e) {
  if (!e.shiftKey || e.button !== 0) return;
  const t = e.target.closest ? e.target.closest("[data-i]") : null;
  if (!t) return;
  e.preventDefault();
  const i = Number(t.dataset.i);
  const had = selectedWordRange();
  selectWords(had ? Math.min(had.lo, i) : i, had ? Math.max(had.hi, i) : i);
}

// Whether the focused element wants this key for itself. Fields and the speed menu take every
// key. A button takes Space and Enter, the audio controls Space and the arrows (they seek), so
// `n`, `[`, `]` and `e` (and the arrows after a click on a time label) still reach the page
// after a click left focus there.
function typingTarget(t, key) {
  if (!t) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return true;
  if (t.tagName === "BUTTON") return key === " " || key === "Enter";
  if (t.tagName === "AUDIO") return key === " " || key === "ArrowLeft" || key === "ArrowRight";
  return false;
}

function onKeyDown(e) {
  // Keys that scroll the page by hand pause the auto-scroll.
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
    pauseAutoScroll();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (editDialog.open || testDialog.open || typingTarget(e.target, e.key)) return;
  if (!S.ep) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekMs(currentMs() - SEEK_STEP_S * 1000, { play: false });
      break;
    case "ArrowRight":
      e.preventDefault();
      seekMs(currentMs() + SEEK_STEP_S * 1000, { play: false });
      break;
    case "[":
      jumpChunk(-1);
      break;
    case "]":
      jumpChunk(1);
      break;
    case "n":
      nextLowWord();
      break;
    case "N": // Shift-n
      prevLowWord();
      break;
    case "e":
      e.preventDefault();
      editSelection();
      break;
    case "t":
      e.preventDefault();
      openTest();
      break;
    default:
  }
}

function onTranscriptClick(e) {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // ending a selection is not a seek
  const t = e.target.closest ? e.target.closest("[data-i], button.time") : null;
  if (!t) return;
  if (t.dataset.i !== undefined) seekWord(Number(t.dataset.i), true);
  else seekMs(Number(t.dataset.ms), { play: true });
}

// --------------------------------------------------------- the edit dialog

const edit = { last: null }; // what was last previewed: {key, value, scope, digest, count}

function editInputs() {
  return {
    key: $("edit-wrong").value.trim(),
    value: $("edit-right").value.trim(),
    scope: $("edit-scope-episode").checked ? "episode" : "all",
  };
}

function updateSaveState() {
  const cur = editInputs();
  const p = edit.last;
  const same = p && p.key === cur.key && p.value === cur.value && p.scope === cur.scope;
  if (!same && p) {
    edit.last = null;
    $("edit-preview").replaceChildren();
  }
  const save = $("edit-save");
  save.disabled = !(same && p.count > 0);
  save.title = !save.disabled ? "" : same ? "This rule changes nothing" : "Preview the rule first";
}

function setEditError(text) {
  const e = $("edit-error");
  e.textContent = text || "";
  e.hidden = !text;
}

function openEdit(wrong, right) {
  edit.last = null;
  $("edit-wrong").value = wrong || "";
  $("edit-right").value = right || "";
  $("edit-scope-all").checked = true;
  $("edit-preview").replaceChildren();
  setEditError("");
  updateSaveState();
  $("edit-selection").hidden = true;
  editDialog.showModal();
  (wrong ? $("edit-right") : $("edit-wrong")).focus();
}

// The page outlives its server: stopping `wts review`, or starting it for another episode,
// leaves this tab open with nothing behind it.
const SERVER_GONE = "This page's review server has stopped. Run `wts review` again and use the page it opens.";

function errorSentence(r, action) {
  if (r.status === 0) return SERVER_GONE;
  const slug = r.data && r.data.error;
  if (slug === "exists") return "That rule is already in corrections.yaml.";
  if (slug === "changed") return "The transcripts changed since the preview. Preview again.";
  if (action === "preview") {
    if (r.status === 400) return "That rule isn't valid. Check both texts.";
    return "Couldn't preview. Nothing was changed.";
  }
  return "Couldn't save. Nothing was changed.";
}

// Common prefix and suffix, word by word.
function diffWords(before, after) {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return {
    pre: a.slice(0, pre),
    suf: a.slice(a.length - suf),
    del: a.slice(pre, a.length - suf),
    ins: b.slice(pre, b.length - suf),
  };
}

function diffLine(label, d, side) {
  const line = el("p", "line");
  line.append(el("span", "label", label));
  const mid = side === "before" ? d.del : d.ins;
  const tag = side === "before" ? "del" : "ins";
  const pieces = [];
  if (d.pre.length) pieces.push(document.createTextNode(d.pre.join(" ")));
  if (mid.length) pieces.push(el(tag, "", mid.join(" ")));
  if (d.suf.length) pieces.push(document.createTextNode(d.suf.join(" ")));
  pieces.forEach((p, k) => {
    if (k > 0) line.append(" ");
    line.append(p);
  });
  return line;
}

function renderPreview(data) {
  const box = $("edit-preview");
  box.replaceChildren();
  const n = data.count;
  const text = n === 0 ? "This rule changes nothing." : n === 1 ? "1 sentence changes" : `${n} sentences change`;
  box.append(el("p", "count", text));
  if (n === 0) {
    box.append(el("p", "hint", "The wrong text must be what Whisper wrote (the struck-out words), not words another rule already corrected. A hyphenated word is two words: three eighths, not three-eighths."));
  }
  const changes = data.changes || [];
  if (changes.length < n) box.append(el("p", "hint", `Showing the first ${changes.length}.`));
  const ul = el("ul");
  for (const c of changes) {
    const li = el("li");
    li.append(el("div", "where", `${c.stem} · ${fmtTime(c.start_ms)}`));
    const d = diffWords(String(c.before), String(c.after));
    li.append(diffLine("Before", d, "before"), diffLine("After", d, "after"));
    ul.append(li);
  }
  box.append(ul);
}

async function previewEdit() {
  const cur = editInputs();
  setEditError("");
  if (!cur.key) {
    setEditError("Enter the wrong text first.");
    return;
  }
  const btn = $("edit-preview-btn");
  btn.disabled = true;
  const r = await api("/api/corrections/preview", {
    key: cur.key,
    value: cur.value,
    episode_id: cur.scope === "episode" ? S.ep.id : null,
  });
  btn.disabled = false;
  if (r.status !== 200 || !r.data) {
    edit.last = null;
    $("edit-preview").replaceChildren();
    setEditError(errorSentence(r, "preview"));
    updateSaveState();
    return;
  }
  edit.last = { ...cur, digest: r.data.digest, count: r.data.count };
  renderPreview(r.data);
  updateSaveState();
}

async function saveEdit() {
  const p = edit.last;
  if (!p) return;
  setEditError("");
  $("edit-save").disabled = true;
  $("edit-preview-btn").disabled = true;
  const r = await api("/api/corrections", {
    key: p.key,
    value: p.value,
    episode_id: p.scope === "episode" ? S.ep.id : null,
    digest: p.digest,
    open_episode_id: S.ep.id,
  });
  $("edit-preview-btn").disabled = false;
  if (r.status !== 200 || !r.data || !r.data.episode) {
    if (r.data && r.data.error === "changed") {
      edit.last = null;
      $("edit-preview").replaceChildren();
    }
    setEditError(errorSentence(r, "save"));
    updateSaveState();
    return;
  }
  render(r.data, true);
  editDialog.close();
  setStatus("Saved to corrections.yaml. Other episodes change on the next `wts chunk`.");
}

// ---------------------------------------------------- the test-search dialog

// The passage a test search is about: {lo, hi} words, its time, and whether the kind and tabs
// were chosen by hand (then a changed query or "should" no longer re-guesses them).
const test = { lo: 0, hi: 0, atMs: 0, tagTouched: false, modeTouched: false };
const GUESS_WINDOW_MS = 60_000;
const FILTER_RE = /\b(year|ep|before|after):/i;

// With nothing selected, `t` takes the current word and the sentence or so around it.
function openTest() {
  const sel = selectedWordRange() || S.lastSelection;
  if (!sel && S.cur < 0) {
    setStatus("Play or click to a passage first.");
    return;
  }
  const lo = sel ? sel.lo : Math.max(0, S.cur - 12);
  const hi = sel ? sel.hi : Math.min(S.words.length - 1, S.cur + 30);
  test.lo = lo;
  test.hi = hi;
  test.atMs = S.words[sel ? lo : S.cur][1];
  test.tagTouched = false;
  test.modeTouched = false;
  $("test-where").textContent = `Episode ${S.ep.number} at ${fmtTime(test.atMs)}`;
  $("test-passage").textContent = S.words.slice(lo, hi + 1).map((w) => String(w[0]).trim()).join(" ");
  $("test-query").value = "";
  $("test-want-find").checked = true;
  $("test-any-time").checked = false;
  $("test-mode").value = "both";
  $("test-result").replaceChildren();
  setTestError("");
  guessTest();
  $("edit-selection").hidden = true;
  testDialog.showModal();
  $("test-query").focus();
}

function testInputs() {
  return {
    query: $("test-query").value.trim(),
    absent: $("test-want-absent").checked,
    at_ms: $("test-any-time").checked ? null : test.atMs,
    tag: $("test-tag").value,
    mode: $("test-mode").value,
  };
}

// Whether every query word is said within a minute of the passage. The server compares stems as
// Exact search does ("calculation" matches "calculator"); unreachable, whole words are compared.
async function saidNearby(query) {
  const near = S.words.filter((w) => Math.abs(w[1] - test.atMs) <= GUESS_WINDOW_MS).map((w) => String(w[0]).trim());
  const r = await api("/api/eval/said", { query, text: near.join(" ") });
  if (r.status === 200 && r.data && typeof r.data.said === "boolean") return r.data.said;
  const have = new Set(near.map(normWord));
  return query.split(/\s+/).map(normWord).filter(Boolean).every((w) => have.has(w));
}

// A filter if the query has one, negative for "not return it", exact if every word is said
// near the passage, otherwise paraphrase. Jargon is left to the maintainer.
async function guessTag(query, absent) {
  if (absent) return "negative";
  if (FILTER_RE.test(query)) return "filter";
  if (!query) return "paraphrase";
  return (await saidNearby(query)) ? "exact" : "paraphrase";
}

let guessSeq = 0;
let guessTimer = 0;

// Typing waits a moment before asking the server; the latest question's answer wins.
function guessTest({ wait = false } = {}) {
  const cur = testInputs();
  // A passage that shouldn't come back is usually a Related mistake: Exact only returns the words.
  if (!test.modeTouched) $("test-mode").value = cur.absent ? "related" : "both";
  if (test.tagTouched) return;
  clearTimeout(guessTimer);
  const seq = ++guessSeq;
  const run = async () => {
    const tag = await guessTag(cur.query, cur.absent);
    if (seq === guessSeq && !test.tagTouched) $("test-tag").value = tag;
  };
  if (wait) guessTimer = setTimeout(run, 150);
  else run();
}

function setTestError(text) {
  const e = $("test-error");
  e.textContent = text || "";
  e.hidden = !text;
}

function testErrorSentence(r, action) {
  if (r.status === 0) return SERVER_GONE;
  const slug = r.data && r.data.error;
  if (slug === "no_environment") return "Checking needs run_env, and its api_url, in config.toml. You can still save.";
  if (slug === "search_failed") return "The search didn't answer (offline, or too many searches in a minute). Try again.";
  if (slug === "degraded") return "Related search is degraded right now (its budget, or Workers AI). Try later.";
  if (slug === "exists") return "That test search is already in eval/queries.yaml.";
  if (slug === "edit_failed") return "eval/queries.yaml doesn't load, so nothing was added. Fix the file first.";
  if (r.status === 400) return "Enter what you'd search for first.";
  return action === "check" ? "Couldn't check." : "Couldn't save. Nothing was changed.";
}

function rankText(found, top) {
  if (found.rank !== null && found.rank !== undefined) {
    return found.rank <= top ? `#${found.rank}` : `#${found.rank}, outside the top ${top}`;
  }
  if (found.episode_rank !== null && found.episode_rank !== undefined) {
    return `not this passage (the episode is #${found.episode_rank})`;
  }
  return "not in the results";
}

function renderTestResult(data, cur) {
  const box = $("test-result");
  box.replaceChildren();
  const modes = cur.mode === "both" ? ["exact", "related"] : [cur.mode];
  const top = data.top;
  const inTop = modes.some((m) => data[m].rank !== null && data[m].rank <= top);
  let verdict;
  if (cur.absent) {
    verdict = inTop ? "Fails now: the search returns it. Shows whether a change fixes that." : "Passes now: it stays out.";
  } else {
    verdict = inTop ? "Passes now: guards against a change that breaks it." : `A miss now: not in the top ${top}. Shows whether a change helps.`;
  }
  box.append(el("p", "verdict", verdict));
  for (const m of ["exact", "related"]) {
    const name = m === "exact" ? "Exact" : "Related";
    const note = modes.includes(m) ? "" : " (not tested)";
    box.append(el("p", "", `${name}: ${rankText(data[m], top)}${note}`));
  }
}

async function checkTest() {
  const cur = testInputs();
  setTestError("");
  if (!cur.query) {
    setTestError("Enter what you'd search for first.");
    return;
  }
  const btn = $("test-check");
  btn.disabled = true;
  $("test-result").replaceChildren(el("p", "hint", "Searching…"));
  const r = await api("/api/eval/check", { query: cur.query, episode_id: S.ep.id, at_ms: cur.at_ms });
  btn.disabled = false;
  if (r.status !== 200 || !r.data || !r.data.exact) {
    $("test-result").replaceChildren();
    setTestError(testErrorSentence(r, "check"));
    return;
  }
  renderTestResult(r.data, cur);
}

async function saveTest() {
  const cur = testInputs();
  setTestError("");
  if (!cur.query) {
    setTestError("Enter what you'd search for first.");
    return;
  }
  const btn = $("test-save");
  btn.disabled = true;
  const r = await api("/api/eval", { ...cur, episode_id: S.ep.id });
  btn.disabled = false;
  if (r.status !== 200 || !r.data || !r.data.id) {
    setTestError(testErrorSentence(r, "save"));
    return;
  }
  testDialog.close();
  setStatus(`Added the test search ${r.data.id} to eval/queries.yaml. Commit it with the rest.`);
}

// -------------------------------------------------------- the report panel

// Mark the report's quoted words in the transcript, if they are found as a
// consecutive run (lowercased, punctuation stripped), nearest to the time
// the page was opened at.
function markReported() {
  for (const span of transcriptEl.querySelectorAll(".reported")) span.classList.remove("reported");
  const rep = S.report;
  if (!rep || !rep.quoted_text || !S.words.length) return;
  const quote = rep.quoted_text.split(/\s+/).map(normWord).filter(Boolean);
  if (!quote.length) return;

  const idx = [];
  const norm = [];
  S.words.forEach((w, i) => {
    const n = normWord(String(w[0]));
    if (n) {
      idx.push(i);
      norm.push(n);
    }
  });

  const near = atParam !== null && atParam !== "" && !Number.isNaN(Number(atParam)) ? Number(atParam) : rep.start_ms;
  let best = -1;
  let bestDist = Infinity;
  for (let j = 0; j + quote.length <= norm.length; j++) {
    let ok = true;
    for (let k = 0; k < quote.length; k++) {
      if (norm[j + k] !== quote[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const dist = typeof near === "number" ? Math.abs(S.starts[idx[j]] - near) : j;
    if (dist < bestDist) {
      best = j;
      bestDist = dist;
    }
  }
  if (best < 0) return;
  for (let k = 0; k < quote.length; k++) S.spans[idx[best + k]].classList.add("reported");
}

function renderReport() {
  const rep = S.report;
  const body = $("report-body");
  body.replaceChildren();
  const row = (term, value) => {
    body.append(el("dt", "", term), el("dd", "", value));
  };
  if (rep.quoted_text) row("Quoted text", rep.quoted_text);
  if (rep.suggested_text) row("Suggestion", rep.suggested_text);
  if (rep.note) row("Note", rep.note);
  row("Status", rep.status);
  if (rep.created_at) row("Reported", rep.created_at);
  $("report-heading").textContent = `Listener report #${rep.id}`;
  $("report-reopen").hidden = rep.status === "open";
  $("report-edit").disabled = !rep.quoted_text;
}

function setReportError(text) {
  const e = $("report-error");
  e.textContent = text || "";
  e.hidden = !text;
}

function reportErrorSentence(r) {
  if (r.status === 503) return "Reports need an environment (`--env` or `run_env`).";
  if (r.status === 404) return "No such report.";
  return "Couldn't reach the report. Nothing was changed.";
}

async function loadReport() {
  $("report-panel").hidden = false;
  for (const id of ["report-resolve", "report-reject", "report-reopen", "report-edit"]) $(id).hidden = false;
  const r = await api(`/api/report?id=${encodeURIComponent(reportParam)}`);
  if (r.status !== 200 || !r.data) {
    setReportError(reportErrorSentence(r));
    for (const id of ["report-resolve", "report-reject", "report-reopen", "report-edit"]) $(id).hidden = true;
    return;
  }
  S.report = r.data;
  renderReport();
  markReported();
}

async function setReportStatus(status) {
  setReportError("");
  const r = await api("/api/report", { id: S.report.id, status });
  if (r.status !== 200 || !r.data) {
    setReportError(reportErrorSentence(r));
    return;
  }
  S.report.status = r.data.status || status;
  renderReport();
}

// ------------------------------------------------------- the repairs panel

// A repair is a stretch Whisper left out (a hole) that a fresh pass over the audio filled. The
// transcript the page shows has the accepted repairs spliced in already (S.words); `index` is
// where the repair's words start in it.
const CONTEXT_WORDS = 12;
const PLAY_LEAD_MS = 2000;
const PLAY_TAIL_MS = 1000;
const NO_END_MS = 2 ** 31; // "to_ms" of a repair with nothing after it

const isApplied = (r) => r.status === "accepted" || r.status === "auto";
const wordText = (w) => String(w[0]).trim();

function repairMark(r) {
  return isApplied(r) ? " ✓" : r.status === "rejected" ? " ✕" : "";
}

function renderRepairs(repairs) {
  S.repairs = Array.isArray(repairs) ? repairs : [];
  const list = $("repairs-list");
  list.replaceChildren();
  for (const r of S.repairs) {
    const b = el("button", "", `${fmtTime(r.hole[0])}${repairMark(r)}`);
    b.type = "button";
    b.title = `${r.status}: open this repair`;
    b.dataset.id = r.id;
    if (r.id === S.repairOpen) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => openRepair(r.id, true));
    list.append(b);
  }
  $("repairs").hidden = !S.repairs.length;
  if (S.repairOpen !== null && !S.repairs.some((r) => r.id === S.repairOpen)) S.repairOpen = null;
  renderRepairPanel();
}

function openRepairIndex() {
  return S.repairs.findIndex((r) => r.id === S.repairOpen);
}

// Words as text, with a space between pieces; `kind` makes the wrapper element, if any.
function addWords(parent, texts, tag) {
  if (!texts.length) return;
  if (parent.childNodes.length) parent.append(" ");
  const joined = texts.join(" ");
  parent.append(tag ? el(tag, "", joined) : document.createTextNode(joined));
}

// How many words of S.words the repair covers now: its own (accepted) or the transcript's.
function coveredNow(r) {
  return isApplied(r) ? r.after.length : r.before.length;
}

function renderRepairPanel() {
  const k = openRepairIndex();
  const panel = $("repair-panel");
  panel.hidden = k < 0;
  markRepairSpan();
  if (k < 0) return;
  const r = S.repairs[k];
  const applied = isApplied(r);
  const at = Math.min(Math.max(repairAt(r), 0), S.words.length);
  const afterCount = r.after.length;
  const covered = coveredNow(r);
  const left = S.words.slice(Math.max(0, at - CONTEXT_WORDS), at).map(wordText);
  const right = S.words.slice(at + covered, at + covered + CONTEXT_WORDS).map(wordText);

  $("repair-heading").textContent = `Repair ${k + 1} of ${S.repairs.length} · ${fmtTime(r.hole[0])}–${fmtTime(r.hole[1])}`;
  $("repair-state").textContent = r.status === "proposed" ? "" : r.status;
  $("repair-prev").disabled = k === 0;
  $("repair-next").disabled = k === S.repairs.length - 1;

  // Left: the transcript. Once the repair is accepted the page's words already hold the fresh
  // ones, so this column is rebuilt as the transcript was (the repair's `before` words, or the
  // gap, between the same context) and its heading says so.
  $("repair-now-heading").textContent = applied ? "Transcript before" : "Transcript now";
  const now = $("repair-now");
  now.replaceChildren();
  addWords(now, left);
  if (r.before.length) {
    addWords(now, r.before, "del");
  } else {
    const secs = Math.max(1, Math.round((r.hole[1] - r.hole[0]) / 1000));
    if (now.childNodes.length) now.append(" ");
    now.append(el("span", "gap", `⋯ ${secs} s ⋯`));
  }
  addWords(now, right);

  const fresh = $("repair-fresh");
  fresh.replaceChildren();
  addWords(fresh, left);
  addWords(fresh, r.after.map(wordText), "mark");
  addWords(fresh, right);
  if (!afterCount) fresh.append(" ", el("span", "gap", "⋯"));

  $("repair-rule").textContent = r.fails.length ? `The rule would ask: fails ${r.fails.join(", ")}` : "The rule would apply this";
  $("repair-play").disabled = !(S.ep && S.ep.has_audio);
  $("repair-accept").hidden = applied;
  $("repair-reject").hidden = r.status === "rejected";
  $("repair-undo").hidden = r.status === "proposed";
}

// Mark the stretch in the transcript: the repair's words, or when it has none there (a hole
// in the transcript), the words either side of the gap.
function markRepairSpan() {
  for (const span of transcriptEl.querySelectorAll(".repairing")) span.classList.remove("repairing");
  const k = openRepairIndex();
  if (k < 0) return;
  const r = S.repairs[k];
  const n = coveredNow(r);
  const at = repairAt(r);
  const lo = n ? at : at - 1;
  const hi = n ? at + n - 1 : at;
  for (let i = Math.max(lo, 0); i <= hi && i < S.spans.length; i++) S.spans[i].classList.add("repairing");
}

// `scroll`: opened by hand (the repairs line, ◀ ▶), so the player and the transcript go to the
// stretch, as a weak spot's button does; re-renders after a decision leave both where they are.
function openRepair(id, scroll) {
  S.repairOpen = id;
  setRepairError("");
  renderRepairs(S.repairs);
  if (!scroll) return;
  syncStickyTop(); // the panel just opened: centre things below it, not behind it
  const r = S.repairs[openRepairIndex()];
  if (r) seekMs(Math.max(0, repairRange(r).from - PLAY_LEAD_MS), { play: false });
  const first = transcriptEl.querySelector(".repairing");
  if (!first) return;
  pauseAutoScroll();
  first.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function stepRepair(dir) {
  const next = S.repairs[openRepairIndex() + dir];
  if (next) openRepair(next.id, true);
}

function closeRepair() {
  S.repairOpen = null;
  setRepairError("");
  renderRepairs(S.repairs);
}

// The repair's position in S.words (payload.words): the server's `at`, found by time. (`index`
// counts the words before repairs, corrections and joins, so it drifts.)
function repairAt(r) {
  return Number.isInteger(r.at) ? r.at : r.index;
}

// The stretch a repair covers: the earliest to the latest of its bounds, the hole and the fresh
// words. `from_ms` alone can be late: Whisper often stretches the word before a skip over it.
function repairRange(r) {
  const first = r.after.length ? r.after[0][1] : r.hole[0];
  const last = r.after.length ? r.after[r.after.length - 1][2] : r.hole[1];
  return {
    from: Math.min(r.from_ms >= 0 ? r.from_ms : r.hole[0], r.hole[0], first),
    to: Math.max(r.to_ms >= 0 && r.to_ms < NO_END_MS ? r.to_ms : r.hole[1], r.hole[1], last),
  };
}

// From 2 s before the stretch to 1 s after it.
function playRepair() {
  const r = S.repairs[openRepairIndex()];
  if (!r || !S.ep || !S.ep.has_audio) return;
  const { from, to } = repairRange(r);
  seekMs(Math.max(0, from - PLAY_LEAD_MS), { play: true });
  S.stopAtMs = to + PLAY_TAIL_MS;
}

function setRepairError(text) {
  const e = $("repair-error");
  e.textContent = text || "";
  e.hidden = !text;
}

function repairErrorSentence(r) {
  if (r.status === 0) return SERVER_GONE;
  if (r.status === 409) return "The repairs were made for another transcript. Run `wts repair` again.";
  return "Couldn't save. Nothing was changed.";
}

async function decideRepair(status) {
  const r = S.repairs[openRepairIndex()];
  if (!r) return;
  setRepairError("");
  const buttons = ["repair-accept", "repair-reject", "repair-undo"].map($);
  for (const b of buttons) b.disabled = true;
  const res = await api("/api/repair", { episode_id: S.ep.id, repair_id: r.id, status });
  for (const b of buttons) b.disabled = false;
  if (res.status !== 200 || !res.data || !res.data.episode) {
    setRepairError(repairErrorSentence(res));
    return;
  }
  render(res.data, true);
  const done = { accepted: "Fresh pass used.", rejected: "Transcript kept.", proposed: "Decision undone." };
  setStatus(`${done[status]} The transcript is chunked again.`);
}

// ----------------------------------------------------------------- startup

async function toggleReviewed() {
  const b = $("reviewed");
  const want = b.getAttribute("aria-pressed") !== "true";
  b.disabled = true;
  const r = await api("/api/reviewed", { episode_id: S.ep.id, reviewed: want });
  b.disabled = false;
  if (r.status !== 200 || !r.data) {
    setStatus(r.status === 0 ? SERVER_GONE : "Couldn't change the reviewed mark. Nothing was changed.");
    return;
  }
  S.ep.reviewed_at = want ? r.data.reviewed_at || "yes" : null;
  renderReviewedButton();
}

function wire() {
  audio.addEventListener("timeupdate", tick);
  audio.addEventListener("play", startFrames);
  audio.addEventListener("pause", () => {
    stopFrames();
    tick();
  });
  audio.addEventListener("ended", stopFrames);
  audio.addEventListener("seeked", tick);

  $("speed").addEventListener("change", (e) => {
    const v = e.target.value;
    if (SPEEDS_OK.has(v)) audio.playbackRate = Number(v);
    e.target.blur(); // a focused menu would swallow the page's keys
  });
  $("boost").addEventListener("change", (e) => {
    const v = e.target.value;
    if (BOOSTS_OK.has(v)) {
      setBoost(Number(v));
      if (S.ep) store(boostKey(S.ep), v === "1" ? null : v);
    }
    e.target.blur();
  });
  audio.addEventListener("play", resumeBoost);

  window.addEventListener("wheel", pauseAutoScroll, { passive: true });
  window.addEventListener("touchmove", pauseAutoScroll, { passive: true });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("selectionchange", onSelectionChange);
  transcriptEl.addEventListener("mousedown", onTranscriptMouseDown);
  transcriptEl.addEventListener("click", onTranscriptClick);

  $("reviewed").addEventListener("click", toggleReviewed);
  $("episode-pick").addEventListener("change", (e) => openEpisode(e.target.value));
  const editBtn = $("edit-selection");
  editBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  editBtn.addEventListener("click", editSelection);

  $("edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    previewEdit();
  });
  $("edit-save").addEventListener("click", saveEdit);
  $("edit-cancel").addEventListener("click", () => editDialog.close());
  for (const id of ["edit-wrong", "edit-right"]) {
    $(id).addEventListener("input", updateSaveState);
    $(id).addEventListener("change", updateSaveState);
  }
  // The other scope is one click away from a preview that was just read, so it is previewed
  // at once; a changed text waits for the Preview button.
  for (const id of ["edit-scope-all", "edit-scope-episode"]) {
    $(id).addEventListener("change", () => {
      const previewed = edit.last !== null;
      updateSaveState();
      if (previewed) previewEdit();
    });
  }
  editDialog.addEventListener("close", onSelectionChange);

  const testBtn = $("add-test");
  testBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  testBtn.addEventListener("click", openTest);
  $("test-form").addEventListener("submit", (e) => {
    e.preventDefault();
    checkTest();
  });
  $("test-save").addEventListener("click", saveTest);
  $("test-cancel").addEventListener("click", () => testDialog.close());
  $("test-query").addEventListener("input", () => {
    $("test-result").replaceChildren(); // the result was for other words
    guessTest({ wait: true });
  });
  for (const id of ["test-want-find", "test-want-absent", "test-any-time"]) {
    $(id).addEventListener("change", () => {
      $("test-result").replaceChildren();
      guessTest();
    });
  }
  $("test-tag").addEventListener("change", () => (test.tagTouched = true));
  $("test-mode").addEventListener("change", () => {
    test.modeTouched = true;
    $("test-result").replaceChildren();
  });
  testDialog.addEventListener("close", onSelectionChange);

  $("repair-prev").addEventListener("click", () => stepRepair(-1));
  $("repair-next").addEventListener("click", () => stepRepair(1));
  $("repair-close").addEventListener("click", closeRepair);
  $("repair-play").addEventListener("click", playRepair);
  $("repair-accept").addEventListener("click", () => decideRepair("accepted"));
  $("repair-reject").addEventListener("click", () => decideRepair("rejected"));
  $("repair-undo").addEventListener("click", () => decideRepair("proposed"));

  $("report-resolve").addEventListener("click", () => setReportStatus("resolved"));
  $("report-reject").addEventListener("click", () => setReportStatus("rejected"));
  $("report-reopen").addEventListener("click", () => setReportStatus("open"));
  $("report-edit").addEventListener("click", () => {
    if (S.report) openEdit(S.report.quoted_text || "", S.report.suggested_text || "");
  });
}

// The episode menu: every transcribed episode, newest first. Picking one opens it in this tab,
// from its start (a time or a report belongs to the episode they came with).
async function loadEpisodeMenu() {
  const r = await api("/api/episodes");
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.episodes)) return;
  const pick = $("episode-pick");
  for (const ep of r.data.episodes) {
    const marks = [ep.date, ep.flagged ? "flagged" : "", ep.reviewed ? "reviewed" : ""].filter(Boolean);
    const name = ep.number !== null && ep.number !== undefined ? `${ep.number}. ${ep.title}` : ep.title;
    const option = el("option", "", `${name} (${marks.join(", ")})`);
    option.value = String(ep.id);
    if (String(ep.id) === episodeParam) option.disabled = true; // the one open now
    pick.append(option);
  }
  pick.disabled = false; // there from the start, so the header doesn't move when the list comes
}

function openEpisode(id) {
  if (!id || id === episodeParam) return;
  const next = new URLSearchParams({ t: token, episode: id });
  location.assign(`/?${next}`);
}

function loadErrorSentence(r) {
  if (r.status === 401) return "This link's token is wrong or missing. Start `wts review` again.";
  if (r.status === 404) return "No such episode.";
  if (r.status === 409) return "This episode has no transcript yet.";
  if (r.status === 0) return "Couldn't reach the review server. Start `wts review` again.";
  return "Couldn't load the episode.";
}

// Open at the `at` time without playing (browsers block unprompted playback).
function openAt(ms) {
  seekMs(ms, { play: false });
  if (S.ep.has_audio) {
    audio.addEventListener(
      "loadedmetadata",
      () => {
        if (Math.abs(audio.currentTime * 1000 - ms) > 500) audio.currentTime = ms / 1000;
      },
      { once: true },
    );
  }
}

async function start() {
  wire();
  loadEpisodeMenu(); // also on a page whose episode doesn't load: it is the way out
  if (reportParam !== null) $("report-panel").hidden = false;
  if (!episodeParam) {
    showMessage("No episode in the link. Start `wts review` again.");
    $("title").textContent = "Wood Talk review";
    return;
  }
  const r = await api(`/api/episode?id=${encodeURIComponent(episodeParam)}`);
  if (r.status !== 200 || !r.data || !r.data.episode) {
    $("title").textContent = "Wood Talk review";
    showMessage(loadErrorSentence(r));
    $("report-panel").hidden = true;
    return;
  }
  render(r.data, false);
  trackBarHeight(); // after render: the bar has its final lines (weak spots, repairs)
  if (atParam !== null && atParam !== "" && !Number.isNaN(Number(atParam))) openAt(Number(atParam));
  if (reportParam !== null) loadReport();
}

start();
