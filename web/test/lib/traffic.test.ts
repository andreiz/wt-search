// The maintainer's switch (spec §5.7; analytics design §1.2): `?me=1` marks this browser's
// searches as not counted, `?me=0` undoes it. Storage that throws must never break the page.
import { afterEach, describe, expect, it } from "vitest";
import { applyTrafficSwitch, isMaintainer, setMaintainer, TRAFFIC_KEY, trafficHeaders } from "../../src/lib/traffic";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

const denied = () => {
  throw new Error("denied");
};
const THROWING = { getItem: denied, setItem: denied, removeItem: denied };

afterEach(() => setMaintainer(false));

describe("applyTrafficSwitch", () => {
  it("?me=1 stores the flag and strips the parameter", () => {
    const s = memoryStorage();
    expect(applyTrafficSwitch(new URL("https://x.test/?q=glue&me=1"), s)).toEqual({
      counted: false,
      cleanUrl: "/?q=glue",
    });
    expect(s.getItem(TRAFFIC_KEY)).toBe("maintainer");
  });

  it("?me=0 removes it", () => {
    const s = memoryStorage({ [TRAFFIC_KEY]: "maintainer" });
    expect(applyTrafficSwitch(new URL("https://x.test/?me=0"), s)).toEqual({ counted: true, cleanUrl: "/" });
    expect(s.getItem(TRAFFIC_KEY)).toBeNull();
  });

  it("keeps the path and hash when it strips the parameter", () => {
    const s = memoryStorage();
    expect(applyTrafficSwitch(new URL("https://x.test/a?me=1#r"), s).cleanUrl).toBe("/a#r");
  });

  it("without the parameter, reads the stored flag and leaves the URL alone", () => {
    expect(applyTrafficSwitch(new URL("https://x.test/?q=glue"), memoryStorage({ [TRAFFIC_KEY]: "maintainer" }))).toEqual(
      { counted: false, cleanUrl: null },
    );
    expect(applyTrafficSwitch(new URL("https://x.test/"), memoryStorage())).toEqual({ counted: true, cleanUrl: null });
  });

  it("another stored value counts", () => {
    expect(applyTrafficSwitch(new URL("https://x.test/"), memoryStorage({ [TRAFFIC_KEY]: "yes" })).counted).toBe(true);
  });

  it("storage that throws: counted, no exception, the parameter still stripped", () => {
    expect(applyTrafficSwitch(new URL("https://x.test/?me=1"), THROWING)).toEqual({ counted: true, cleanUrl: "/" });
    expect(applyTrafficSwitch(new URL("https://x.test/"), THROWING)).toEqual({ counted: true, cleanUrl: null });
  });

  it("no storage at all: counted", () => {
    expect(applyTrafficSwitch(new URL("https://x.test/?me=1"), null)).toEqual({ counted: true, cleanUrl: "/" });
  });
});

describe("trafficHeaders", () => {
  it("follows setMaintainer", () => {
    expect(trafficHeaders()).toEqual({});
    expect(isMaintainer()).toBe(false);
    setMaintainer(true);
    expect(trafficHeaders()).toEqual({ "x-wts-traffic": "maintainer" });
    expect(isMaintainer()).toBe(true);
  });
});
