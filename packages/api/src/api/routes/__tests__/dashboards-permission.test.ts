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
 *      a built-in role whose purpose is the analyst loop, and which this change
 *      gives both dashboards flags — could not open a dashboard. The tests below prove a non-admin now can.
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

// A brand-new SaaS signup: `owner` role, no second factor on file.
//
// ⚠️ `claims: {}` would NOT produce that — `createApiTestMocks` merges its own
// `defaultClaims` FIRST for admin-ish roles, so an empty object comes back as
// `{ twoFactorEnabled: true }`, i.e. an ENROLLED owner. Hence the explicit
// `false`. Note that `beforeEach` replaces `mockAuthenticateRequest` wholesale
// for every test, so this block documents the shape rather than driving it —
// the state under test is established by `authAs()`.
const mocks = createApiTestMocks({
  authUser: {
    id: "owner-fresh",
    mode: "managed",
    label: "new@signup.test",
    role: "owner",
    activeOrganizationId: "org-dash",
    claims: { twoFactorEnabled: false },
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
 * The line is **does this persist**, not **is this a GET**. READ is the whole
 * VIEWING path, several members of which are POSTs: `/render` per card (the
 * result is explicitly not written to the card cache) and `/export`, neither of
 * which writes. Classifying by HTTP method would leave a read-only `viewer` able
 * to list a dashboard and unable to see anything on it.
 *
 * Two routes go the other way and are WRITEs despite their shape: `/refresh`
 * UPDATEs the PUBLISHED `dashboard_cards` cache every other viewer reads, and
 * `GET /{id}/draft` FORKS on first call — two INSERTs, and the first step of
 * authoring. Its non-forking neighbours (`GET /{id}?view=draft`,
 * `/draft/status`) stay READ.
 */
const ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  permission: "dashboards:read" | "dashboards:write";
  body?: unknown;
}> = [
  { method: "GET", path: "/", permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/draft`, permission: "dashboards:write" },
  { method: "GET", path: `/${VALID_ID}/draft/status`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/share`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions/s-1`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/screenshot`, permission: "dashboards:read" },
  { method: "POST", path: `/${VALID_ID}/cards/c-1/render`, permission: "dashboards:read", body: {} },
  { method: "POST", path: `/${VALID_ID}/cards/c-1/refresh`, permission: "dashboards:write", body: {} },
  { method: "POST", path: `/${VALID_ID}/refresh`, permission: "dashboards:write", body: {} },
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
  orgId?: string | null;
}): void {
  const orgId = user.orgId === undefined ? "org-dash" : user.orgId;
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: user.id,
        mode: "managed" as const,
        label: `${user.id}@test.com`,
        role: user.role,
        ...(orgId ? { activeOrganizationId: orgId } : {}),
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
   * by the time the route is mounted. Measured at the time — that version found zero
   * tags across all 26 routes, which is to say it would have passed by finding
   * nothing, on any tree, forever. (The tagging code was deleted rather than
   * shipped unused, so the measurement is not reproducible from this tree.)
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

  it("publishes the enforced flag in every route's OpenAPI description", () => {
    // The descriptions are the PUBLISHED contract — `apps/docs/openapi.json` and
    // the generated reference pages — so a wrong one tells an integrator the
    // opposite of what the gate does. Round 1 rewrote the 18 that said
    // "Requires admin role." and verified 0 mismatches; that was a one-time
    // measurement, and it missed 8 routes that had never carried an
    // authorization sentence at all, including `POST /{id}/draft/publish`.
    //
    // This asserts it instead, against the doc the app actually emits, keyed on
    // the same ROUTES table that drives the enforcement tests above.
    const doc = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    }) as {
      paths?: Record<string, Record<string, { description?: string }>>;
    };

    const wrong: string[] = [];
    for (const r of ROUTES) {
      const path = `${MOUNT}${r.path === "/" ? "" : r.path}`
        .replace(VALID_ID, "{id}")
        .replace("/cards/c-1", "/cards/{cardId}")
        .replace("/sessions/s-1", "/sessions/{sessionId}");
      const op = doc.paths?.[path]?.[r.method.toLowerCase()];
      const desc = op?.description ?? "";
      const found = [...desc.matchAll(/Requires the `(dashboards:\w+)` permission/g)].map(
        (m) => m[1],
      );
      if (found.length !== 1 || found[0] !== r.permission) {
        wrong.push(`${r.method} ${path}: doc says ${JSON.stringify(found)}, gate is ${r.permission}`);
      }
    }
    expect(wrong).toEqual([]);
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
    it(`${r.method} ${r.path} → checkPermission("${r.permission}") and nothing else`, async () => {
      await app.fetch(req(r.path, r.method, r.body));
      const seen = mockCheckPermission.mock.calls.map((c) => c[1]);
      // The exact set, not `toContain`. A route carrying BOTH gates — the
      // precise failure the two-routers-at-one-mount-path shape produces, which
      // is why the gate is per route — satisfies `toContain` for either flag and
      // passes the 403 loop below as well. Only this assertion sees it.
      expect([...new Set(seen)]).toEqual([r.permission]);
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
  // The two routes whose handlers are mocked, so the allowed outcome is an
  // exact known status rather than "not 403". `not.toBe(403)` is satisfied by a
  // 404 from a renamed path, a 400 from a schema change and a 500 from an
  // unmocked seam — and these two tests are the ONLY check on cross-gate
  // leakage, so a weak assertion here is the whole property going unmeasured.
  const READ_ROUTE = { method: "GET", path: "/", status: 200 } as const;
  const WRITE_ROUTE = { method: "POST", path: "/", body: { title: "T" }, status: 201 } as const;

  it("denying read does not block a write route", async () => {
    mockCheckPermission.mockImplementation((_u, permission, requestId) =>
      Effect.succeed(
        permission === "dashboards:read" ? denialFor(permission, requestId) : null,
      ),
    );
    const res = await app.fetch(req(WRITE_ROUTE.path, WRITE_ROUTE.method, WRITE_ROUTE.body));
    expect(res.status).toBe(WRITE_ROUTE.status);
  });

  it("denying write does not block a read route", async () => {
    mockCheckPermission.mockImplementation((_u, permission, requestId) =>
      Effect.succeed(
        permission === "dashboards:write" ? denialFor(permission, requestId) : null,
      ),
    );
    const res = await app.fetch(req(READ_ROUTE.path, READ_ROUTE.method));
    expect(res.status).toBe(READ_ROUTE.status);
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
  // Named for what it PROVES: no coarse role gate stands in front any more.
  // It does not prove the member's resolved set carries the flag —
  // `checkPermission` is mocked to allow, so the role string is decorative here.
  // That half is `lib/auth/__tests__/dashboards-legacy-permissions.test.ts`,
  // which exists because a mutation showed this suite could not see it.
  it("does not refuse a member on ROLE before consulting permissions", async () => {
    authAs({ id: "u-member", role: "member" });
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
    // The gate ran — a 200 that skipped authorization entirely would be a
    // different (worse) bug wearing the same status code.
    expect(mockCheckPermission).toHaveBeenCalled();
    expect(mockCheckPermission.mock.calls.map((c) => c[1])).toContain("dashboards:read");
  });
});

describe("#5189 — org context is established BEFORE the permission gate", () => {
  it("400s a caller with no active organization, without consulting permissions", async () => {
    // Ordering is load-bearing and unenforced: `requireOrgContext()` is mounted
    // on the router, the gates per route. If the gate ran first, an org-less
    // caller would be authorized against a workspace nobody selected.
    authAs({ id: "u-noorg", role: "owner", orgId: null });

    const res = await app.fetch(req("/"));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    expect(mockCheckPermission).not.toHaveBeenCalled();
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
