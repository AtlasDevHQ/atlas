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

/**
 * Hoisted so the org-branch test can assert what the handler PASSED, not just
 * that it returned 200. Without it the suite cannot tell "took the org branch"
 * from "took the org branch and minted a public token anyway" — which is the
 * #4317 silent-downgrade class the route's own description says it prevents.
 */
type ShareOpts = { expiresIn: string | null; shareMode: string; rotate: boolean };
const mockShareDashboard = mock(
  // Typed with the real parameter list, or `.mock.calls[n][2]` is a
  // zero-length tuple and the assertion below cannot be written at all.
  async (_id: string, _ctx: { orgId: string; viewerId: string }, _opts: ShareOpts) => ({
    ok: true as const,
    data: { token: "tok", shareMode: "public", expiresAt: null },
  }),
);

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
  // #5192 — mocked so the ALLOWED outcome on each share branch is an exact
  // status. The branch tests below would otherwise rest on `not.toBe(403)`,
  // which a 404 from a renamed path or a 500 from the unmocked DB satisfies
  // just as well as the success they mean to assert.
  shareDashboard: mockShareDashboard,
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

/**
 * ⚠️ A real UUID, and it has to be. The name was already `VALID_ID` when the
 * value was a ULID — which every dashboards handler rejects with a 400 via
 * `UUID_RE`, so no handler BODY in this suite was ever reached. That was
 * invisible while every assertion here was about middleware, and it stopped
 * being invisible with #5192: the `dashboards:share` check lives in the handler
 * (it depends on the parsed `shareMode`), so with a ULID the second flag was
 * never consulted and the branch tests below measured the 400 instead.
 */
const VALID_ID = "00000000-0000-4000-8000-000000000000";
// ⚠️ Round 2: fixing `VALID_ID` alone fixed the INSTANCE, not the class. The
// card and session ids were still `c-1` / `s-1`, and their handlers 400 at the
// same `UUID_RE` — so on those FIVE routes the exact-set assertion below could
// not see an undeclared second gate either. Measured: injecting a stray
// `enforcePermission` into the update-card handler left the suite 69/69 green.
const VALID_CARD_ID = "00000000-0000-4000-8000-000000000001";
const VALID_SESSION_ID = "00000000-0000-4000-8000-000000000002";

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
/**
 * #5192 — a route may declare ONE conditional second flag, consulted on a
 * named branch only.
 *
 * The exact-set assertion below (`toEqual([r.permission])`) is what stops a
 * double-gated route hiding, and it is deliberately NOT weakened to
 * `toContain` for the one route that legitimately consults two. Instead the
 * table expresses the second flag, so the assertion still names an exact,
 * ordered set — and a route that grew a second gate nobody declared still
 * reddens.
 *
 * `body` drives the branch, so it is stated here rather than derived: for
 * `POST /{id}/share` the conditional branch is taken by an ABSENT or empty
 * body, because `shareMode` defaults to `"public"`. `bodyWithout` is a body
 * that must take the OTHER branch, which is the half that proves the condition
 * is a condition and not just a second unconditional gate.
 */
type DashboardPermission = "dashboards:read" | "dashboards:write" | "dashboards:share";

const ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  permission: DashboardPermission;
  body?: unknown;
  alsoEnforces?: {
    permission: DashboardPermission;
    /** Prose for the test name — what makes the second flag apply. */
    when: string;
    /** A body that must NOT reach the second flag. */
    bodyWithout: unknown;
  };
}> = [
  { method: "GET", path: "/", permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/draft`, permission: "dashboards:write" },
  { method: "GET", path: `/${VALID_ID}/draft/status`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/share`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/sessions/${VALID_SESSION_ID}`, permission: "dashboards:read" },
  { method: "GET", path: `/${VALID_ID}/screenshot`, permission: "dashboards:read" },
  { method: "POST", path: `/${VALID_ID}/cards/${VALID_CARD_ID}/render`, permission: "dashboards:read", body: {} },
  { method: "POST", path: `/${VALID_ID}/cards/${VALID_CARD_ID}/refresh`, permission: "dashboards:write", body: {} },
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
  { method: "PATCH", path: `/${VALID_ID}/cards/${VALID_CARD_ID}`, permission: "dashboards:write", body: {} },
  { method: "DELETE", path: `/${VALID_ID}/cards/${VALID_CARD_ID}`, permission: "dashboards:write" },
  {
    method: "POST",
    path: `/${VALID_ID}/share`,
    permission: "dashboards:write",
    // ⚠️ An EMPTY body on purpose — `{}` is what a bare `POST` with no
    // configuration looks like once parsed, and `shareMode` defaults to
    // `"public"`. Driving `{ shareMode: "public" }` here would test the gate
    // against the caller who asked for it explicitly and miss the exact
    // regression, which is that asking for nothing gets you a public link.
    body: {},
    alsoEnforces: {
      permission: "dashboards:share",
      when: "the share is PUBLIC (which an absent/empty body defaults to)",
      bodyWithout: { shareMode: "org" },
    },
  },
  // Revoking stays on `dashboards:write` alone (#5192): unsharing REDUCES
  // exposure, and de-escalation must never be harder than escalation.
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
  mockShareDashboard.mockClear();
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
          .replace(`/cards/${VALID_CARD_ID}`, "/cards/:cardId")
          .replace(`/sessions/${VALID_SESSION_ID}`, "/sessions/:sessionId"),
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
        .replace(`/cards/${VALID_CARD_ID}`, "/cards/{cardId}")
        .replace(`/sessions/${VALID_SESSION_ID}`, "/sessions/{sessionId}");
      const op = doc.paths?.[path]?.[r.method.toLowerCase()];
      const desc = op?.description ?? "";
      const found = [...desc.matchAll(/Requires the `(dashboards:\w+)` permission/g)].map(
        (m) => m[1],
      );
      // #5192 — a conditional second flag must be PUBLISHED too, and in the
      // same sentence form. An integrator reading the reference page has no
      // other way to learn that a bare POST needs a flag their `analyst` token
      // does not carry; a description naming only `dashboards:write` would tell
      // them the opposite of what the route does.
      const expected = [r.permission, ...(r.alsoEnforces ? [r.alsoEnforces.permission] : [])];
      if (found.length !== expected.length || found.some((f, i) => f !== expected[i])) {
        wrong.push(
          `${r.method} ${path}: doc says ${JSON.stringify(found)}, gate is ${JSON.stringify(expected)}`,
        );
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
    const declared = [r.permission, ...(r.alsoEnforces ? [r.alsoEnforces.permission] : [])];
    it(`${r.method} ${r.path} → checkPermission(${declared.map((p) => `"${p}"`).join(", ")}) and nothing else`, async () => {
      await app.fetch(req(r.path, r.method, r.body));
      const seen = mockCheckPermission.mock.calls.map((c) => c[1]);
      // The exact ORDERED set, not `toContain`. A route carrying BOTH gates —
      // the precise failure the two-routers-at-one-mount-path shape produces,
      // which is why the gate is per route — satisfies `toContain` for either
      // flag and passes the 403 loop below as well. Only this assertion sees it.
      //
      // #5192 kept it exact rather than relaxing it for the one route that
      // legitimately consults two flags: the second is DECLARED in the table,
      // so an undeclared second gate still reddens here. Order is meaningful
      // and asserted — the route gate runs as middleware, the conditional flag
      // inside the handler, so the middleware flag always comes first. A
      // reversal would mean the handler had started authorizing before the
      // route gate, which is a real defect wearing the right set of flags.
      expect([...new Set(seen)]).toEqual(declared);
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

  // ── #5192 — the conditional flag, both branches ────────────────────
  for (const r of ROUTES) {
    const cond = r.alsoEnforces;
    if (!cond) continue;

    it(`${r.method} ${r.path} → 403 when ${cond.permission} is denied and ${cond.when}`, async () => {
      // The regression test, stated as the issue states it: a caller holding
      // `dashboards:write` and NOT `dashboards:share` is denied.
      mockCheckPermission.mockImplementation((_u, permission, requestId) =>
        Effect.succeed(
          permission === cond.permission ? denialFor(permission, requestId) : null,
        ),
      );
      const res = await app.fetch(req(r.path, r.method, r.body));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("insufficient_permissions");
      // Name the flag that actually denied. Both gates answer 403 with the
      // same code, so without this the test passes when the WRITE gate denies
      // — i.e. when the conditional branch was never reached at all.
      expect(body.message).toContain(cond.permission);
    });

    it(`${r.method} ${r.path} → does NOT consult ${cond.permission} on the other branch`, async () => {
      // The half that proves the condition is a condition. Without it, an
      // unconditional second gate passes every assertion above — and it would
      // be a real regression in the other direction, taking org-scoped sharing
      // away from the analyst the flag was never meant to affect.
      await app.fetch(req(r.path, r.method, cond.bodyWithout));
      const seen = mockCheckPermission.mock.calls.map((c) => c[1]);
      expect([...new Set(seen)]).toEqual([r.permission]);
    });

    it(`${r.method} ${r.path} → 503, not 403, when ${cond.permission} cannot be RESOLVED`, async () => {
      // The in-handler gate re-derives the status from `enforcePermission`,
      // which is the only place in the tree that does. Measured in review:
      // collapsing that ternary to a bare `c.json(denied.body, 403)` left this
      // whole suite green, so "we could not determine your permissions" was
      // reportable as "you lack them" — the exact confusion
      // `permissionLoadFailedResponse` exists to prevent, and the reason the
      // route declares a 503 at all.
      mockCheckPermission.mockImplementation((_u, permission, requestId) =>
        Effect.succeed(
          permission === cond.permission
            ? {
                body: { error: "permissions_unavailable", message: "unavailable", requestId },
                status: 503 as const,
              }
            : null,
        ),
      );
      const res = await app.fetch(req(r.path, r.method, r.body));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("permissions_unavailable");
    });

    it(`${r.method} ${r.path} → denying ${cond.permission} leaves the other branch working`, async () => {
      mockCheckPermission.mockImplementation((_u, permission, requestId) =>
        Effect.succeed(
          permission === cond.permission ? denialFor(permission, requestId) : null,
        ),
      );
      const res = await app.fetch(req(r.path, r.method, cond.bodyWithout));
      // An exact status, not `not.toBe(403)`: `shareDashboard` is mocked, so
      // the allowed outcome is a known 200 and a 404/500 cannot pass for it.
      expect(res.status).toBe(200);
      // …and it minted the mode the caller asked for. A 200 alone cannot tell
      // "took the org branch" from "took the org branch and minted a PUBLIC
      // token anyway", which is the silent-downgrade class #4317 closed and
      // the one this gate must not reopen from the other side.
      expect(mockShareDashboard.mock.calls.at(-1)?.[2]).toMatchObject({
        shareMode: "org",
      });
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
    //
    // ⚠️ Counted, not `continue`d past. On a green tree no route 403s, so the
    // loop's body used to run ZERO times and the test reported coverage it was
    // not providing — an assertion that cannot fail. Collecting every response
    // and asserting over the whole set keeps the property while making the
    // vacuous case visible.
    const codes: Array<string | undefined> = [];
    for (const r of ROUTES) {
      const res = await app.fetch(req(r.path, r.method, r.body));
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      codes.push(body.error);
    }
    expect(codes).toHaveLength(ROUTES.length);
    expect(codes.filter((c) => c === "mfa_enrollment_required")).toEqual([]);
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
