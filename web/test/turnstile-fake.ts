// A fake Turnstile for the tests: the script element is captured instead of loaded (no network),
// `ready()` plays the script finishing by defining `window.turnstile`, and the widgets' calls are
// recorded. `token()` plays the person passing the check.
import { act } from "@testing-library/preact";
import { vi } from "vitest";
import { forgetLoad } from "../src/lib/turnstile";

export interface FakeWidget {
  id: string;
  el: HTMLElement;
  options: {
    sitekey: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  };
}

export function fakeTurnstile() {
  forgetLoad();
  const scripts: HTMLScriptElement[] = [];
  const widgets: FakeWidget[] = [];
  const resets: string[] = [];
  const removed: string[] = [];
  const real = document.head.appendChild.bind(document.head);
  const spy = vi.spyOn(document.head, "appendChild").mockImplementation(((node: Node) => {
    if (node instanceof HTMLScriptElement) {
      scripts.push(node);
      return node;
    }
    return real(node);
  }) as typeof document.head.appendChild);

  return {
    scripts,
    widgets,
    resets,
    removed,
    /** The script has loaded and defined `window.turnstile`. */
    async ready() {
      window.turnstile = {
        render(el, options) {
          const id = `widget-${widgets.length + 1}`;
          widgets.push({ id, el, options });
          return id;
        },
        reset: (id) => void resets.push(id),
        remove: (id) => void removed.push(id),
      };
      await act(async () => {
        scripts.at(-1)?.dispatchEvent(new Event("load"));
      });
    },
    /** The script failed (blocked, offline). */
    async fail() {
      await act(async () => {
        scripts.at(-1)?.dispatchEvent(new Event("error"));
      });
    },
    /** The latest widget passes its check. */
    token(value: string) {
      act(() => widgets.at(-1)!.options.callback(value));
    },
    expire() {
      act(() => widgets.at(-1)!.options["expired-callback"]());
    },
    restore() {
      spy.mockRestore();
      delete window.turnstile;
      forgetLoad();
    },
  };
}
