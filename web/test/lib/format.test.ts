import { describe, expect, it } from "vitest";
import { count, episodeDate, timestamp } from "../../src/lib/format";

describe("timestamp", () => {
  it.each([
    [0, "0:00"],
    [7, "0:07"],
    [59, "0:59"],
    [60, "1:00"],
    [754, "12:34"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [4184, "1:09:44"],
    [4184.9, "1:09:44"],
    [36_000, "10:00:00"],
  ])("%s s is %s", (seconds, text) => {
    expect(timestamp(seconds)).toBe(text);
  });

  it("clamps a negative time to zero", () => {
    expect(timestamp(-5)).toBe("0:00");
  });
});

describe("episodeDate", () => {
  it.each([
    ["2010-06-10", "Jun 10, 2010"],
    ["2010-06-10T00:00:00Z", "Jun 10, 2010"],
    ["2024-01-01", "Jan 1, 2024"],
    ["2023-12-31", "Dec 31, 2023"],
  ])("%s is %s", (iso, text) => {
    expect(episodeDate(iso)).toBe(text);
  });

  it("does not move with the time zone", () => {
    const was = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      expect(episodeDate("2010-06-10")).toBe("Jun 10, 2010");
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });

  it("returns what it cannot read, unchanged", () => {
    expect(episodeDate("soon")).toBe("soon");
  });
});

describe("count", () => {
  it("groups thousands and marks a capped count", () => {
    expect(count(318, false)).toBe("318");
    expect(count(1318, false)).toBe("1,318");
    expect(count(1000, true)).toBe("1,000+");
  });
});
