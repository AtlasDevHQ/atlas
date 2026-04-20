/**
 * Unit tests for mode resolution logic.
 *
 * Tests the resolveMode() pure function directly and verifies that
 * RequestContext test layers correctly propagate mode values.
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

const { resolveMode, parseModeFromCookie } = await import("../middleware");
const { resolveStatusClause } = await import("@atlas/api/lib/content-mode/port");

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

function simpleKeyAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "simple-key",
    user: {
      id: "sk-1",
      mode: "simple-key",
      label: "key-user",
      // role is undefined — BYOT/simple-key users may not have explicit roles
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

  // ── User with undefined role (BYOT / simple-key) ────────────────────

  it("user with undefined role resolves to published even with developer cookie", () => {
    expect(resolveMode("atlas-mode=developer", null, simpleKeyAuth())).toBe("published");
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
// parseModeFromCookie
// ---------------------------------------------------------------------------

describe("parseModeFromCookie", () => {
  it("returns undefined for null", () => {
    expect(parseModeFromCookie(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseModeFromCookie("")).toBeUndefined();
  });

  it("reads atlas-mode value when present alone", () => {
    expect(parseModeFromCookie("atlas-mode=developer")).toBe("developer");
  });

  it("reads atlas-mode value among other cookies", () => {
    expect(parseModeFromCookie("session=abc; atlas-mode=developer; theme=dark")).toBe("developer");
  });

  it("is exact-match — different key prefixes do not collide", () => {
    expect(parseModeFromCookie("atlas-mode-other=developer")).toBeUndefined();
  });

  it("returns the full value verbatim — no special handling of unknown values", () => {
    // resolveMode() filters unknown values; parseModeFromCookie just extracts
    expect(parseModeFromCookie("atlas-mode=developer_extra")).toBe("developer_extra");
  });

  it("returns undefined when atlas-mode key is absent", () => {
    expect(parseModeFromCookie("session=abc; theme=dark")).toBeUndefined();
  });
});

// resolveStatusClause is the non-Effect public successor to
// `buildUnionStatusClause` (retired in #1531). The same mode-semantics
// invariants must hold for the simple-table clause regardless of which
// entry point emits it — cover them here so a regression in either the
// Effect path or the direct-call path (getPopularSuggestions) is caught.
// The Effect path has richer coverage in `content-mode/__tests__/registry.test.ts`.
describe("resolveStatusClause (simple content tables)", () => {
  it("published mode restricts to <alias>.status = 'published'", () => {
    expect(resolveStatusClause("query_suggestions", "published", "qs")).toBe(
      "qs.status = 'published'",
    );
  });

  it("developer mode includes draft alongside published", () => {
    expect(resolveStatusClause("query_suggestions", "developer", "qs")).toBe(
      "qs.status IN ('published', 'draft')",
    );
  });

  it("never returns archived in either mode (archived is always excluded)", () => {
    expect(resolveStatusClause("connections", "published", "c")).not.toContain("archived");
    expect(resolveStatusClause("connections", "developer", "c")).not.toContain("archived");
  });

  it("developer mode never surfaces draft_delete via the simple union", () => {
    // Tombstones only apply to semantic_entities (CTE overlay). Connections,
    // prompt_collections, and query_suggestions don't use draft_delete.
    expect(resolveStatusClause("prompt_collections", "developer", "p")).not.toContain(
      "draft_delete",
    );
  });

  it("undefined mode defaults to published (most restrictive)", () => {
    expect(resolveStatusClause("query_suggestions", undefined, "qs")).toBe(
      "qs.status = 'published'",
    );
  });

  it("accepts either the segment key or the physical table name for aliases", () => {
    expect(resolveStatusClause("prompts", "published", "p")).toBe(
      "p.status = 'published'",
    );
    expect(resolveStatusClause("prompt_collections", "published", "p")).toBe(
      "p.status = 'published'",
    );
  });

  it("throws for unregistered tables (prevents typo drift)", () => {
    expect(() => resolveStatusClause("bogus_table", "published", "b")).toThrow(
      /not a registered content-mode table/,
    );
  });

  it("throws for exotic tables — exotic entries need CTE overlays", () => {
    expect(() =>
      resolveStatusClause("semantic_entities", "developer", "s"),
    ).toThrow(/exotic entry/);
  });
});

// ---------------------------------------------------------------------------
// Test layer integration — verify mode flows through RequestContext
// ---------------------------------------------------------------------------

describe("RequestContext atlasMode", () => {
  it("createRequestContextTestLayer defaults to published", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("published");
  });

  it("createRequestContextTestLayer accepts mode override", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer({ atlasMode: "developer" });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });

  it("buildTestLayer supports mode override via request partial", async () => {
    const { Effect } = await import("effect");
    const { RequestContext } = await import("@atlas/api/lib/effect/services");
    const { buildTestLayer } = await import("../../../__test-utils__/layers");

    const layer = buildTestLayer({ request: { atlasMode: "developer" } });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });
});
