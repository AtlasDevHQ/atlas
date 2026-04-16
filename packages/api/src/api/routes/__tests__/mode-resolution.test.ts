/**
 * Unit tests for mode resolution middleware.
 *
 * Tests the resolveMode() pure function directly and verifies that
 * the modeResolution middleware sets the atlasMode context variable.
 */

import { describe, it, expect, mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { resolveMode } = await import("../middleware");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: "org-1",
    },
  };
}

function ownerAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "owner-1",
      mode: "managed",
      label: "owner@test.com",
      role: "owner",
      activeOrganizationId: "org-1",
    },
  };
}

function platformAdminAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "pa-1",
      mode: "managed",
      label: "platform@test.com",
      role: "platform_admin",
      activeOrganizationId: "org-1",
    },
  };
}

function memberAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "member-1",
      mode: "managed",
      label: "member@test.com",
      role: "member",
      activeOrganizationId: "org-1",
    },
  };
}

function noneAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "none",
    user: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveMode", () => {
  // ── Default behavior ────────────────────────────────────────────────

  it("defaults to published when no cookie or header", () => {
    expect(resolveMode(null, null, adminAuth())).toBe("published");
  });

  it("defaults to published when cookie is empty", () => {
    expect(resolveMode("", null, adminAuth())).toBe("published");
  });

  // ── Cookie reading ──────────────────────────────────────────────────

  it("reads developer from atlas-mode cookie for admin", () => {
    expect(resolveMode("atlas-mode=developer", null, adminAuth())).toBe("developer");
  });

  it("reads developer from atlas-mode cookie for owner", () => {
    expect(resolveMode("atlas-mode=developer", null, ownerAuth())).toBe("developer");
  });

  it("reads developer from atlas-mode cookie for platform_admin", () => {
    expect(resolveMode("atlas-mode=developer", null, platformAdminAuth())).toBe("developer");
  });

  it("reads published from atlas-mode cookie", () => {
    expect(resolveMode("atlas-mode=published", null, adminAuth())).toBe("published");
  });

  it("handles atlas-mode cookie among other cookies", () => {
    expect(resolveMode("session=abc; atlas-mode=developer; theme=dark", null, adminAuth())).toBe("developer");
  });

  // ── Header fallback ─────────────────────────────────────────────────

  it("falls back to X-Atlas-Mode header when no cookie", () => {
    expect(resolveMode(null, "developer", adminAuth())).toBe("developer");
  });

  it("cookie takes priority over header", () => {
    expect(resolveMode("atlas-mode=published", "developer", adminAuth())).toBe("published");
  });

  // ── Non-admin always published ──────────────────────────────────────

  it("non-admin (member) always resolves to published even with developer cookie", () => {
    expect(resolveMode("atlas-mode=developer", null, memberAuth())).toBe("published");
  });

  it("non-admin (member) always resolves to published even with developer header", () => {
    expect(resolveMode(null, "developer", memberAuth())).toBe("published");
  });

  // ── Auth mode "none" (local dev) ───────────────────────────────────

  it("auth mode none (local dev) allows developer", () => {
    expect(resolveMode("atlas-mode=developer", null, noneAuth())).toBe("developer");
  });

  it("auth mode none without cookie defaults to published", () => {
    expect(resolveMode(null, null, noneAuth())).toBe("published");
  });

  // ── Invalid cookie values ──────────────────────────────────────────

  it("ignores invalid cookie value and defaults to published", () => {
    expect(resolveMode("atlas-mode=foobar", null, adminAuth())).toBe("published");
  });

  it("ignores invalid header value and defaults to published", () => {
    expect(resolveMode(null, "foobar", adminAuth())).toBe("published");
  });
});

// ---------------------------------------------------------------------------
// Test layer integration — verify mode flows through RequestContext
// ---------------------------------------------------------------------------

describe("RequestContext mode", () => {
  it("createRequestContextTestLayer defaults to published", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.mode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("published");
  });

  it("createRequestContextTestLayer accepts mode override", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer({ mode: "developer" });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.mode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });

  it("buildTestLayer supports mode override via request partial", async () => {
    const { Effect } = await import("effect");
    const { RequestContext } = await import("@atlas/api/lib/effect/services");
    const { buildTestLayer } = await import("../../../__test-utils__/layers");

    const layer = buildTestLayer({ request: { mode: "developer" } });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.mode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });
});
