/**
 * Tests for `POST /api/v1/explore` (#4049 / ADR-0027 sibling endpoint).
 *
 * The explore REST endpoint exposes the read-only semantic-directory `explore`
 * capability (ls/cat/grep/find on `semantic/`, path-traversal protected,
 * sandboxed) over HTTP, reusing the shared `lib/tools/explore` facade.
 *
 * Per ADR-0027's shared gate-parity contract, `explore` is metadata-only:
 *   - NO billing gate (mirrors the MCP `explore` omitting `checksBilling`)
 *   - member floor (inherited from `standardAuth`)
 *   - workspace isolation derived from the credential, never the request body
 *   - audited `origin=cli` via the request-context binding (no audit_log row —
 *     explore touches no datasource; the origin rides on the structured log)
 *
 * Command-level failures (a `grep` that matches nothing, a missing file) are
 * NORMAL for an exploration tool: the facade returns an `Error:`/`Error (exit
 * N):`-prefixed string as its output, and the route surfaces that as a 200
 * body — NOT an HTTP 5xx. Only an infrastructure failure (backend init throw)
 * is a 500.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// ── Auth mock ──────────────────────────────────────────────────────────────

let fakeAuth: (AuthResult & { authenticated: true }) | null = null;

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve(
      fakeAuth ?? { authenticated: false, status: 401 as const, error: "anonymous" },
    ),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

void mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

void mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

// The IP allowlist runs inside `standardAuth` via `runEnterprise(IpAllowlistPolicy…)`.
// Curated stub: `runEnterprise` is the ONLY enterprise-layer export the route's
// middleware path reaches, so we stub just it (the others — `EnterpriseLayer`,
// `getEnterpriseRuntime` — aren't on this graph; provided as inert names to keep
// the module's load-time shape complete). `ipAllowed` toggles the
// `ip_not_allowed` 403 branch; default-allow keeps every other test green.
let ipAllowed = true;
void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: async () => ({ allowed: ipAllowed }),
  EnterpriseLayer: undefined,
  getEnterpriseRuntime: () => null,
}));

// Capture what the route binds into the request context so we can assert the
// origin=cli + actor.kind audit triple (ADR-0027 sub-decision 6) actually flows.
let capturedContexts: Array<Record<string, unknown>> = [];

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
      capturedContexts.push(ctx);
      return fn();
    },
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

// ── Explore facade mock ──────────────────────────────────────────────────────
//
// Replace the shared `lib/tools/explore` facade so the route is tested without
// booting a real sandbox backend. The route is a thin HTTP wrapper: it must
// pass `{ command }` straight through and surface the prose string the facade
// returns. `exploreImpl` is swapped per-test to exercise success / command
// failure / infra throw.

let exploreImpl: (args: { command: string }) => Promise<string> = async () => "(no output)";
let exploreCalls: Array<{ command: string }> = [];

void mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "explore",
    execute: (args: { command: string }) => {
      exploreCalls.push(args);
      return exploreImpl(args);
    },
  },
}));

const { explore } = await import("../explore");

function userAuth(
  opts: { orgId?: string | null; role?: "member" | "admin" | "owner"; origin?: string } = {},
): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-1",
      mode: "managed",
      label: "user@test.dev",
      role: opts.role ?? "member",
      activeOrganizationId: opts.orgId === null ? undefined : opts.orgId ?? "org-1",
      ...(opts.origin ? { claims: { origin: opts.origin } } : {}),
    },
  };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return explore.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  fakeAuth = null;
  capturedContexts = [];
  exploreCalls = [];
  exploreImpl = async () => "(no output)";
  ipAllowed = true;
});

describe("POST /api/v1/explore — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = null;
    const res = await post({ command: "ls" });
    expect(res.status).toBe(401);
    expect(exploreCalls).toHaveLength(0);
  });

  it("allows a member (member floor, no admin required)", async () => {
    fakeAuth = userAuth({ role: "member" });
    exploreImpl = async () => "catalog.yml\nentities";
    const res = await post({ command: "ls" });
    expect(res.status).toBe(200);
  });

  it("returns 403 ip_not_allowed (the route's only 403 — standardAuth IP allowlist) with a requestId", async () => {
    // Explore has NO role gate; the sole 403 it can produce comes from the
    // shared standardAuth IP allowlist. Pin that path here (the milestone-#77
    // review flagged it as uncovered) — including the requestId for correlation.
    fakeAuth = userAuth({ role: "member" });
    ipAllowed = false;
    const res = await post({ command: "ls" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("ip_not_allowed");
    expect(body.requestId).toBeDefined();
    // The IP gate runs before the handler — the facade is never invoked.
    expect(exploreCalls).toHaveLength(0);
  });
});

describe("POST /api/v1/explore — facade reuse + output", () => {
  it("passes the command straight through to the explore facade and returns its output", async () => {
    fakeAuth = userAuth();
    exploreImpl = async ({ command }) => `ran: ${command}`;
    const res = await post({ command: "cat catalog.yml" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toBe("ran: cat catalog.yml");
    expect(exploreCalls).toEqual([{ command: "cat catalog.yml" }]);
  });

  it("surfaces a command-level failure string as a 200 body, NOT an HTTP error", async () => {
    // `grep` matching nothing exits non-zero — the facade returns an
    // `Error (exit N):` string. For an exploration tool this is a normal
    // result, so it must be a 200 with the string in the body, never a 5xx.
    fakeAuth = userAuth();
    exploreImpl = async () => "Error (exit 1):\n";
    const res = await post({ command: "grep nonexistent ." });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toBe("Error (exit 1):\n");
  });

  it('surfaces a backend-unavailable "Error:" string as a 200 body too (facade self-handles infra)', async () => {
    fakeAuth = userAuth();
    exploreImpl = async () => "Error: Explore tool is unavailable — backend down";
    const res = await post({ command: "ls" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("unavailable");
  });

  it("returns 500 when the facade itself throws (infrastructure failure)", async () => {
    fakeAuth = userAuth();
    exploreImpl = async () => {
      throw new Error("boom");
    };
    const res = await post({ command: "ls" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeDefined();
  });
});

describe("POST /api/v1/explore — request validation", () => {
  it("returns 422 with the shared validation_error envelope for an empty command", async () => {
    // Pins the parity the dropped inline hook was about (#4113): validation now
    // falls through to the router's shared `validationHook`, which returns the
    // same `{ error: "validation_error", message, details }` envelope as the
    // sibling routes — not a bespoke per-route shape.
    fakeAuth = userAuth();
    const res = await post({ command: "   " });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details?: unknown[] };
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
    expect(exploreCalls).toHaveLength(0);
  });

  it("returns 422 for a missing command field", async () => {
    fakeAuth = userAuth();
    const res = await post({});
    expect(res.status).toBe(422);
    expect(exploreCalls).toHaveLength(0);
  });

  it("returns 422 for a command over the max length bound", async () => {
    fakeAuth = userAuth();
    const res = await post({ command: "a".repeat(4001) });
    expect(res.status).toBe(422);
    expect(exploreCalls).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    fakeAuth = userAuth();
    const res = await post("{ not json");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/explore — audit origin (ADR-0027 sub-decision 6)", () => {
  it("binds agentOrigin=cli + actor.kind=human into the request context for a device-flow bearer", async () => {
    fakeAuth = userAuth({ origin: "cli" });
    exploreImpl = async () => "ok";
    await post({ command: "ls" });
    // The route's explicit inner withRequestContext carries the origin claim.
    const exploreCtx = capturedContexts.find((c) => c.agentOrigin !== undefined);
    expect(exploreCtx?.agentOrigin).toBe("cli");
    expect(exploreCtx?.actor).toEqual({ kind: "human" });
  });

  it("does NOT mislabel a non-cli session as cli (origin derived from claims, not hardcoded)", async () => {
    fakeAuth = userAuth({ origin: undefined }); // e.g. a web session
    exploreImpl = async () => "ok";
    await post({ command: "ls" });
    const exploreCtx = capturedContexts.find((c) => c.actor !== undefined);
    // No origin claim → agentOrigin stays undefined (not forced to "cli").
    expect(exploreCtx?.agentOrigin).toBeUndefined();
  });

  it("re-threads the developer atlasMode through the inner bind (withRequestContext replaces, not merges)", async () => {
    // Regression guard for the round-1 critical: the inner withRequestContext is
    // AsyncLocalStorage.run, which REPLACES the context. Dropping atlasMode would
    // silently downgrade a developer-mode caller to the published overlay inside
    // exploreTool.execute (`reqCtx.atlasMode ?? "published"`). Use an owner +
    // the developer-mode header so the middleware resolves `atlasMode:
    // "developer"` (members always resolve to published, which would mask the
    // bug) — then assert the inner bind preserves that exact value.
    fakeAuth = userAuth({ role: "owner" });
    exploreImpl = async () => "ok";
    await post({ command: "ls" }, { "x-atlas-mode": "developer" });
    const exploreCtx = capturedContexts.find((c) => c.actor !== undefined);
    expect(exploreCtx?.atlasMode).toBe("developer");
  });
});

describe("POST /api/v1/explore — workspace isolation (ADR-0027 sub-decision 5)", () => {
  it("ignores any org/workspace/connection field in the request body", async () => {
    // The org is a property of the credential — a body-supplied org must not
    // change the command or be forwarded to the facade.
    fakeAuth = userAuth({ orgId: "org-1" });
    exploreImpl = async ({ command }) => `ran: ${command}`;
    const res = await post({ command: "ls", orgId: "org-2", workspaceId: "org-2" });
    expect(res.status).toBe(200);
    // Only `command` reaches the facade.
    expect(exploreCalls).toEqual([{ command: "ls" }]);
  });
});
