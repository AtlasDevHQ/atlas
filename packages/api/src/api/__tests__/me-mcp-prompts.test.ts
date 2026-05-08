/**
 * `/api/v1/me/mcp-prompts` route tests (#2179 — Settings → AI Agents prompts preview).
 *
 * The HTTP endpoint and the MCP server's `prompts/list` handler both
 * delegate to `listMcpPrompts` in `@atlas/mcp/prompts/listing` so the
 * Settings → AI Agents preview block can show what an agent will see
 * without round-tripping through MCP. These tests pin:
 *
 *   - 200 returns `{ prompts, canonicalGate }` shape, source bucketed
 *   - canonicalGate envelope present + reason key when gated off
 *   - Workspace isolation: route hands `user.activeOrganizationId` to
 *     the listing module; cross-workspace bleed would require the
 *     route to read a different field
 *   - 401 unauth, 200-empty when no active org, 500 with requestId on
 *     listing failure
 *
 * The mock replaces `@atlas/mcp/prompts/listing` wholesale — listing.ts
 * has its own unit tests in packages/mcp; this file proves the route
 * forwards correctly without re-exercising the registry / gating /
 * scanner stack.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

interface CapturedListCall {
  workspaceId?: string;
}

const listCalls: CapturedListCall[] = [];

let mockListResult: {
  prompts: Array<{
    name: string;
    description?: string;
    arguments: Array<{ name: string; description: string; required: boolean }>;
    source: "builtin" | "canonical" | "semantic" | "library";
  }>;
  canonicalGate: {
    exposed: boolean;
    toggle: "always" | "never" | "auto";
    reason: "toggle-never" | "no-demo-signal" | "signal-unavailable" | null;
  };
} = {
  prompts: [],
  canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
};

let mockListThrow: Error | null = null;

// CLAUDE.md "Mock all exports": registry.ts imports BUILTIN_TEMPLATES /
// loadSemanticPrompts / loadLibraryPrompts from this same module path,
// and the API server's startup `try { import("@atlas/mcp/hosted") }`
// transitively loads registry — a partial mock here would surface as a
// `SyntaxError: Export named '<x>' not found` in the index startup log
// (visible but non-fatal) and could break unrelated test files that
// share the loader cache.
mock.module("@atlas/mcp/prompts/listing", () => ({
  listMcpPrompts: async (opts: { workspaceId?: string }) => {
    listCalls.push({ workspaceId: opts.workspaceId });
    if (mockListThrow) throw mockListThrow;
    return mockListResult;
  },
  BUILTIN_TEMPLATES: [],
  loadSemanticPrompts: () => [],
  loadLibraryPrompts: async () => [],
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "user-1",
    mode: "managed",
    label: "user@test.com",
    role: "member",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function meRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
  });
}

beforeEach(() => {
  listCalls.length = 0;
  mockListThrow = null;
  mocks.setMember("org-alpha");
});

// ---------------------------------------------------------------------------
// GET /api/v1/me/mcp-prompts
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/mcp-prompts", () => {
  it("returns the prompt list shape with source bucketing and gate envelope", async () => {
    mockListResult = {
      prompts: [
        {
          name: "revenue-trend",
          description: "Revenue trends",
          arguments: [
            { name: "period", description: "p", required: true },
          ],
          source: "builtin",
        },
        {
          name: "canonical-monthly-revenue",
          description: "Canonical: monthly revenue",
          arguments: [],
          source: "canonical",
        },
        {
          name: "entity-orders-monthly",
          description: "Monthly orders",
          arguments: [],
          source: "semantic",
        },
        {
          name: "library-1",
          description: "[Adoption] Adoption?",
          arguments: [],
          source: "library",
        },
      ],
      canonicalGate: { exposed: true, toggle: "always", reason: null },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as typeof mockListResult;
    expect(body.prompts.map((p) => p.name)).toEqual([
      "revenue-trend",
      "canonical-monthly-revenue",
      "entity-orders-monthly",
      "library-1",
    ]);
    expect(body.canonicalGate).toEqual({
      exposed: true,
      toggle: "always",
      reason: null,
    });

    // Source counts surface 1-1 from listMcpPrompts so the preview block
    // can group without re-deriving from name prefixes.
    const counts = body.prompts.reduce<Record<string, number>>((acc, p) => {
      acc[p.source] = (acc[p.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      builtin: 1,
      canonical: 1,
      semantic: 1,
      library: 1,
    });
  });

  it("forwards the caller's active workspace id to listMcpPrompts", async () => {
    mockListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.workspaceId).toBe("org-alpha");
  });

  it("does NOT leak prompts across workspaces — workspaceId is the active org, not a query param", async () => {
    // Cross-tenant probe attempt: the route signature has no body / query
    // for `workspaceId`. Even if a regression added one, the test would
    // fail because `listCalls[0].workspaceId` must equal the auth user's
    // activeOrganizationId, not the smuggled value.
    const res = await app.fetch(
      meRequest("/api/v1/me/mcp-prompts?workspaceId=org-beta"),
    );
    expect(res.status).toBe(200);
    expect(listCalls[0]?.workspaceId).toBe("org-alpha");
    expect(listCalls[0]?.workspaceId).not.toBe("org-beta");
  });

  it("includes the gate envelope with reason='toggle-never' when canonical prompts are gated off", async () => {
    mockListResult = {
      prompts: [
        {
          name: "revenue-trend",
          description: "Revenue trends",
          arguments: [],
          source: "builtin",
        },
      ],
      canonicalGate: { exposed: false, toggle: "never", reason: "toggle-never" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockListResult;
    expect(body.canonicalGate.exposed).toBe(false);
    expect(body.canonicalGate.toggle).toBe("never");
    expect(body.canonicalGate.reason).toBe("toggle-never");
    // Closed gate hides canonical entries — the UI banner replaces them.
    expect(body.prompts.filter((p) => p.source === "canonical")).toEqual([]);
  });

  it("includes the gate envelope with reason='no-demo-signal' on auto without demo signals", async () => {
    mockListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockListResult;
    expect(body.canonicalGate).toEqual({
      exposed: false,
      toggle: "auto",
      reason: "no-demo-signal",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Authentication required",
      }),
    );

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(401);
    expect(listCalls).toHaveLength(0);
  });

  it("returns an empty payload when the user has no active organization (graceful)", async () => {
    // No active org: the listing pipeline still runs (built-ins are
    // workspace-independent), but canonical gate fails closed because the
    // demo signals require a workspaceId. The listing module already
    // tolerates `workspaceId: undefined`; the route forwards it as-is.
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
          // no activeOrganizationId
        },
      }),
    );

    mockListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    expect(listCalls[0]?.workspaceId).toBeUndefined();
  });

  it("ignores a smuggled `workspaceId` query param even when the user has no active org", async () => {
    // Defense-in-depth for tenant isolation. The route reads
    // `user.activeOrganizationId` directly today, so a `?workspaceId=`
    // query param has no effect — but a future regression that fell
    // back to `c.req.query("workspaceId")` when `activeOrganizationId`
    // is undefined would tenant-bleed canonical prompts to anyone who
    // could guess an org id. This test pins the contract: an unbound
    // user always forwards `undefined`, never the smuggled value.
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
        },
      }),
    );

    const res = await app.fetch(
      meRequest("/api/v1/me/mcp-prompts?workspaceId=org-victim"),
    );
    expect(res.status).toBe(200);
    expect(listCalls[0]?.workspaceId).toBeUndefined();
    expect(listCalls[0]?.workspaceId).not.toBe("org-victim");
  });

  it("forwards the new 'signal-unavailable' reason when canonical gate probes error", async () => {
    // Distinguishes the operator-facing internal-DB outage signal from
    // "this isn't a demo workspace." The route is a passthrough so this
    // is mostly a wire-compat check — the Zod schema must accept the
    // new enum value end-to-end.
    mockListResult = {
      prompts: [],
      canonicalGate: {
        exposed: false,
        toggle: "auto",
        reason: "signal-unavailable",
      },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockListResult;
    expect(body.canonicalGate.reason).toBe("signal-unavailable");
  });

  it("returns 500 with requestId when listMcpPrompts throws", async () => {
    mockListThrow = new Error("scanEntities exploded");

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });
});
