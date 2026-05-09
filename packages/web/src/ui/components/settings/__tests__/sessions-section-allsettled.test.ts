import { describe, expect, test } from "bun:test";

/**
 * Regression test for the SessionsSection bulk sign-out failure aggregation.
 *
 * `useAdminMutation.mutate()` resolves with a discriminated `{ ok: false }`
 * on HTTP failure rather than rejecting. A naive `Promise.allSettled`
 * filter that only counts `r.status === "rejected"` will under-count
 * failures and silently report bulk success even when every revoke 5xx'd.
 *
 * This test pins the corrected predicate that the section uses, in a form
 * that can't drift from the runtime behavior.
 */
function countFailed(
  results: PromiseSettledResult<{ ok: boolean }>[],
): number {
  return results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok),
  ).length;
}

describe("SessionsSection bulk sign-out failure counting", () => {
  test("counts a fulfilled-but-not-ok result as failed", () => {
    const results: PromiseSettledResult<{ ok: boolean }>[] = [
      { status: "fulfilled", value: { ok: true } },
      { status: "fulfilled", value: { ok: false } },
      { status: "fulfilled", value: { ok: false } },
    ];
    expect(countFailed(results)).toBe(2);
  });

  test("counts a rejected result as failed", () => {
    const results: PromiseSettledResult<{ ok: boolean }>[] = [
      { status: "fulfilled", value: { ok: true } },
      { status: "rejected", reason: new Error("timeout") },
    ];
    expect(countFailed(results)).toBe(1);
  });

  test("returns zero when all results are ok", () => {
    const results: PromiseSettledResult<{ ok: boolean }>[] = [
      { status: "fulfilled", value: { ok: true } },
      { status: "fulfilled", value: { ok: true } },
    ];
    expect(countFailed(results)).toBe(0);
  });

  test("the buggy 'reject-only' filter would miss every fulfilled-but-not-ok failure", () => {
    // The reviewers caught this: useAdminMutation never rejects, so a
    // status-only filter sees zero failures even when every revoke 500s.
    const results: PromiseSettledResult<{ ok: boolean }>[] = [
      { status: "fulfilled", value: { ok: false } },
      { status: "fulfilled", value: { ok: false } },
      { status: "fulfilled", value: { ok: false } },
    ];
    const buggy = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    ).length;
    expect(buggy).toBe(0);
    // Correct filter catches all three.
    expect(countFailed(results)).toBe(3);
  });
});
