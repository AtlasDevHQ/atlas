/**
 * #5189 — dashboards are gated by workspace PERMISSIONS, not by admin ROLE.
 *
 * Before this, every dashboards route was built through `createAdminRouter()`.
 * That has two consequences these tests pin, and they pull in opposite
 * directions — which is why both halves are here:
 *
 *   1. **Non-admins were denied outright.** `adminAuth` 403'd anyone outside
 *      {admin, owner, platform_admin} before `checkPermission` ever ran, so the
 *      permission system could only ever subtract from admin. An `analyst` —
 *      whose entire job description is querying data — could not open a
 *      dashboard. The tests below prove a non-admin now can.
 *   2. **Admins were denied by the MFA gate.** `mfaRequired` fires for an
 *      unenrolled owner, which is #5188's prod loop: every fresh SaaS signup is
 *      their org's `owner` (Better Auth `creatorRole`) with no second factor on
 *      file, so the gate fired on their very first visit. That exact repro is a
 *      test here.
 *
 * The third group is the one that keeps the change from being a widening: the
 * new router must not become a WEAKER path to the same data than the admin
 * router it replaces. API keys stay denied, `mode: "none"` stays refused under
 * SaaS, and an authorization-layer fault still fails closed.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// A brand-new SaaS signup: `owner` role, and NO `twoFactorEnabled` claim. The
// helper defaults admin-ish roles to `{ twoFactorEnabled: true }` precisely so
// unrelated suites clear the MFA gate — passing an explicit empty `claims`
// re-creates the unenrolled state that #5188 reproduced in US prod.
const mocks = createApiTestMocks({
  authUser: {
    id: "owner-fresh",
    mode: "managed",
    label: "new@signup.test",
    role: "owner",
    activeOrganizationId: "org-dash",
    claims: {},
  },
});

type CheckPermissionResult = { body: Record<string, unknown>; status: 403 | 503 } | null;

const denialFor = (
  permission: string,
  requestId = "test-req",
): { body: Record<string, unknown>; status: 403 } => ({
  body: {
    error: "insufficient_permissions",
    message: `This action requires the "${permission}" permission.`,
    requestId,
  },
  status: 403,
});

const mockCheckPermission: Mock<
  (user: unknown, permission: string, requestId: string) => Effect.Effect<CheckPermissionResult>
> = mock(() => Effect.succeed(null as CheckPermissionResult));

void mock.module("@atlas/api/lib/effect/enterprise-layer", () => {
  const { makeTestEnterpriseLayer } =
    // oxlint-disable-next-line @typescript-eslint/no-require-imports -- `mock.module()` factory must be synchronous (feedback_bun_test_async_mock_module)
    require("@atlas/api/__test-utils__/makeTestEnterpriseLayer") as typeof import("@atlas/api/__test-utils__/makeTestEnterpriseLayer");
  return makeTestEnterpriseLayer({
    RolesPolicy: { checkPermission: mockCheckPermission as never },
  });
});

// Keep the handlers off the DB — every assertion here is about the gate in
// front of them, and a handler that 500s on a missing table would mask the
// difference between "allowed through" and "denied".
const realDashboards = await import("@atlas/api/lib/dashboards");
void mock.module("@atlas/api/lib/dashboards", () => ({
  ...realDashboards,
  listDashboards: mock(async () => ({
    ok: true as const,
    data: { dashboards: [], total: 0 },
  })),
  createDashboard: mock(async () => ({
    ok: true as const,
    data: { id: "d-1", title: "T", updatedAt: "2026-08-13T00:00:00Z", cardCount: 0 },
  })),
}));

const { app } = await import("../../index");

const MOUNT = "/api/v1/dashboards";

function req(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Cookie: "atlas-session=x" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  // The index is registered as `/api/v1/dashboards`, with no trailing slash —
  // requesting `…/dashboards/` 404s and would make every assertion below pass
  // vacuously against a route that was never reached.
  const suffix = path === "/" ? "" : path;
  return new Request(`http://localhost${MOUNT}${suffix}`, init);
}

const VALID_ID = "01JQ0000000000000000000000";

/**
 * The full route table, with the flag each route is expected to enforce.
 *
 * READ is the whole VIEWING path, which is deliberately not the same as "the
 * GET routes": a dashboard paints itself by POSTing `/render` per card, and
 * `/refresh` and `/export` are likewise things you do to a board you are
 * looking at. Classifying by HTTP method would leave a read-only `viewer` able
 * to list a dashboard and unable to see anything on it.
 */
const ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  permission: "dashboards:read" | "dashboards:write";
  body?: unknown;
}> = [
  { method: "GET", path: "/", permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/draft`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/draft/status`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/share`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions/s-1`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/screenshot`, permission: "dashboards:read" },
  { method: "POST", path: `/${VALID_ID}/cards/c-1/render`, permission: "dashboards:read", body: {} },
  { method: "POST", path: `/${VALID_ID}/cards/c-1/refresh`, permission: "dashboards:read", body: {} },
  { method: "POST", path: `/${VALID_ID}/refresh`, permission: "dashboards:read", body: {} },
  { method: "POST", path: `/${VALID_ID}/export`, permission: "dashboards:read", body: { format: "pdf" } },
  { method: "POST", path: "/", permission: "dashboards:write", body: { title: "T" } },
  { method: "POST", path: `/${VALID_ID}/draft/publish`, permission: "dashboards:write", body: {} },
  { method: "POST", path: `/${VALID_ID}/draft/discard`, permission: "dashboards:write", body: {} },
  { method: "POST", path: `/${VALID_ID}/draft/rebase`, permission: "dashboards:write", body: {} },
  { method: "POST", path: `/${VALID_ID}/draft/undo`, permission: "dashboards:write", body: {} },
  { method: "PATCH", path: `/${VALID_ID}`, permission: "dashboards:write", body: { title: "T2" } },
  { method: "DELETE", path: `/${VALID_ID}`, permission: "dashboards:write" },
  { method: "POST", path: `/${VALID_ID}/cards`, permission: "dashboards:write", body: {} },
  { method: "PATCH", path: `/${VALID_ID}/cards/c-1`, permission: "dashboards:write", body: {} },
  { method: "DELETE", path: `/${VALID_ID}/cards/c-1`, permission: "dashboards:write" },
  { method: "POST", path: `/${VALID_ID}/share`, permission: "dashboards:write", body: {} },
  { method: "DELETE", path: `/${VALID_ID}/share`, permission: "dashboards:write" },
  { method: "POST", path: `/${VALID_ID}/suggest`, permission: "dashboards:write", body: {} },
  { method: "POST", path: "/preview-card", permission: "dashboards:write", body: { sql: "SELECT 1" } },
];

/**
 * The fresh-signup default: `owner`, no second factor on file.
 *
 * `setOrgAdmin`/`setMember` cannot express this — they hardcode
 * `claims: { twoFactorEnabled: true }` so admin suites clear the MFA gate,
 * which is the exact condition under test. The helper documents driving
 * `mockAuthenticateRequest` directly for a non-default `claims` shape.
 */
function authAs(user: {
  id: string;
  role: string;
  claims?: Record<string, unknown>;
}): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: user.id,
        mode: "managed" as const,
        label: `${user.id}@test.com`,
        role: user.role,
        activeOrganizationId: "org-dash",
        claims: user.claims ?? {},
      },
    } as never),
  );
}

beforeEach(() => {
  mockCheckPermission.mockReset();
  mockCheckPermission.mockImplementation(() => Effect.succeed(null as CheckPermissionResult));
  authAs({ id: "owner-fresh", role: "owner" });
});

// ── Coverage: no route may exist without a decision ──────────────────

describe("#5189 — no dashboards route may exist without a permission decision", () => {
  /**
   * Compares what the app has REGISTERED against what this file tests. A route
   * added without a row in `ROUTES` fails here, and the only way to add the row
   * is to pick a flag — so "someone added a route and forgot the gate" cannot
   * ship green.
   *
   * Read off the composed `app` rather than the source text on purpose. A
   * lexical guard is the wrong instrument twice over: it cannot see a route
   * registered through a helper, and it counts a `middleware:` line inside a
   * COMMENT as a gate — the class #5160 was bitten by.
   *
   * Tagging the gate closure and looking for the tag was tried first and does
   * NOT work: `app.route()` WRAPS a sub-app's handlers, so the property is gone
   * by the time the route is mounted. Measured — that version found zero tags
   * across all 26 routes, which is to say it would have passed by finding
   * nothing, on any tree, forever.
   */
  const registered = new Set<string>();
  for (const entry of app.routes) {
    if (!entry.path.startsWith(MOUNT)) continue;
    if (entry.method === "ALL") continue; // router-level middleware, not a route
    registered.add(`${entry.method} ${entry.path}`);
  }

  // `ROUTES` writes paths the way a caller does; Hono registers them with `:id`
  // placeholders. Normalize the table, never the registry — deriving the
  // expectation from the thing under test is how a coverage check stops being
  // able to fail.
  const tested = new Set(
    ROUTES.map(
      (r) =>
        `${r.method} ${MOUNT}${r.path === "/" ? "" : r.path}`
          .replace(VALID_ID, ":id")
          .replace("/cards/c-1", "/cards/:cardId")
          .replace("/sessions/s-1", "/sessions/:sessionId"),
    ),
  );

  it("tests every registered route", () => {
    expect([...registered].filter((r) => !tested.has(r)).sort()).toEqual([]);
  });

  it("tests no route that is not registered", () => {
    // The other direction: a stale row that silently stopped exercising
    // anything (a renamed path) would otherwise keep reporting coverage.
    expect([...tested].filter((r) => !registered.has(r)).sort()).toEqual([]);
  });

  it("covers 26 routes", () => {
    expect(registered.size).toBe(26);
  });

  it("leaves the public share route outside the gated mount", () => {
    // `/{token}` lives on `publicDashboards` at `/api/public/dashboards` and
    // must never acquire a workspace permission gate — the whole point of a
    // share link is that it works without one.
    expect([...registered].filter((r) => r.includes(":token"))).toEqual([]);
  });
});

// ── The flag each route enforces ─────────────────────────────────────

describe("#5189 — each route enforces its OWN flag", () => {
  for (const r of ROUTES) {
    it(`${r.method} ${r.path} → checkPermission("${r.permission}")`, async () => {
      await app.fetch(req(r.path, r.method, r.body));
      const seen = mockCheckPermission.mock.calls.map((c) => c[1]);
      expect(seen).toContain(r.permission);
    });
  }

  for (const r of ROUTES) {
    it(`${r.method} ${r.path} → 403 when ${r.permission} is denied`, async () => {
      mockCheckPermission.mockImplementation((_u, permission, requestId) =>
        Effect.succeed(
          permission === r.permission ? denialFor(permission, requestId) : null,
        ),
      );
      const res = await app.fetch(req(r.path, r.method, r.body));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_permissions");
    });
  }
});

// ── The two gates are INDEPENDENT ────────────────────────────────────

describe("#5189 — read and write gates do not leak into each other", () => {
  /**
   * This is the property that rejected the obvious implementation. Mounting a
   * read router and a write router at the same path does NOT isolate their
   * `use()` chains — measured on hono 4 / `@hono/zod-openapi` 1.5, the read
   * router's gate also runs on the write router's routes. A write would then
   * silently require BOTH flags, passing today only because every write-capable
   * role happens to also hold read. Declaring the gate per route is what makes
   * these two tests possible at all.
   */
  const READ_ROUTE = ROUTES.find((r) => r.permission === "dashboards:read")!;
  const WRITE_ROUTE = ROUTES.find((r) => r.permission === "dashboards:write")!;

  it("denying read does not block a write route", async () => {
    mockCheckPermission.mockImplementation((_u, permission, requestId) =>
      Effect.succeed(
        permission === "dashboards:read" ? denialFor(permission, requestId) : null,
      ),
    );
    const res = await app.fetch(req(WRITE_ROUTE.path, WRITE_ROUTE.method, WRITE_ROUTE.body));
    expect(res.status).not.toBe(403);
  });

  it("denying write does not block a read route", async () => {
    mockCheckPermission.mockImplementation((_u, permission, requestId) =>
      Effect.succeed(
        permission === "dashboards:write" ? denialFor(permission, requestId) : null,
      ),
    );
    const res = await app.fetch(req(READ_ROUTE.path, READ_ROUTE.method, READ_ROUTE.body));
    expect(res.status).not.toBe(403);
  });
});

// ── #5188's prod repro, and the non-admin admission ──────────────────

describe("#5188 — an unenrolled owner is no longer blocked from dashboards", () => {
  it("GET / does not 403 for an owner with no second factor on file", async () => {
    // The exact prod shape: `owner` (Better Auth `creatorRole` on every fresh
    // signup), `claims: {}` (no TOTP, no passkey). Under `createAdminRouter()`
    // this returned 403 `mfa_enrollment_required`, which the web turned into an
    // unbreakable /login loop.
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
  });

  it("never answers mfa_enrollment_required on a dashboards route", async () => {
    // The MFA scope decision, asserted rather than described: dashboards left
    // the admin perimeter, so this code cannot originate here. If a future
    // change remounts them on `createAdminRouter()`, this reddens.
    for (const r of ROUTES) {
      const res = await app.fetch(req(r.path, r.method, r.body));
      if (res.status !== 403) continue;
      const body = (await res.json()) as { error?: string };
      expect(body.error).not.toBe("mfa_enrollment_required");
    }
  });
});

describe("#5189 — a non-admin role reaches dashboards", () => {
  it("admits a member whose resolved permissions carry the flag", async () => {
    authAs({ id: "u-member", role: "member" });
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
    // The gate ran — a 200 that skipped authorization entirely would be a
    // different (worse) bug wearing the same status code.
    expect(mockCheckPermission).toHaveBeenCalled();
    expect(mockCheckPermission.mock.calls.map((c) => c[1])).toContain("dashboards:read");
  });
});

// ── Not a weaker path than the admin router it replaces ──────────────

describe("#5189 — the workspace gate keeps adminAuth's non-role guards", () => {
  it("still denies a workspace API key", async () => {
    // `API_KEY_MARKER_CLAIM` — the claim `resolveActorKind` actually reads, and
    // it tests for `=== true`, so a truthy string would resolve to "human" and
    // this test would assert the deny while exercising the human path.
    authAs({ id: "key-1", role: "owner", claims: { api_key: true } });
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("api_key_not_permitted");
  });

  it("fails CLOSED with 503 when the authorization layer is unavailable", async () => {
    // `permissions_unavailable`, not `insufficient_permissions` — "we could not
    // determine your permissions" must never be reported as "you lack them".
    mockCheckPermission.mockImplementation((_u, _p, requestId) =>
      Effect.succeed({
        body: { error: "permissions_unavailable", message: "unavailable", requestId },
        status: 503 as const,
      }),
    );
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("permissions_unavailable");
  });

  it("fails CLOSED with 503 when the permission check THROWS", async () => {
    mockCheckPermission.mockImplementation(() => {
      throw new Error("roles table exploded");
    });
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("permissions_unavailable");
  });
});
