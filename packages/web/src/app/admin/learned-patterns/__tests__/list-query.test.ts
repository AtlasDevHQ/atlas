import { describe, expect, test } from "bun:test";
import { LEARNED_PATTERN_SORT_KEYS } from "@/ui/lib/admin-schemas";
import {
  buildLearnedPatternsPath,
  confidenceToPct,
  pctToConfidence,
  SORT_PARAM_BY_COLUMN,
  type LearnedPatternsFilters,
} from "../list-query";

const NO_FILTERS: LearnedPatternsFilters = {
  status: "",
  source_entity: "",
  min_confidence: "",
  max_confidence: "",
  include_seen_once: false,
};

function query(path: string): URLSearchParams {
  return new URL(path, "http://x").searchParams;
}

describe("buildLearnedPatternsPath", () => {
  test("always includes limit + offset from the binding", () => {
    const qs = query(
      buildLearnedPatternsPath({ offset: 50, perPage: 25 }, NO_FILTERS),
    );
    expect(qs.get("limit")).toBe("25");
    expect(qs.get("offset")).toBe("50");
  });

  test("omits empty filters and sort when nothing is set", () => {
    const path = buildLearnedPatternsPath({ offset: 0, perPage: 50 }, NO_FILTERS);
    const qs = query(path);
    for (const key of ["status", "source_entity", "min_confidence", "max_confidence", "include_seen_once", "sort", "dir"]) {
      expect(qs.has(key)).toBe(false);
    }
  });

  test("threads page-owned filters", () => {
    const qs = query(
      buildLearnedPatternsPath(
        { offset: 0, perPage: 50 },
        { status: "pending", source_entity: "orders", min_confidence: "0.5", max_confidence: "0.9", include_seen_once: false },
      ),
    );
    expect(qs.get("status")).toBe("pending");
    expect(qs.get("source_entity")).toBe("orders");
    expect(qs.get("min_confidence")).toBe("0.5");
    expect(qs.get("max_confidence")).toBe("0.9");
  });

  test("emits include_seen_once=true only when the seen-once toggle is on (#4581)", () => {
    // Off (the default) relies on the route hiding seen-once rows — no param.
    expect(query(buildLearnedPatternsPath({ offset: 0, perPage: 50 }, NO_FILTERS)).has("include_seen_once")).toBe(false);
    // On reveals them.
    const on = query(
      buildLearnedPatternsPath({ offset: 0, perPage: 50 }, { ...NO_FILTERS, include_seen_once: true }),
    );
    expect(on.get("include_seen_once")).toBe("true");
  });

  test("maps a sortable column id to the whitelisted sort param + direction", () => {
    const qs = query(
      buildLearnedPatternsPath(
        { offset: 0, perPage: 50, sortId: "confidence", sortDesc: true },
        NO_FILTERS,
      ),
    );
    expect(qs.get("sort")).toBe("confidence");
    expect(qs.get("dir")).toBe("desc");
  });

  test("asc direction when sortDesc is false", () => {
    const qs = query(
      buildLearnedPatternsPath(
        { offset: 0, perPage: 50, sortId: "avgDurationMs", sortDesc: false },
        NO_FILTERS,
      ),
    );
    expect(qs.get("sort")).toBe("latency");
    expect(qs.get("dir")).toBe("asc");
  });

  test("every sortable column id maps to its wire key", () => {
    const expected: Record<string, string> = {
      confidence: "confidence",
      repetitionCount: "repetition",
      avgDurationMs: "latency",
      createdAt: "created",
    };
    for (const [columnId, wireKey] of Object.entries(expected)) {
      const qs = query(
        buildLearnedPatternsPath({ offset: 0, perPage: 50, sortId: columnId }, NO_FILTERS),
      );
      expect(qs.get("sort")).toBe(wireKey);
    }
  });

  test("a non-sortable / unknown column id emits no sort param", () => {
    for (const bogus of ["patternSql", "status", "constructor", "select"]) {
      const qs = query(
        buildLearnedPatternsPath({ offset: 0, perPage: 50, sortId: bogus }, NO_FILTERS),
      );
      expect(qs.has("sort")).toBe(false);
      expect(qs.has("dir")).toBe(false);
    }
  });
});

describe("SORT_PARAM_BY_COLUMN", () => {
  test("covers exactly the four sortable columns, in wire vocabulary", () => {
    expect([...SORT_PARAM_BY_COLUMN.entries()]).toEqual([
      ["confidence", "confidence"],
      ["repetitionCount", "repetition"],
      ["avgDurationMs", "latency"],
      ["createdAt", "created"],
    ]);
  });

  test("every emitted sort value is in the shared API whitelist (no cross-package drift)", () => {
    // The route accepts exactly `LEARNED_PATTERN_SORT_KEYS`; the cockpit must
    // never emit a value outside it, or a legitimate sort click 400s. Binding
    // the web map's values to the shared vocabulary here (plus the values being
    // typed `LearnedPatternSortKey`) closes the drift the two lockstep comments
    // otherwise guard by convention alone.
    const emitted = new Set<string>(SORT_PARAM_BY_COLUMN.values());
    const whitelist = new Set<string>(LEARNED_PATTERN_SORT_KEYS);
    for (const value of emitted) {
      expect(whitelist.has(value)).toBe(true);
    }
    // And the cockpit exercises the whole whitelist — no dead API sort key.
    expect(emitted).toEqual(whitelist);
  });
});

describe("confidence ⇄ percentage conversion", () => {
  test("pctToConfidence divides by 100", () => {
    expect(pctToConfidence("50")).toBe("0.5");
    expect(pctToConfidence("100")).toBe("1");
    expect(pctToConfidence("0")).toBe("0");
  });

  test("pctToConfidence clamps out-of-range input", () => {
    expect(pctToConfidence("150")).toBe("1");
    expect(pctToConfidence("-10")).toBe("0");
  });

  test("pctToConfidence returns '' for empty / non-numeric", () => {
    expect(pctToConfidence("")).toBe("");
    expect(pctToConfidence("  ")).toBe("");
    expect(pctToConfidence("abc")).toBe("");
  });

  test("confidenceToPct multiplies by 100 and rounds", () => {
    expect(confidenceToPct("0.5")).toBe("50");
    expect(confidenceToPct("0.335")).toBe("34");
    expect(confidenceToPct("1")).toBe("100");
  });

  test("confidenceToPct returns '' for empty / non-numeric", () => {
    expect(confidenceToPct("")).toBe("");
    expect(confidenceToPct("nope")).toBe("");
  });

  test("round-trips a whole percentage", () => {
    expect(confidenceToPct(pctToConfidence("75"))).toBe("75");
  });
});
