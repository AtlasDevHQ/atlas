/**
 * Dashboard parameter URL-state helpers (#2267 parameters, #3212 drilldown).
 *
 * The parameter bar and click-to-drilldown share ONE `dparams` URL key, so these
 * pure (de)serialize helpers are the single source of truth for how the override
 * map round-trips through the URL — bookmarked/shared links and drilldown both
 * depend on it. Covers parse robustness, the "no overrides clears the param"
 * contract, and the drilldown merge/clear path.
 */
import { describe, expect, test } from "bun:test";
import {
  parseOverrides,
  serializeOverrides,
  withOverride,
  normalizeDrilldownValue,
} from "../search-params";

describe("parseOverrides", () => {
  test("returns an empty map for null / empty / malformed input", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides("")).toEqual({});
    expect(parseOverrides("not json")).toEqual({});
  });

  test("ignores non-object JSON (arrays, primitives)", () => {
    expect(parseOverrides("[1,2]")).toEqual({});
    expect(parseOverrides("123")).toEqual({});
    expect(parseOverrides('"region"')).toEqual({});
  });

  test("parses a well-formed override object", () => {
    expect(parseOverrides('{"region":"us","limit_n":5}')).toEqual({ region: "us", limit_n: 5 });
  });
});

describe("serializeOverrides", () => {
  test("returns null for an empty map (clears the URL param)", () => {
    expect(serializeOverrides({})).toBeNull();
  });

  test("drops null and empty-string entries", () => {
    expect(serializeOverrides({ region: null, segment: "", limit_n: 5 })).toBe('{"limit_n":5}');
  });

  test("returns null when every entry is dropped", () => {
    expect(serializeOverrides({ region: null, segment: "" })).toBeNull();
  });

  test("serializes a populated map", () => {
    expect(serializeOverrides({ region: "us" })).toBe('{"region":"us"}');
  });
});

describe("withOverride (drilldown merge)", () => {
  test("sets a value into an empty (null) URL state", () => {
    expect(withOverride(null, "region", "us")).toBe('{"region":"us"}');
  });

  test("merges into existing overrides without clobbering them", () => {
    const next = withOverride('{"region":"us"}', "date_from", "2026-01-01");
    expect(parseOverrides(next)).toEqual({ region: "us", date_from: "2026-01-01" });
  });

  test("overwrites the same key on a repeat drilldown", () => {
    const next = withOverride('{"region":"us"}', "region", "eu");
    expect(parseOverrides(next)).toEqual({ region: "eu" });
  });

  test("clearing one of several keys keeps the rest", () => {
    const next = withOverride('{"region":"us","date_from":"2026-01-01"}', "region", null);
    expect(parseOverrides(next)).toEqual({ date_from: "2026-01-01" });
  });

  test("clearing the only key collapses to null (no dangling param)", () => {
    expect(withOverride('{"region":"us"}', "region", null)).toBeNull();
  });

  test("round-trips through parse → serialize", () => {
    const raw = withOverride(withOverride(null, "region", "us"), "limit_n", 10);
    expect(serializeOverrides(parseOverrides(raw))).toBe(raw);
  });
});

describe("normalizeDrilldownValue", () => {
  test("slices a date param's ISO timestamp category to YYYY-MM-DD (DatePicker shape)", () => {
    expect(normalizeDrilldownValue("date", "2026-06-04T12:00:00Z")).toBe("2026-06-04");
    expect(normalizeDrilldownValue("date", "2026-06-04 12:00:00")).toBe("2026-06-04");
  });

  test("leaves a plain YYYY-MM-DD date untouched", () => {
    expect(normalizeDrilldownValue("date", "2026-06-04")).toBe("2026-06-04");
  });

  test("leaves non-ISO date labels (month/quarter) untouched", () => {
    expect(normalizeDrilldownValue("date", "Jun 2026")).toBe("Jun 2026");
    expect(normalizeDrilldownValue("date", "Q1 2026")).toBe("Q1 2026");
  });

  test("passes text/number param values through unchanged", () => {
    expect(normalizeDrilldownValue("text", "2026-06-04T12:00:00Z")).toBe("2026-06-04T12:00:00Z");
    expect(normalizeDrilldownValue("number", "42")).toBe("42");
  });
});
