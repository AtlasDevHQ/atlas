import { describe, expect, test } from "bun:test";
import { summarizeBulkResult } from "../bulk-result";

/**
 * `summarizeBulkResult` is the pure core of the page's `handleBulkResult`
 * callback. The page layer routes the returned summary string to its banner
 * state and narrows selection to `remainingIds` so a retry click targets
 * exactly the rows that still need action.
 *
 * The index-based pairing between `results` and `ids` is the compliance-
 * sensitive bit — a reorder bug would narrow selection to the *wrong* rows
 * and the operator would re-deny the wrong actions.
 */
describe("summarizeBulkResult", () => {
  test("all-fulfilled returns null summary and empty remainingIds", async () => {
    const results = await Promise.allSettled([
      Promise.resolve("ok"),
      Promise.resolve("ok"),
    ]);
    const out = summarizeBulkResult(results, ["a", "b"], "approvals");
    expect(out.summary).toBeNull();
    expect([...out.remainingIds]).toEqual([]);
  });

  test("all-rejected returns every input id in remainingIds", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Forbidden")),
    ]);
    const out = summarizeBulkResult(results, ["a", "b"], "denials");
    expect(out.summary).toBe("2 of 2 denials failed: 2× Forbidden");
    expect([...out.remainingIds].sort()).toEqual(["a", "b"]);
  });

  test("partial failure preserves ids by index (reject indices 1 and 3 of 4 → {ids[1], ids[3]})", async () => {
    const results = await Promise.allSettled([
      Promise.resolve("ok"),
      Promise.reject(new Error("nope")),
      Promise.resolve("ok"),
      Promise.reject(new Error("nope")),
    ]);
    const out = summarizeBulkResult(
      results,
      ["first", "second", "third", "fourth"],
      "denials",
    );
    // Locks the index pairing — a reorder in the flatMap pipeline would
    // narrow to the wrong rows and compliance-relevant re-denies would
    // target the wrong actions.
    expect([...out.remainingIds].sort()).toEqual(["fourth", "second"]);
    expect(out.summary).toBe("2 of 4 denials failed: 2× nope");
  });

  test("groups failures by reason with counts", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Internal error")),
    ]);
    const out = summarizeBulkResult(
      results,
      ["a", "b", "c", "d", "e"],
      "denials",
    );
    expect(out.summary).toBe(
      "5 of 5 denials failed: 4× Forbidden; 1× Internal error",
    );
  });

  test("non-Error rejection reasons stringify (not 'Unknown error')", async () => {
    const results = await Promise.allSettled([
      Promise.reject("raw string rejection"),
      Promise.reject(null),
    ]);
    const out = summarizeBulkResult(results, ["a", "b"], "denials");
    // Delegates to `bulkFailureSummary` which does `String(reason)` —
    // lock in the passthrough so a future "collapse to Unknown error"
    // refactor would be caught by this assertion.
    expect(out.summary).toBe(
      "2 of 2 denials failed: 1× raw string rejection; 1× null",
    );
  });

  test("empty inputs don't throw and return null summary", () => {
    const out = summarizeBulkResult([], [], "approvals");
    expect(out.summary).toBeNull();
    expect([...out.remainingIds]).toEqual([]);
  });

  test("uses caller-supplied noun verbatim", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new Error("boom")),
    ]);
    const out = summarizeBulkResult(results, ["a"], "rollbacks");
    expect(out.summary).toBe("1 of 1 rollbacks failed: 1× boom");
  });
});
