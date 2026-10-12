// The shapes the API sends (spec §4.4): search, context and info responses. Types only and no
// imports at all, so `web/` can import them without the Worker's runtime modules (and their
// Workers-only globals). The modules that build these answers re-export the types they used to
// own, and `deepLinks()` / `cueTimes()` in links.ts are annotated with `DeepLinks` / `CueTimes`,
// so the compiler checks that the names and the functions agree.

/** Deep links; a platform is left out when its ID is missing. */
export interface DeepLinks {
  youtube?: string;
  apple?: string;
  spotify?: string;
  /** The episode's Acast page, which plays from the cue. */
  page?: string;
  /** The episode's page on the show's own site (show notes); plays nothing, has no time. */
  notes?: string;
}

/** Where each platform should start to play, in seconds. */
export interface CueTimes {
  youtube: number;
  apple: number;
  spotify: number;
  /** The show page plays the show's own timeline: the lead-in, no offset. */
  page: number;
}

export type Sort = "relevance" | "newest" | "oldest";
/** `keyword`: the chunk matched the FTS5 query. `related`: only meaning-based search found it. */
export type Match = "keyword" | "related";

export interface SearchResult {
  episode: {
    id: number;
    number: number | null;
    title: string;
    /** `YYYY-MM-DD`, from published_at. */
    date: string;
    links: DeepLinks;
  };
  chunk_id: number;
  text: string;
  /** `[start, end)` offsets into `text` (UTF-16 code units) of the matched words. */
  ranges: [number, number][];
  hit_ms: number;
  cue_s: CueTimes;
  match: Match;
  /** Other hits from the same episode, within COLLAPSE_MS of this one (exact: on this page). */
  more_in_episode: number;
  /** The chunk ids collapsed into this result, in fold order; `folded.length === more_in_episode`. */
  folded: number[];
  /** Smart mode with `?debug=1` only. */
  debug?: ResultDebug;
}

/** Why a smart result ranked where it did (`?debug=1`). Ranks count from 1. */
export interface ResultDebug {
  /** Rank in the FTS5 top SMART_LIST_SIZE (bm25), or null. */
  keyword_rank: number | null;
  /** Rank in the Vectorize top SMART_LIST_SIZE, or null. */
  vector_rank: number | null;
  /** Vectorize's similarity (cosine), or null. */
  vector_score: number | null;
  rrf_score: number;
}

/** What fed a smart response (`?debug=1`). */
export interface SmartDebug {
  /** Hits in the keyword list (at most SMART_LIST_SIZE). */
  keyword_hits: number;
  /** Hits Vectorize returned (after dropping non-chunk ids), or null when it wasn't asked (degraded). */
  vector_hits: number | null;
  /** Meaning-based hits not shown: excluded, filtered out, boilerplate, or no such chunk. */
  dropped: number[];
}

/**
 * An episode whose title matches the query (spec §4.4, "Title hits"). Search reads the
 * transcripts; this finds a word that is only in a title.
 */
export interface EpisodeHit {
  id: number;
  number: number | null;
  title: string;
  /** `YYYY-MM-DD`, from published_at. */
  date: string;
  /** Play the episode from its start. */
  links: DeepLinks;
}

export interface ExactResponse {
  /** Matching chunks, before collapsing, up to COUNT_CAP. */
  total: number;
  /** There are more than COUNT_CAP matches: show the total as "1,000+". */
  total_capped: boolean;
  /** There are more matches than the pages show (MAX_EXACT_RESULTS): suggest narrowing the query. */
  truncated: boolean;
  page: number;
  /** The page size (`?limit=`, 1–PAGE_SIZE). */
  limit: number;
  /** Another page can be shown (never past MAX_EXACT_RESULTS). */
  has_more: boolean;
  results: SearchResult[];
  /** Episodes whose title matches, at most MAX_TITLE_HITS; `[]` after page 1. Not counted in `total`. */
  episodes: EpisodeHit[];
}

/**
 * Smart mode has no count: meaning-based search matches everything a little (spec §4.4).
 * It shows the best MAX_SMART_RESULTS hits, collapsed, then paged.
 */
export interface SmartResponse {
  page: number;
  /** The page size (`?limit=`, 1–PAGE_SIZE). */
  limit: number;
  /** Another page of the collapsed results can be shown. */
  has_more: boolean;
  results: SearchResult[];
  /** Episodes whose title matches, at most MAX_TITLE_HITS; `[]` after page 1. */
  episodes: EpisodeHit[];
  /** These are the keyword hits only, and why (spec §4.4, §4.8). */
  smart_degraded?: DegradedReason;
  /** `?debug=1` only. */
  debug?: SmartDebug;
}

/**
 * Why smart search answered with keyword hits only: Workers AI or Vectorize failed
 * ("unavailable"), the daily budget is used up ("budget"), or the kill switch turned it off
 * ("off").
 */
export type DegradedReason = "unavailable" | "budget" | "off";

export interface ContextChunk {
  chunk_id: number;
  seq: number;
  /** When `text` starts; later than the stored chunk's start if its first sentence was taken out. */
  start_ms: number;
  end_ms: number;
  /**
   * The chunk's text as a reader meets it. Stored chunks overlap by a sentence; the copy on the
   * side away from the hit is taken out (the end of a chunk before the hit, the start of one
   * after it). The hit's own text is whole.
   */
  text: string;
  /** A sponsor read or other repeated ad. Still part of the transcript, so it is included. */
  boilerplate: boolean;
  /** Where each platform should start to play this chunk (the cue at the chunk's start). */
  cue_s: CueTimes;
  links: DeepLinks;
  /**
   * The words of the request's `q` found in `text`: `[start, end)` offsets in UTF-16 code
   * units, like a search result's `ranges`. Always present; empty without `q` or a match.
   */
  ranges: [number, number][];
}

export interface ContextResponse {
  chunk_id: number;
  episode: {
    id: number;
    number: number | null;
    title: string;
    /** `YYYY-MM-DD`, from published_at. */
    date: string;
    /** Deep links at the hit chunk's start. */
    links: DeepLinks;
  };
  /** The hit and its neighbours, in the order of the episode. */
  chunks: ContextChunk[];
}

/** The body of GET /api/info (spec §4.4). */
export interface InfoResponse {
  episodes: number;
  /** `YYYY-MM-DD`, or null for an empty corpus. */
  latest_episode_date: string | null;
  corpus_version: string;
  turnstile_site_key: string | null;
}
