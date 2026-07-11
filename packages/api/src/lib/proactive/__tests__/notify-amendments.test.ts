/**
 * notifyAmendmentsPending — the core → proactive-seam bridge (#4520).
 *
 * This is the plain-async entry the semantic-expert scheduler calls. It
 * MUST degrade cleanly to a `{ posted: false }` outcome on every failure
 * path — an enterprise-off deploy (the Noop `ProactiveService` fails the
 * seam with `EnterpriseError`) or any delivery defect must never throw
 * back into the tick (AC3).
 *
 * The mocked `runEnterprise` FAITHFULLY runs the passed program against a
 * swappable `ProactiveService` layer on the real Effect runtime — so the
 * `EnterpriseError` genuinely flows through the seam and the bridge's
 * inside-the-Effect `catchTag` recovery is exercised for real. A prior
 * version mocked `runEnterprise` to throw a raw `EnterpriseError`
 * instance, which the real `ManagedRuntime.runPromise` NEVER produces (it
 * rejects with a `FiberFailure` wrapper) — that masked a dead-branch bug.
 * Running the real Noop layer is what makes this test trustworthy.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ProactiveService,
  NoopProactiveServiceLayer,
  createProactiveServiceTestLayer,
} from "@atlas/api/lib/effect/proactive-service";
import type { AmendmentNoticeOutcome } from "@atlas/api/lib/proactive/types";

// The layer runEnterprise resolves `ProactiveService` from — swapped per test.
let proactiveLayer: Layer.Layer<ProactiveService> = NoopProactiveServiceLayer;

// Intentionally NARROW mock: only `runEnterprise` is provided. It is the sole
// enterprise-layer export the module-under-test consumes, and bun `--isolate`
// resets module mocks per file, so the other exports (getEnterpriseRuntime,
// yieldFailClosed, EnterpriseLayer) can't leak in unmocked from this file.
void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  // Mimic runEnterprise faithfully: provide the current layer and run on the
  // real Effect runtime (reproducing the FiberFailure-wrapping the bridge must
  // be immune to).
  runEnterprise: (program: Effect.Effect<AmendmentNoticeOutcome, never, ProactiveService>) =>
    Effect.runPromise(Effect.provide(program, proactiveLayer)),
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { notifyAmendmentsPending } = await import("../notify-amendments");

beforeEach(() => {
  proactiveLayer = NoopProactiveServiceLayer;
});

describe("notifyAmendmentsPending bridge (#4520)", () => {
  it("short-circuits without touching the seam when count <= 0", async () => {
    // A seam that would die if reached — proves count<=0 never calls it.
    proactiveLayer = createProactiveServiceTestLayer({
      notifyAmendmentsPending: () => Effect.die(new Error("seam should not be reached")),
    });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 0 });

    expect(outcome).toEqual({ posted: false, reason: "nothing_to_notify" });
  });

  it("passes the seam's outcome through on a successful post", async () => {
    proactiveLayer = createProactiveServiceTestLayer({
      notifyAmendmentsPending: (input) => {
        expect(input).toEqual({ workspaceId: "org-a", count: 4 });
        return Effect.succeed({ posted: true, messageId: "slack-123" } satisfies AmendmentNoticeOutcome);
      },
    });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 4 });

    expect(outcome).toEqual({ posted: true, messageId: "slack-123" });
  });

  it("degrades to enterprise_disabled against the REAL Noop layer (FiberFailure-safe)", async () => {
    // The Noop ProactiveService fails the seam with EnterpriseError INSIDE the
    // Effect; the bridge's catchTag recovers it to a success value. This does
    // NOT rely on an outside `instanceof` against the runPromise rejection —
    // which would be a FiberFailure wrapper and always false.
    proactiveLayer = NoopProactiveServiceLayer;

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 2 });

    expect(outcome).toEqual({ posted: false, reason: "enterprise_disabled" });
  });

  it("maps an unexpected defect to a non-throwing error outcome", async () => {
    proactiveLayer = createProactiveServiceTestLayer({
      notifyAmendmentsPending: () => Effect.die(new Error("channel post exploded")),
    });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1 });

    // Never throws — a defect is contained and tagged `error`.
    expect(outcome.posted).toBe(false);
    if (!outcome.posted) expect(outcome.reason).toBe("error");
  });

  it("passes a delivery-side skip outcome straight through", async () => {
    // The EE impl may resolve a clean skip (e.g. no announcement channel).
    proactiveLayer = createProactiveServiceTestLayer({
      notifyAmendmentsPending: () =>
        Effect.succeed({ posted: false, reason: "no_channel" } satisfies AmendmentNoticeOutcome),
    });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 3 });

    expect(outcome).toEqual({ posted: false, reason: "no_channel" });
  });
});
