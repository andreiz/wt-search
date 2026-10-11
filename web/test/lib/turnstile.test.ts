// lib/turnstile.ts (spec §5.5): the script is injected once, on the first load(); a failure is not
// remembered; render, reset and remove go to window.turnstile.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load, remove, render, reset } from "../../src/lib/turnstile";
import { fakeTurnstile } from "../turnstile-fake";

let fake: ReturnType<typeof fakeTurnstile>;
beforeEach(() => {
  fake = fakeTurnstile();
});
afterEach(() => fake.restore());

describe("load", () => {
  it("injects nothing until it is called, then the explicit-render script, once", async () => {
    expect(fake.scripts).toHaveLength(0);
    const first = load();
    const second = load();
    expect(second).toBe(first);
    expect(fake.scripts).toHaveLength(1);
    expect(fake.scripts[0]!.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    await fake.ready();
    await first;
    await load();
    expect(fake.scripts).toHaveLength(1);
  });

  it("does not inject when Turnstile is already there", async () => {
    await fake.ready();
    await load();
    expect(fake.scripts).toHaveLength(0);
  });

  it("rejects when the script fails, and a later call tries again", async () => {
    const first = load();
    const settled = expect(first).rejects.toThrow();
    await fake.fail();
    await settled;
    const again = load();
    expect(fake.scripts).toHaveLength(2);
    await fake.ready();
    await again;
  });
});

describe("render, reset, remove", () => {
  it("pass the site key and the callbacks through and return the widget id", async () => {
    const onToken = vi.fn();
    const onExpire = vi.fn();
    const onError = vi.fn();
    const el = document.createElement("div");
    await fake.ready();
    const id = render(el, "SITE", onToken, onExpire, onError);
    expect(id).toBe("widget-1");
    const widget = fake.widgets[0]!;
    expect(widget.el).toBe(el);
    expect(widget.options.sitekey).toBe("SITE");
    widget.options.callback("tok");
    widget.options["expired-callback"]();
    widget.options["error-callback"]();
    expect(onToken).toHaveBeenCalledWith("tok");
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    reset(id);
    remove(id);
    expect(fake.resets).toEqual(["widget-1"]);
    expect(fake.removed).toEqual(["widget-1"]);
  });

  it("an error with no error callback of its own counts as an expiry", async () => {
    const onExpire = vi.fn();
    await fake.ready();
    render(document.createElement("div"), "SITE", () => {}, onExpire);
    fake.widgets[0]!.options["error-callback"]();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
