/**
 * Regression coverage for the Better Auth signup → Twenty CRM dispatch
 * helper ({@link dispatchSignupCrmLead}).
 *
 * Contract:
 *   - Email-bearing signup → enqueues a `signup` lead via SaasCrm.upsertLead.
 *   - Missing / empty email → no-op (the upstream auth path should already
 *     have rejected this, but the helper must not propagate).
 *   - `name` is forwarded as a single string; first/last split happens
 *     downstream in the normalizer.
 *   - Self-hosted (Noop SaasCrm) → no Twenty traffic; helper resolves.
 *   - Enterprise runtime rejects / dies → swallowed; helper resolves.
 *   - upsertLead's typed `Error` channel → swallowed; helper resolves.
 *
 * Same caveat as `assign-saas-trial.test.ts`: this exercises the helper
 * in isolation. It cannot detect a refactor that removes the
 * `dispatchSignupCrmLead({ user })` call from
 * `databaseHooks.user.create.after` — Better Auth closes over its
 * plugin options, so the wiring is not introspectable from outside.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmLeadInput,
  type SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mock storage state (controlled per-test) ────────────────────────

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;
const upsertLeadCalls: SaasCrmLeadInput[] = [];

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  // Capture the program and resolve the Tag through the unit-test
  // doubles below. The default runner provides a real SaasCrm Layer
  // whose `upsertLead` pushes into `upsertLeadCalls`.
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
}));

// ── Import the unit under test AFTER mocks ─────────────────────────

const { dispatchSignupCrmLead } = await import("../server");

// `dispatchSignupCrmLead` only calls `upsertLead` — the per-row
// `dispatcher` hook is flusher-side only. We cast the recording shape
// to `SaasCrmShape` because providing a typed dispatcher stub would
// drag the full ClaimedOutboxRow / DispatchOutcome graph into this
// test for zero behavioural value.
function recordingLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: (input: SaasCrmLeadInput) => {
      upsertLeadCalls.push(input);
      return Effect.void;
    },
  } as unknown as SaasCrmShape);
}

function failingLayer(err: Error): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: () => Effect.fail(err),
  } as unknown as SaasCrmShape);
}

function noopLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: false,
    upsertLead: () => Effect.void,
  });
}

beforeEach(() => {
  upsertLeadCalls.length = 0;
  // Default: provide a recording Tag and run the helper's program through it.
  runEnterpriseImpl = async (program) => {
    await Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, never, SaasCrm>, recordingLayer()),
    );
  };
});

describe("dispatchSignupCrmLead — happy path", () => {
  it("enqueues a signup lead with email + name", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u1", email: "Alice@Example.com", name: "Alice Example" },
    });

    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "signup",
      email: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("enqueues without `name` when name is null", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u2", email: "bob@example.com", name: null },
    });

    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "signup",
      email: "bob@example.com",
    });
    expect("name" in upsertLeadCalls[0]).toBe(false);
  });

  it("enqueues without `name` when name is undefined", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u3", email: "carol@example.com" },
    });

    expect(upsertLeadCalls).toHaveLength(1);
    expect("name" in upsertLeadCalls[0]).toBe(false);
  });

  it("strips empty / whitespace-only name", async () => {
    for (const name of ["", "   ", "\t"]) {
      upsertLeadCalls.length = 0;
      await dispatchSignupCrmLead({
        user: { id: "u4", email: "d@e.com", name },
      });
      expect(upsertLeadCalls).toHaveLength(1);
      expect("name" in upsertLeadCalls[0]).toBe(false);
    }
  });
});

describe("dispatchSignupCrmLead — no-op cases", () => {
  it("does nothing when email is missing", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u5" },
    });
    expect(upsertLeadCalls).toHaveLength(0);
  });

  it("does nothing when email is null", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u6", email: null },
    });
    expect(upsertLeadCalls).toHaveLength(0);
  });

  it("does nothing when email is empty / whitespace-only", async () => {
    for (const email of ["", "   "]) {
      upsertLeadCalls.length = 0;
      await dispatchSignupCrmLead({
        user: { id: "u7", email },
      });
      expect(upsertLeadCalls).toHaveLength(0);
    }
  });
});

describe("dispatchSignupCrmLead — failure swallow contract", () => {
  it("resolves even when runEnterprise throws synchronously", async () => {
    runEnterpriseImpl = async () => {
      throw new Error("simulated defect inside runEnterprise");
    };

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u8", email: "die@test.com", name: "X" },
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves even when runEnterprise rejects asynchronously", async () => {
    runEnterpriseImpl = async () => Promise.reject(new Error("async reject"));

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u9", email: "reject@test.com" },
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves when SaasCrm.upsertLead fails with a typed Error", async () => {
    runEnterpriseImpl = async (program) => {
      await Effect.runPromise(
        Effect.provide(
          program as Effect.Effect<unknown, never, SaasCrm>,
          failingLayer(new Error("crm_outbox enqueue failed — pg blip")),
        ),
      );
    };

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u10", email: "pgblip@test.com", name: "X" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("dispatchSignupCrmLead — Noop / self-hosted shape", () => {
  it("resolves without dispatching when SaasCrm is unavailable", async () => {
    let runs = 0;
    runEnterpriseImpl = async (program) => {
      runs++;
      await Effect.runPromise(
        Effect.provide(program as Effect.Effect<unknown, never, SaasCrm>, noopLayer()),
      );
    };

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u11", email: "selfhosted@test.com" },
      }),
    ).resolves.toBeUndefined();
    expect(runs).toBe(1);
    expect(upsertLeadCalls).toHaveLength(0);
  });
});
