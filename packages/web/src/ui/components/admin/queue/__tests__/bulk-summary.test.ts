import { describe, expect, test } from "bun:test";
import {
  bulkFailureSummary,
  BulkRequestError,
  bulkPartialSummary,
  failedIdsFrom,
  type BulkPartialResult,
} from "../bulk-summary";

async function settle<T>(values: Array<T | Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(values.map((v) => Promise.resolve(v)));
}

describe("failedIdsFrom", () => {
  test("returns ids whose corresponding result rejected", async () => {
    const results = await Promise.allSettled([
      Promise.resolve("ok"),
      Promise.reject(new Error("boom")),
      Promise.resolve("ok"),
      Promise.reject(new Error("nope")),
    ]);
    expect(failedIdsFrom(results, ["a", "b", "c", "d"])).toEqual(["b", "d"]);
  });

  test("empty when nothing rejected", async () => {
    const results = await settle(["a", "b"]);
    expect(failedIdsFrom(results, ["x", "y"])).toEqual([]);
  });
});

describe("bulkFailureSummary", () => {
  test("Error rejection uses err.message and groups by reason count", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Forbidden")),
      Promise.reject(new Error("Internal error")),
      Promise.resolve("ok"),
    ]);
    expect(bulkFailureSummary(results, ["a", "b", "c", "d"], "denials")).toBe(
      "3 of 4 denials failed: 2× Forbidden; 1× Internal error",
    );
  });

  test("string rejection surfaces the raw string (not 'Unknown error')", async () => {
    const results = await Promise.allSettled([
      Promise.reject("Forbidden"),
      Promise.resolve("ok"),
    ]);
    const summary = bulkFailureSummary(results, ["a", "b"], "denials");
    expect(summary).toBe("1 of 2 denials failed: 1× Forbidden");
    expect(summary).not.toContain("Unknown error");
  });

  test("plain object rejection surfaces String(value), not 'Unknown error'", async () => {
    const results = await Promise.allSettled([
      Promise.reject({ code: 403 }),
      Promise.resolve("ok"),
    ]);
    const summary = bulkFailureSummary(results, ["a", "b"], "denials");
    expect(summary).toBe("1 of 2 denials failed: 1× [object Object]");
    expect(summary).not.toContain("Unknown error");
  });

  test("null and undefined rejections stringify rather than collapse to 'Unknown error'", async () => {
    const results = await Promise.allSettled([
      Promise.reject(null),
      Promise.reject(undefined),
    ]);
    const summary = bulkFailureSummary(results, ["a", "b"], "denials");
    expect(summary).toBe("2 of 2 denials failed: 1× null; 1× undefined");
    expect(summary).not.toContain("Unknown error");
  });

  test("preserves the caller-supplied noun verbatim", async () => {
    const results = await Promise.allSettled([Promise.reject(new Error("nope"))]);
    expect(bulkFailureSummary(results, ["a"], "rollbacks")).toBe(
      "1 of 1 rollbacks failed: 1× nope",
    );
  });

  test("Error and string rejections with the same payload merge into one count", async () => {
    // String("Forbidden") === new Error("Forbidden").message, so both branches
    // produce the same Map key — they must bucket together, not split into
    // two "1× Forbidden" entries.
    const results = await Promise.allSettled([
      Promise.reject(new Error("Forbidden")),
      Promise.reject("Forbidden"),
    ]);
    expect(bulkFailureSummary(results, ["a", "b"], "denials")).toBe(
      "2 of 2 denials failed: 2× Forbidden",
    );
  });

  test("BulkRequestError with identical messages collapses to one group with trailing IDs", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new BulkRequestError("HTTP 500", "req-abc")),
      Promise.reject(new BulkRequestError("HTTP 500", "req-def")),
      Promise.reject(new BulkRequestError("HTTP 500", "req-ghi")),
    ]);
    expect(bulkFailureSummary(results, ["a", "b", "c"], "denials")).toBe(
      "3 of 3 denials failed: 3× HTTP 500 (IDs: req-abc, req-def, req-ghi)",
    );
  });

  test("BulkRequestError single-id group uses singular 'ID' label", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new BulkRequestError("HTTP 500", "req-only")),
    ]);
    expect(bulkFailureSummary(results, ["a"], "denials")).toBe(
      "1 of 1 denials failed: 1× HTTP 500 (ID: req-only)",
    );
  });

  test("BulkRequestError without requestId drops the trailing slot", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new BulkRequestError("HTTP 500")),
      Promise.reject(new BulkRequestError("HTTP 500")),
    ]);
    expect(bulkFailureSummary(results, ["a", "b"], "denials")).toBe(
      "2 of 2 denials failed: 2× HTTP 500",
    );
  });

  test("BulkRequestError groups separately by message and carries only its own ids", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new BulkRequestError("Forbidden", "req-1")),
      Promise.reject(new BulkRequestError("HTTP 500", "req-2")),
      Promise.reject(new BulkRequestError("HTTP 500", "req-3")),
    ]);
    expect(bulkFailureSummary(results, ["a", "b", "c"], "denials")).toBe(
      "3 of 3 denials failed: 1× Forbidden (ID: req-1); 2× HTTP 500 (IDs: req-2, req-3)",
    );
  });

  test("mixed BulkRequestError and plain Error merge by message; only the typed one contributes an ID", async () => {
    const results = await Promise.allSettled([
      Promise.reject(new BulkRequestError("HTTP 500", "req-abc")),
      Promise.reject(new Error("HTTP 500")),
    ]);
    // Plain Error has no requestId, so the group shows only the typed one's id.
    expect(bulkFailureSummary(results, ["a", "b"], "denials")).toBe(
      "2 of 2 denials failed: 2× HTTP 500 (ID: req-abc)",
    );
  });
});

describe("bulkPartialSummary", () => {
  test("counts notFound + per-error reason groups", () => {
    const data: BulkPartialResult = {
      updated: ["a"],
      notFound: ["b", "c"],
      errors: [
        { id: "d", error: "db timeout" },
        { id: "e", error: "db timeout" },
        { id: "f", error: "constraint" },
      ],
    };
    expect(bulkPartialSummary(data, 10, "approvals")).toBe(
      "5 of 10 approvals failed: 2 not found; 2× db timeout; 1× constraint",
    );
  });

  test("only notFound, no errors array", () => {
    expect(
      bulkPartialSummary({ notFound: ["a", "b"] }, 5, "approvals"),
    ).toBe("2 of 5 approvals failed: 2 not found");
  });

  test("only errors, no notFound", () => {
    expect(
      bulkPartialSummary(
        { errors: [{ id: "a", error: "boom" }] },
        3,
        "approvals",
      ),
    ).toBe("1 of 3 approvals failed: 1× boom");
  });

  test("treats missing fields as empty (no notFound, no errors)", () => {
    expect(bulkPartialSummary({}, 0, "updates")).toBe(
      "0 of 0 updates failed: ",
    );
  });
});
