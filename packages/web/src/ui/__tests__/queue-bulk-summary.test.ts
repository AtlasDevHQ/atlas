import { describe, expect, test } from "bun:test";
import {
  bulkFailureSummary,
  bulkPartialSummary,
  failedIdsFrom,
} from "../components/admin/queue";

/* ------------------------------------------------------------------ */
/*  failedIdsFrom — pairs PromiseSettledResult rejections back to ids */
/* ------------------------------------------------------------------ */

describe("failedIdsFrom", () => {
  test("returns empty array when every result fulfilled", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ];
    expect(failedIdsFrom(results, ["a", "b"])).toEqual([]);
  });

  test("returns the ids whose matching result rejected, in order", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: new Error("x") },
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: new Error("y") },
    ];
    expect(failedIdsFrom(results, ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/*  bulkFailureSummary — "3 of 5 noun failed: 2× Forbidden; 1× ..."    */
/* ------------------------------------------------------------------ */

describe("bulkFailureSummary", () => {
  test("counts distinct reasons with a multiplier", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: new Error("Forbidden") },
      { status: "rejected", reason: new Error("Forbidden") },
      { status: "rejected", reason: new Error("Internal error") },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ];
    expect(bulkFailureSummary(results, ["a", "b", "c", "d", "e"], "denials"))
      .toBe("3 of 5 denials failed: 2× Forbidden; 1× Internal error");
  });

  test("surfaces 'Unknown error' when reason is not an Error instance", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: "raw string" },
      { status: "rejected", reason: null },
    ];
    expect(bulkFailureSummary(results, ["a", "b"], "approvals"))
      .toBe("2 of 2 approvals failed: 2× Unknown error");
  });

  test("preserves the noun the caller passes in", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: new Error("nope") },
    ];
    expect(bulkFailureSummary(results, ["a"], "rollbacks"))
      .toBe("1 of 1 rollbacks failed: 1× nope");
  });
});

/* ------------------------------------------------------------------ */
/*  bulkPartialSummary — server returns 200 with { updated, notFound,  */
/*  errors? } even on per-row failure. Summarize for a single banner.  */
/* ------------------------------------------------------------------ */

describe("bulkPartialSummary", () => {
  test("summarizes notFound-only partial failure", () => {
    expect(
      bulkPartialSummary({ updated: ["a"], notFound: ["b", "c"] }, 3, "approvals"),
    ).toBe("2 of 3 approvals failed: 2 not found");
  });

  test("summarizes per-id errors with distinct-reason multipliers", () => {
    expect(
      bulkPartialSummary(
        {
          updated: [],
          errors: [
            { id: "a", error: "db timeout" },
            { id: "b", error: "db timeout" },
            { id: "c", error: "forbidden" },
          ],
        },
        3,
        "rejections",
      ),
    ).toBe("3 of 3 rejections failed: 2× db timeout; 1× forbidden");
  });

  test("combines notFound and per-id errors", () => {
    expect(
      bulkPartialSummary(
        {
          updated: ["x"],
          notFound: ["y"],
          errors: [{ id: "z", error: "boom" }],
        },
        3,
        "updates",
      ),
    ).toBe("2 of 3 updates failed: 1 not found; 1× boom");
  });

  test("treats missing fields as empty", () => {
    expect(bulkPartialSummary({}, 0, "updates")).toBe("0 of 0 updates failed: ");
  });
});
