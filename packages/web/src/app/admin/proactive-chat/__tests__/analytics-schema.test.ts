import { describe, expect, test } from "bun:test";
import { AnalyticsResponseSchema, AvailableChannelsSchema } from "../page";

/**
 * Round-trip test for the production parse path in `/admin/proactive-chat`.
 *
 * Two consumers (`QuotaUsageIndicator`, `DecisionDrillDownPanel`) hit
 * `/api/v1/admin/proactive/analytics` through `useAdminFetch`, which dedupes
 * by `[ADMIN_FETCH_QUERY_KEY, path, ...deps]` and only runs the first
 * mount's `queryFn`. Zod's `z.object` strips unrecognized keys, so the
 * cached parsed value is only safe for the second consumer when both
 * consumers agree on a schema that validates *every* slice they read.
 *
 * #2637 regression: previously, two partial schemas (one for `quota`, one
 * for `summary`) split the validation, and whichever ran first stripped the
 * other's slice from the cached value. The drill-down then crashed on
 * `aggregate.data.summary.classifyCount` because `summary` was undefined.
 *
 * These tests pin the consolidated schema's invariants so a future PR that
 * tries to split it back into partials has to delete an assertion.
 */
describe("AnalyticsResponseSchema round-trip", () => {
  const FIXTURE = {
    summary: {
      classifyCount: 6,
      reactCount: 2,
    },
    quota: {
      classifyCountThisMonth: 6,
      monthlyClassifierCap: null,
      capReached: false,
    },
  };

  test("parses a realistic API response and keeps both slices", () => {
    const parsed = AnalyticsResponseSchema.parse(FIXTURE);
    expect(parsed.summary.classifyCount).toBe(6);
    expect(parsed.summary.reactCount).toBe(2);
    expect(parsed.quota.classifyCountThisMonth).toBe(6);
    expect(parsed.quota.monthlyClassifierCap).toBeNull();
    expect(parsed.quota.capReached).toBe(false);
  });

  test("monthlyClassifierCap accepts a positive integer", () => {
    const parsed = AnalyticsResponseSchema.parse({
      ...FIXTURE,
      quota: { ...FIXTURE.quota, monthlyClassifierCap: 10_000, capReached: true },
    });
    expect(parsed.quota.monthlyClassifierCap).toBe(10_000);
    expect(parsed.quota.capReached).toBe(true);
  });

  test("rejects when `summary` slice is missing (drill-down crash repro)", () => {
    const { summary: _omit, ...rest } = FIXTURE;
    const result = AnalyticsResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("rejects when `quota` slice is missing (usage-bar would render undefined)", () => {
    const { quota: _omit, ...rest } = FIXTURE;
    const result = AnalyticsResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("rejects negative or non-integer counts in `summary`", () => {
    expect(
      AnalyticsResponseSchema.safeParse({
        ...FIXTURE,
        summary: { ...FIXTURE.summary, classifyCount: -1 },
      }).success,
    ).toBe(false);
    expect(
      AnalyticsResponseSchema.safeParse({
        ...FIXTURE,
        summary: { ...FIXTURE.summary, classifyCount: 1.5 },
      }).success,
    ).toBe(false);
  });

  test("ignores unknown server-additive keys without dropping required slices", () => {
    // Forward-compat: the API route also returns `workspaceId` and
    // `sinceMs`. Those keys must parse cleanly (Zod strip-unknown) while
    // both required slices stay intact for the consumers.
    const parsed = AnalyticsResponseSchema.parse({
      workspaceId: "ws_123",
      sinceMs: 2_592_000_000,
      ...FIXTURE,
    });
    expect(parsed.summary.classifyCount).toBe(6);
    expect(parsed.quota.capReached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Merged from available-channels-schema.test.ts — the other wire schema
// exported by the same source module (`../page`). No mocks in either file.
// ---------------------------------------------------------------------------

/**
 * Pins the wire contract of `GET /admin/proactive/channels/available` on
 * the web side (#3463/#3466).
 *
 * The `reason` enum is platform-neutral and must stay byte-identical to
 * `AvailableChannelsResponseSchema` in
 * `packages/api/src/api/routes/admin-proactive.ts` — `missing_scope` in
 * particular drives the reconnect-Slack callout, so a silent enum drift
 * (Zod parse failure → `available: false` with no reason) would hide the
 * one actionable degraded state behind the generic manual-entry fallback.
 */
describe("AvailableChannelsSchema", () => {
  const CHANNEL = { id: "C1", name: "general", isPrivate: false, isMember: true };

  test("parses a successful listing", () => {
    const parsed = AvailableChannelsSchema.parse({
      available: true,
      reason: null,
      channels: [CHANNEL],
    });
    expect(parsed.available).toBe(true);
    expect(parsed.channels).toEqual([CHANNEL]);
  });

  test.each(["no_chat_installation", "missing_scope", "platform_error"] as const)(
    "accepts the platform-neutral degraded reason %s",
    (reason) => {
      const parsed = AvailableChannelsSchema.parse({
        available: false,
        reason,
        channels: [],
      });
      expect(parsed.reason).toBe(reason);
    },
  );

  test("rejects the retired Slack-flavored reasons", () => {
    for (const reason of ["no_slack_installation", "slack_error"]) {
      expect(
        AvailableChannelsSchema.safeParse({ available: false, reason, channels: [] }).success,
      ).toBe(false);
    }
  });
});
