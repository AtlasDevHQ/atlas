/**
 * Wiring test (#3653): the AsyncLocalStorage signup-origin actually propagates
 * from `runWithSignupOrigin("mcp", …)` THROUGH the real composed
 * `databaseHooks.user.create.after` hook into `dispatchSignupCrmLead`, so the
 * generic SIGNUP CRM lead is suppressed on the MCP self-serve path.
 *
 * Why this exists beyond the helper-level suppression test in
 * `dispatch-signup-crm-lead.test.ts`: that test calls `dispatchSignupCrmLead`
 * DIRECTLY inside the ALS scope (same call stack), so it only proves
 * `getSignupOrigin()` reads back a value set one frame up. It cannot catch the
 * regression this feature actually fears — a future edit to `buildAuthOptions`'s
 * `user.create.after` that DEFERS or un-awaits the dispatch (setTimeout /
 * detached microtask / fire-and-forget). That would drop the ALS context and
 * silently un-suppress SIGNUP, corrupting MCP_SIGNUP first-touch attribution
 * with zero test failure.
 *
 * This test extracts the EXACT composed `after` hook Atlas ships and drives it
 * through genuine await boundaries inside the ALS scope (mirroring Better Auth's
 * internal awaits between `signUpEmail` and the after hook firing). If someone
 * un-awaits or defers the dispatch, the suppression assertion (mcp → 0 leads)
 * flips; the paired web assertion (no origin → 1 lead) guards the inverse, so a
 * deferral that drops BOTH paths can't hide either.
 *
 * The welcome-email `setTimeout` inside the after hook has a 2s delay and is
 * fire-and-forget — it never runs before these synchronous assertions and the
 * logger is mocked, so the email/internal-DB modules it would touch need no
 * stubbing.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmLeadInput,
  type SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mock storage state (mirrors dispatch-signup-crm-lead.test.ts) ───

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;
const upsertLeadCalls: SaasCrmLeadInput[] = [];

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogError: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogDebug: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
  // CLAUDE.md "Mock all exports" — the canonical module also exports
  // EnterpriseLayer; a partial mock surfaces as a cross-file SyntaxError under
  // bun's parallel workers.
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

// ── Import the units under test AFTER mocks ─────────────────────────

const { buildPlugins, buildAuthOptions, parseAuthSecret } = await import("../server");
const { runWithSignupOrigin } = await import("../signup-origin");

function recordingLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: (input: SaasCrmLeadInput) => {
      upsertLeadCalls.push(input);
      return Effect.void;
    },
  } as unknown as SaasCrmShape);
}

function authDeps(plugins: ReturnType<typeof buildPlugins>) {
  return {
    env: process.env,
    secret: parseAuthSecret("test-secret-at-least-32-characters-long"),
    baseURL: undefined,
    database: undefined,
    cookiePrefix: "atlas",
    socialProviders: undefined,
    plugins,
    trustedOrigins: ["https://app.useatlas.dev"],
    bootstrapAdmin: { mode: "none" as const },
  };
}

/** Extract the EXACT composed user.create.after hook Atlas ships. */
function getUserCreateAfter() {
  const options = buildAuthOptions(authDeps(buildPlugins()));
  const hook = (
    options as {
      databaseHooks?: { user?: { create?: { after?: unknown } } };
    }
  ).databaseHooks?.user?.create?.after;
  expect(
    typeof hook,
    "user.create.after must be composed in buildAuthOptions",
  ).toBe("function");
  return hook as (user: {
    id: string;
    email?: string | null;
    name?: string | null;
  }) => Promise<void>;
}

beforeEach(() => {
  upsertLeadCalls.length = 0;
  mockLogWarn.mockClear();
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogDebug.mockClear();
  runEnterpriseImpl = async (program) => {
    await Effect.runPromise(
      Effect.provide(
        program as Effect.Effect<unknown, never, SaasCrm>,
        recordingLayer(),
      ),
    );
  };
});

describe("user.create.after — ALS signup-origin propagation (#3653)", () => {
  it("suppresses the SIGNUP lead when the composed hook runs inside runWithSignupOrigin('mcp') across await boundaries", async () => {
    const after = getUserCreateAfter();

    await runWithSignupOrigin("mcp", async () => {
      // Genuine async hops between the ALS bind and the hook firing — stands in
      // for Better Auth's internal awaits between signUpEmail and user.create.after.
      await Promise.resolve();
      await Promise.resolve().then(() => Promise.resolve());
      await after({ id: "u_mcp", email: "mcp@founder.com", name: "MCP Founder" });
    });

    // The composed hook read origin "mcp" through the ALS context and suppressed
    // the auto-SIGNUP. If the dispatch were ever deferred off the awaited
    // continuation, the context would be lost and this would be 1, not 0.
    expect(upsertLeadCalls).toHaveLength(0);
  });

  it("still enqueues a SIGNUP lead through the same composed hook with no origin bound (web path)", async () => {
    const after = getUserCreateAfter();

    await after({ id: "u_web", email: "web@founder.com", name: "Web Founder" });

    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "signup",
      email: "web@founder.com",
      name: "Web Founder",
    });
  });
});
