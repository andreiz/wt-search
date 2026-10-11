// Cloudflare Turnstile, explicit rendering (spec §4.4, §5.5). The script is the only third-party
// code on the page (CSP: https://challenges.cloudflare.com), so it is injected the first time a
// form opens and not before. `load()` shares one promise between callers; a failed load is
// forgotten, so a later call tries again.
//
// The API used is Cloudflare's client-side rendering one: `turnstile.render(el, {sitekey,
// callback, "expired-callback", "error-callback"})` returns a widget id, `reset(id)` asks for a
// new token, `remove(id)` takes the widget out (and calls no callback).

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<void> | null = null;

/** Inject the script once. Resolves when `window.turnstile` exists; rejects if the script fails. */
export function load(): Promise<void> {
  if (loading) return loading;
  const attempt = new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => (window.turnstile ? resolve() : reject(new Error("Turnstile did not start"))));
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Turnstile failed to load"));
    });
    document.head.appendChild(script);
  });
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}

/** Forget the shared load (tests only). */
export function forgetLoad(): void {
  loading = null;
}

function api(): TurnstileApi {
  if (!window.turnstile) throw new Error("Turnstile is not loaded");
  return window.turnstile;
}

/** Render a widget in `el`. `onToken` gets each new token; `onExpire` and `onError` mean there is none. */
export function render(
  el: HTMLElement,
  siteKey: string,
  onToken: (token: string) => void,
  onExpire: () => void,
  onError: () => void = onExpire,
): string {
  return api().render(el, {
    sitekey: siteKey,
    callback: onToken,
    "expired-callback": onExpire,
    "error-callback": onError,
  });
}

/** Ask the widget for a new token (a token works once). */
export function reset(id: string): void {
  api().reset(id);
}

export function remove(id: string): void {
  api().remove(id);
}
