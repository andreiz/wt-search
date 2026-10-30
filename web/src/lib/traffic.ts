// The maintainer's switch (spec §5.7; analytics design §1.2). Opening the site with `?me=1` keeps
// one flag in local storage; while it is set, every API call carries `X-WTS-Traffic: maintainer`
// and the Worker records those searches as the maintainer's, so reports leave them out. `?me=0`
// removes it. Not a cookie: nothing is stored for visitors who never open `?me=1`.
//
// Pure: storage and the URL are passed in (main.tsx does that once, before the app mounts).

export const TRAFFIC_KEY = "wts-traffic";
const MAINTAINER = "maintainer";
const PARAM = "me";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Applies `?me=1` / `?me=0` and reads the flag. `cleanUrl` is the path, query and hash without
 * `me` (for `history.replaceState`), or null when the URL had no `me`. `counted` is false only
 * when the flag is set; storage that is missing or throws means the searches count.
 */
export function applyTrafficSwitch(url: URL, storage: FlagStorage | null): { counted: boolean; cleanUrl: string | null } {
  const value = url.searchParams.get(PARAM);
  let cleanUrl: string | null = null;
  if (value !== null) {
    const clean = new URL(url.href);
    clean.searchParams.delete(PARAM);
    cleanUrl = `${clean.pathname}${clean.search}${clean.hash}`;
  }
  try {
    if (storage === null) return { counted: true, cleanUrl };
    if (value === "1") storage.setItem(TRAFFIC_KEY, MAINTAINER);
    else if (value === "0") storage.removeItem(TRAFFIC_KEY);
    return { counted: storage.getItem(TRAFFIC_KEY) !== MAINTAINER, cleanUrl };
  } catch {
    return { counted: true, cleanUrl };
  }
}

let maintainer = false;

export function setMaintainer(on: boolean): void {
  maintainer = on;
}

export function isMaintainer(): boolean {
  return maintainer;
}

/** The header the API client adds to every call: the class only, nothing about the visitor. */
export function trafficHeaders(): Record<string, string> {
  return maintainer ? { "x-wts-traffic": MAINTAINER } : {};
}
