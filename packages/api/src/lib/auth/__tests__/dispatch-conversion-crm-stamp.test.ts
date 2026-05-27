/**
 * Regression coverage for the Stripe webhook → Twenty CRM conversion
 * stamp helper ({@link dispatchConversionCrmStamp}, #2737).
 *
 * Contract:
 *   - Stripe customer with an email → enqueues a `conversion` lead via
 *     SaasCrm.stampConversion.
 *   - Customer has no email / is deleted / retrieve fails → no-op, logs
 *     the appropriate event, never throws (Stripe must keep ack'ing).
 *   - Self-hosted (Noop SaasCrm) → no Twenty traffic; helper resolves.
 *   - Enterprise runtime rejects → swallowed; helper resolves.
 *   - stampConversion's typed `Error` channel → swallowed; helper resolves.
 *
 * Same caveat as `dispatch-signup-crm-lead.test.ts`: this exercises the
 * helper in isolation. It cannot detect a refactor that removes the
 * `dispatchConversionCrmStamp(...)` call from `onSubscriptionComplete`
 * — Better Auth closes over its plugin options.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmStampConversionInput,
  type SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mock storage state (controlled per-test) ────────────────────────

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;
const stampConversionCalls: SaasCrmStampConversionInput[] = [];

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogError: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogDebug: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
  EnterpriseLayer: Layer.empty,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  }),
  getLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  setLogLevel: () => false,
}));

// ── Import the unit under test AFTER mocks ─────────────────────────

const { dispatchConversionCrmStamp, planConversionStamp } = await import("../server");

// Stripe client doubles. The Better Auth Stripe plugin only calls
// `customers.retrieve` from this helper, so we expose just that surface
// and cast the rest. We can't import `Stripe` at the type level here
// without the real module because the helper signature is
// `stripeClient: Stripe`, so we lean on a structural cast.
type StripeCustomerLike =
  | { id: string; email?: string | null; deleted?: false }
  | { id: string; deleted: true };

interface StripeCustomersRetrieveStub {
  retrieve: (id: string) => Promise<StripeCustomerLike>;
}
interface StripeStub {
  customers: StripeCustomersRetrieveStub;
}

function makeStripe(impl: StripeCustomersRetrieveStub["retrieve"]): StripeStub {
  return { customers: { retrieve: impl } };
}

// SaasCrm test layers — same pattern as dispatch-signup-crm-lead.test.
function recordingLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: () => Effect.void,
    stampConversion: (input: SaasCrmStampConversionInput) => {
      stampConversionCalls.push(input);
      return Effect.void;
    },
  } as unknown as SaasCrmShape);
}

function failingLayer(err: Error): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: () => Effect.void,
    stampConversion: () => Effect.fail(err),
  } as unknown as SaasCrmShape);
}

function noopLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: false,
    upsertLead: () => Effect.void,
    stampConversion: () => Effect.void,
    dispatcher: null,
  });
}

beforeEach(() => {
  stampConversionCalls.length = 0;
  mockLogWarn.mockClear();
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogDebug.mockClear();
  runEnterpriseImpl = async (program) => {
    await Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, never, SaasCrm>, recordingLayer()),
    );
  };
});

describe("dispatchConversionCrmStamp — happy path", () => {
  it("retrieves Stripe customer email and enqueues a stampConversion", async () => {
    const stripe = makeStripe(async (id) => ({
      id,
      email: "Paying@Example.com",
    }));

    await dispatchConversionCrmStamp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
      stripeClient: stripe as any,
      stripeCustomerId: "cus_pay_42",
      orgId: "org_abc",
    });

    expect(stampConversionCalls).toHaveLength(1);
    expect(stampConversionCalls[0]).toEqual({
      // Email is lowercased + trimmed at the helper boundary.
      email: "paying@example.com",
      stripeCustomerId: "cus_pay_42",
    });
  });
});

describe("dispatchConversionCrmStamp — no-op cases", () => {
  it("logs and skips when Stripe customer has no email", async () => {
    const stripe = makeStripe(async (id) => ({ id, email: null }));

    await dispatchConversionCrmStamp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
      stripeClient: stripe as any,
      stripeCustomerId: "cus_no_email",
    });

    expect(stampConversionCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.customer_no_email");
  });

  it("logs and skips when Stripe customer email is whitespace-only", async () => {
    const stripe = makeStripe(async (id) => ({ id, email: "   " }));

    await dispatchConversionCrmStamp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
      stripeClient: stripe as any,
      stripeCustomerId: "cus_blank",
    });

    expect(stampConversionCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("logs and skips when Stripe customer is deleted", async () => {
    const stripe = makeStripe(async (id) => ({ id, deleted: true }));

    await dispatchConversionCrmStamp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
      stripeClient: stripe as any,
      stripeCustomerId: "cus_gone",
    });

    expect(stampConversionCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.customer_deleted");
  });
});

describe("dispatchConversionCrmStamp — failure swallow contract", () => {
  it("resolves and logs when customers.retrieve throws", async () => {
    const stripe = makeStripe(async () => {
      throw new Error("stripe blip");
    });

    await expect(
      dispatchConversionCrmStamp({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
        stripeClient: stripe as any,
        stripeCustomerId: "cus_die",
      }),
    ).resolves.toBeUndefined();

    expect(stampConversionCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.customer_retrieve_failed");
  });

  it("resolves and logs when runEnterprise throws", async () => {
    runEnterpriseImpl = async () => {
      throw new Error("simulated defect inside runEnterprise");
    };
    const stripe = makeStripe(async (id) => ({ id, email: "x@y.com" }));

    await expect(
      dispatchConversionCrmStamp({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
        stripeClient: stripe as any,
        stripeCustomerId: "cus_defect",
      }),
    ).resolves.toBeUndefined();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.dispatch_defect");
  });

  it("resolves and logs `conversion_crm.enqueue_failed` when stampConversion fails with a typed Error", async () => {
    runEnterpriseImpl = async (program) => {
      await Effect.runPromise(
        Effect.provide(
          program as Effect.Effect<unknown, never, SaasCrm>,
          failingLayer(new Error("crm_outbox enqueue failed — pg blip")),
        ),
      );
    };
    const stripe = makeStripe(async (id) => ({ id, email: "x@y.com" }));

    await expect(
      dispatchConversionCrmStamp({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
        stripeClient: stripe as any,
        stripeCustomerId: "cus_pgblip",
        orgId: "org_pg",
      }),
    ).resolves.toBeUndefined();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.enqueue_failed");
    expect(logCtx.orgId).toBe("org_pg");
  });
});

describe("dispatchConversionCrmStamp — Noop / self-hosted shape", () => {
  it("resolves without dispatching when SaasCrm is unavailable", async () => {
    let runs = 0;
    runEnterpriseImpl = async (program) => {
      runs++;
      await Effect.runPromise(
        Effect.provide(program as Effect.Effect<unknown, never, SaasCrm>, noopLayer()),
      );
    };
    const stripe = makeStripe(async (id) => ({ id, email: "x@y.com" }));

    await expect(
      dispatchConversionCrmStamp({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
        stripeClient: stripe as any,
        stripeCustomerId: "cus_selfhosted",
      }),
    ).resolves.toBeUndefined();
    expect(runs).toBe(1);
    expect(stampConversionCalls).toHaveLength(0);
  });
});

describe("dispatchConversionCrmStamp — enqueue_failed log shape", () => {
  // Pin the outer helper's log context for `conversion_crm.enqueue_failed`.
  // The stripeCustomerId IS included on the outer log (operators need it
  // to triage in Stripe directly); the inner EE-side
  // `saas_crm.stamp_conversion_enqueue_failed` log deliberately OMITS it
  // — that contract lives in `ee/src/saas-crm/__tests__/saas-crm.test.ts`.
  // The split keeps the rationale "stripeCustomerId is not a secret per se,
  // but the EE-side log is intentionally bare to reduce surface" testable
  // at each boundary.
  it("includes orgId, stripeCustomerId, and err on the outer enqueue_failed warn", async () => {
    runEnterpriseImpl = async (program) => {
      await Effect.runPromise(
        Effect.provide(
          program as Effect.Effect<unknown, never, SaasCrm>,
          failingLayer(new Error("blip")),
        ),
      );
    };
    const stripe = makeStripe(async (id) => ({ id, email: "x@y.com" }));

    await dispatchConversionCrmStamp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe stub
      stripeClient: stripe as any,
      stripeCustomerId: "cus_pin_outer_log",
      orgId: "org_pin",
    });

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("conversion_crm.enqueue_failed");
    expect(logCtx.orgId).toBe("org_pin");
    expect(logCtx.stripeCustomerId).toBe("cus_pin_outer_log");
    expect(logCtx.err).toBe("blip");
  });
});

// ────────────────────────────────────────────────────────────────────
// planConversionStamp — the trial-vs-paid gating predicate (#2737 +
// Codex P1). Pinning every permutation here is the structural defence
// against silently re-introducing trial-start stamping.
// ────────────────────────────────────────────────────────────────────

describe("planConversionStamp — onSubscriptionComplete trigger", () => {
  it("dispatches when status is active and stripeCustomerId is present", () => {
    expect(
      planConversionStamp({
        trigger: "complete",
        subscription: { status: "active", stripeCustomerId: "cus_paid_immediately" },
      }),
    ).toEqual({ kind: "dispatch", stripeCustomerId: "cus_paid_immediately" });
  });

  it("skips when status is trialing (Codex P1 — no overcounting unpaid trials)", () => {
    expect(
      planConversionStamp({
        trigger: "complete",
        subscription: { status: "trialing", stripeCustomerId: "cus_on_trial" },
      }),
    ).toEqual({ kind: "skip", reason: "trialing" });
  });

  it("skips when status is any other non-active value (incomplete / past_due / paused)", () => {
    for (const status of ["incomplete", "past_due", "paused", "unpaid", "canceled"] as const) {
      expect(
        planConversionStamp({
          trigger: "complete",
          subscription: { status, stripeCustomerId: "cus_x" },
        }),
      ).toEqual({ kind: "skip", reason: "non-active" });
    }
  });

  it("returns log-and-skip when stripeCustomerId is missing", () => {
    expect(
      planConversionStamp({
        trigger: "complete",
        subscription: { status: "active", stripeCustomerId: null },
      }),
    ).toEqual({ kind: "log-and-skip", reason: "no-stripe-customer-id" });
    expect(
      planConversionStamp({
        trigger: "complete",
        subscription: { status: "active", stripeCustomerId: undefined },
      }),
    ).toEqual({ kind: "log-and-skip", reason: "no-stripe-customer-id" });
  });
});

describe("planConversionStamp — onSubscriptionUpdate trigger", () => {
  const updateEvent = (current: string | null | undefined, previous: string | null | undefined) => ({
    type: "customer.subscription.updated",
    data: {
      previous_attributes: previous === undefined ? undefined : { status: previous },
      object: { status: current },
    },
  });

  it("dispatches on the trial → active transition", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: "cus_trial_converted" },
        event: updateEvent("active", "trialing"),
      }),
    ).toEqual({ kind: "dispatch", stripeCustomerId: "cus_trial_converted" });
  });

  it("skips when current status is active but previous was not trialing (e.g. price change)", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: "cus_x" },
        event: updateEvent("active", "active"),
      }),
    ).toEqual({ kind: "skip", reason: "non-transition" });
  });

  it("skips when previous_attributes is absent (Stripe omits unchanged fields)", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: "cus_x" },
        event: updateEvent("active", undefined),
      }),
    ).toEqual({ kind: "skip", reason: "non-transition" });
  });

  it("skips when current status is something other than active (trial → past_due)", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: "cus_x" },
        event: updateEvent("past_due", "trialing"),
      }),
    ).toEqual({ kind: "skip", reason: "non-transition" });
  });

  it("skips when the event type is not customer.subscription.updated", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: "cus_x" },
        event: {
          type: "customer.subscription.created",
          data: { previous_attributes: { status: "trialing" }, object: { status: "active" } },
        },
      }),
    ).toEqual({ kind: "skip", reason: "non-transition" });
  });

  it("skips when stripeCustomerId is missing on the subscription (even on a real transition)", () => {
    expect(
      planConversionStamp({
        trigger: "update",
        subscription: { stripeCustomerId: undefined },
        event: updateEvent("active", "trialing"),
      }),
    ).toEqual({ kind: "skip", reason: "non-transition" });
  });
});
