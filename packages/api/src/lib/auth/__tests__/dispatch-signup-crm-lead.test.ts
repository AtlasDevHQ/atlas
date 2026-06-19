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

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmLeadInput,
  type SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mock storage state (controlled per-test) ────────────────────────

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;
const upsertLeadCalls: SaasCrmLeadInput[] = [];

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogError: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogDebug: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  // Capture the program and resolve the Tag through the unit-test
  // doubles below. The default runner provides a real SaasCrm Layer
  // whose `upsertLead` pushes into `upsertLeadCalls`.
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
  // CLAUDE.md "Mock all exports" rule — the canonical module exports
  // EnterpriseLayer + the EnterpriseSubsystem type. A partial mock
  // surfaces as a cross-file SyntaxError once the test runner moves to
  // bun's `--parallel` workers (slice 6 / #2802).
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

const { dispatchSignupCrmLead, dispatchMcpSignupCrmLead } = await import("../server");
const { runWithSignupOrigin } = await import("../signup-origin");

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
    // #2737 — SaasCrmShape's available:false branch now requires
    // `stampConversion` too. Noop is structurally identical to
    // `upsertLead` here.
    stampConversion: () => Effect.void,
    // #2849 — available:false now also requires `dispatcher`. null
    // = "no way to dispatch anything" (the legitimate noop default).
    dispatcher: null,
  });
}

beforeEach(() => {
  upsertLeadCalls.length = 0;
  mockLogWarn.mockClear();
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogDebug.mockClear();
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
  it("resolves and logs `signup_crm.dispatch_defect` when runEnterprise throws synchronously", async () => {
    runEnterpriseImpl = async () => {
      throw new Error("simulated defect inside runEnterprise");
    };

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u8", email: "die@test.com", name: "X" },
      }),
    ).resolves.toBeUndefined();

    // CLAUDE.md "every catch must log" — pin the defect path emits.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("signup_crm.dispatch_defect");
    expect(logCtx.userId).toBe("u8");
  });

  it("resolves and logs `signup_crm.dispatch_defect` when runEnterprise rejects asynchronously", async () => {
    runEnterpriseImpl = async () => Promise.reject(new Error("async reject"));

    await expect(
      dispatchSignupCrmLead({
        user: { id: "u9", email: "reject@test.com" },
      }),
    ).resolves.toBeUndefined();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("signup_crm.dispatch_defect");
  });

  it("resolves and logs `signup_crm.enqueue_failed` when SaasCrm.upsertLead fails with a typed Error", async () => {
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

    // The typed `Effect.fail` path goes through `Effect.either` Left,
    // not the outer catch — pin that branch independently so a future
    // refactor that drops the Left-side log gets caught here, not by
    // relying on EE's `tapError` for the audit trail. Logged at `error`
    // (not warn): a failed durable enqueue is a permanent lead loss (S-1).
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("signup_crm.enqueue_failed");
    expect(logCtx.userId).toBe("u10");
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

describe("dispatchSignupCrmLead — MCP-origin suppression (#3653)", () => {
  // The MCP self-serve path (provisionTrialWorkspace) emits its own
  // `MCP_SIGNUP` lead. Since `signUpEmail` fires this hook FIRST (earlier
  // `created_at`) and `atlasFirstSource` is sticky first-touch, letting the
  // generic SIGNUP enqueue here would steal first-source from MCP_SIGNUP.
  // So when the signup is MCP-originated, this helper must NOT enqueue.
  it("suppresses the SIGNUP enqueue when the signup origin is 'mcp'", async () => {
    await runWithSignupOrigin("mcp", () =>
      dispatchSignupCrmLead({
        user: { id: "u12", email: "mcp@founder.com", name: "MCP Founder" },
      }),
    );
    // No lead — the MCP path owns the MCP_SIGNUP enqueue itself.
    expect(upsertLeadCalls).toHaveLength(0);
    // The suppression is intentional and logged at debug, not warn/error.
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("still enqueues a SIGNUP lead for an ordinary (web) signup — no origin bound", async () => {
    await dispatchSignupCrmLead({
      user: { id: "u13", email: "web@founder.com", name: "Web Founder" },
    });
    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "signup",
      email: "web@founder.com",
      name: "Web Founder",
    });
  });
});

describe("dispatchMcpSignupCrmLead — happy path", () => {
  it("enqueues an mcp-signup lead with email + name", async () => {
    await dispatchMcpSignupCrmLead({
      email: "Founder@Acme.com",
      name: "Founder Acme",
    });

    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "mcp-signup",
      email: "founder@acme.com",
      name: "Founder Acme",
    });
  });

  it("enqueues without `name` when name is missing / blank", async () => {
    for (const name of [undefined, "", "   ", "\t"]) {
      upsertLeadCalls.length = 0;
      await dispatchMcpSignupCrmLead({ email: "n@acme.com", name });
      expect(upsertLeadCalls).toHaveLength(1);
      expect(upsertLeadCalls[0]).toEqual({
        source: "mcp-signup",
        email: "n@acme.com",
      });
      expect("name" in upsertLeadCalls[0]!).toBe(false);
    }
  });

  it("does nothing when email is missing / blank", async () => {
    for (const email of ["", "   "]) {
      upsertLeadCalls.length = 0;
      await dispatchMcpSignupCrmLead({ email });
      expect(upsertLeadCalls).toHaveLength(0);
    }
  });

  it("resolves and logs a defect when runEnterprise rejects — never throws into the provisioner", async () => {
    runEnterpriseImpl = async () => Promise.reject(new Error("async reject"));

    await expect(
      dispatchMcpSignupCrmLead({ email: "die@acme.com", name: "X" }),
    ).resolves.toBeUndefined();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("mcp_signup_crm.dispatch_defect");
  });

  it("resolves and logs `mcp_signup_crm.enqueue_failed` when SaasCrm.upsertLead fails with a typed Error", async () => {
    runEnterpriseImpl = async (program) => {
      await Effect.runPromise(
        Effect.provide(
          program as Effect.Effect<unknown, never, SaasCrm>,
          failingLayer(new Error("crm_outbox enqueue failed — pg blip")),
        ),
      );
    };

    await expect(
      dispatchMcpSignupCrmLead({ email: "pgblip@acme.com", name: "X" }),
    ).resolves.toBeUndefined();

    // The typed `Effect.fail` path goes through `Effect.either` Left, not the
    // outer catch — pin that branch independently (mirror of the SIGNUP suite's
    // `signup_crm.enqueue_failed` test) so a refactor dropping the Left-side
    // log gets caught here for the MCP path too. Logged at `error` (not warn):
    // a failed durable enqueue is a permanent MCP_SIGNUP lead loss (S-1).
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [logCtx] = mockLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx.event).toBe("mcp_signup_crm.enqueue_failed");
  });
});
