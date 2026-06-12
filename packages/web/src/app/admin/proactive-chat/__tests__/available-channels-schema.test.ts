import { describe, expect, test } from "bun:test";
import { AvailableChannelsSchema } from "../page";

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
