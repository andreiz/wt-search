// The body of GET /api/info (spec §4.4). Types only, and no imports, so `web/` can import it
// without pulling in the Worker's runtime modules (and their Workers-only globals).

export interface InfoResponse {
  episodes: number;
  /** `YYYY-MM-DD`, or null for an empty corpus. */
  latest_episode_date: string | null;
  corpus_version: string;
  turnstile_site_key: string | null;
}
