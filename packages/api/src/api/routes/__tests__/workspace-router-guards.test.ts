/**
 * #5191 — the two things `createWorkspaceRouter()` inherited the ABSENCE of.
 *
 * When dashboards moved off `createAdminRouter()` (#5190), they left behind two
 * `adminAuth` behaviours. Neither departure was decided; both were silent:
 *
 *   1. **The rate-limit bucket.** `adminAuth` passes `bucket: "admin"`;
 *      `standardAuth` used the default. So a 20-card dashboard's 20
 *      `POST …/render` on load moved onto the same budget as chat and every
 *      cheap read, and the user-visible failure is a 429 rendered in the
 *      dashboards error card #5188 had just rewritten.
 *   2. **`migrationWriteLock`.** A `member` editing a dashboard
 *      mid-region-migration has the edit land in the source region and
 *      silently lost, reported as a 200.
 *
 * ⚠️ **The lock had never been mounted on ANY router before this change.** An
 * earlier draft of this file said `adminAuth` "omits it deliberately" and that
 * dashboards "left it behind"; both are false, and `git grep migrationWriteLock`
 * on the parent commit returns only the definition. Recorded because the false
 * version invites less scrutiny — a restored invariant reads safer than a first
 * mount, and this is a first mount.
 *
 * Both are asserted against the composed app rather than the factory, because
 * the factory is not what serves the request — a `use()` that never runs
 * because of ordering would still be present in the source.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "u-member",
    mode: "managed",
    label: "member@test.com",
    role: "member",
    activeOrganizationId: "org-dash",
  },
});

// Drives the migration write-lock. `false` by default so the bucket assertions
// below are not silently answering a 409 instead of reaching the handler.
const mockIsWorkspaceMigrating = mock(async () => false);
const realReadonly = await import("@atlas/api/lib/residency/readonly");
void mock.module("@atlas/api/lib/residency/readonly", () => ({
  // Spread the real module: correct today (it has one export), but a partial
  // factory breaks at LOAD time the moment a second export lands, which is the
  // trap this repo has already been bitten by.
  ...realReadonly,
  isWorkspaceMigrating: mockIsWorkspaceMigrating,
}));

// Allows every permission by DEFAULT — this file is mostly about the guards in
// FRONT of the permission gate, and a 403 would mask those properties. Drivable
// so the gate-ORDER test below can deny one.
type CheckPermissionResult = { body: Record<string, unknown>; status: 403 | 503 } | null;
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

const realDashboards = await import("@atlas/api/lib/dashboards");
void mock.module("@atlas/api/lib/dashboards", () => ({
  ...realDashboards,
  listDashboards: mock(async () => ({ ok: true as const, data: { dashboards: [], total: 0 } })),
  createDashboard: mock(async () => ({
    ok: true as const,
    data: { id: "d-1", title: "T", updatedAt: "2026-08-13T00:00:00Z", cardCount: 0 },
  })),
}));

const { app } = await import("../../index");

const MOUNT = "/api/v1/dashboards";

// Real UUIDs — every dashboards handler 400s at `UUID_RE` on anything else, so
// a placeholder id would make the read-classified-POST test below assert
// against a 400 rather than against the lock.
const VALID_ID = "00000000-0000-4000-8000-000000000000";
const VALID_CARD_ID = "00000000-0000-4000-8000-000000000001";

function req(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Cookie: "atlas-session=x" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${MOUNT}${path === "/" ? "" : path}`, init);
}

beforeEach(() => {
  mocks.mockCheckRateLimit.mockReset();
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  mockIsWorkspaceMigrating.mockReset();
  mockIsWorkspaceMigrating.mockImplementation(async () => false);
  mockCheckPermission.mockReset();
  mockCheckPermission.mockImplementation(() => Effect.succeed(null as CheckPermissionResult));
});

// ── The rate-limit bucket ────────────────────────────────────────────

describe("#5191 — the workspace surface has its own rate-limit bucket", () => {
  it("charges a dashboards read to the `workspace` bucket", async () => {
    await app.fetch(req("/"));
    expect(mocks.mockCheckRateLimit).toHaveBeenCalled();
    const opts = mocks.mockCheckRateLimit.mock.calls[0][1] as { bucket?: string };
    // The exact bucket, not "not default". `admin` would also pass a
    // negative assertion and is the choice #5191 explicitly rejected: a
    // dashboard load must not be able to deplete the budget an operator
    // needs to fix the workspace.
    expect(opts.bucket).toBe("workspace");
  });

  it("charges a dashboards WRITE to the same bucket", async () => {
    // Reads and writes on this surface are one population — the burst that
    // motivated the bucket (render-on-load, then refresh-all) spans both.
    await app.fetch(req("/", "POST", { title: "T" }));
    const opts = mocks.mockCheckRateLimit.mock.calls[0][1] as { bucket?: string };
    expect(opts.bucket).toBe("workspace");
  });

  it("threads the caller's org so a per-workspace override applies", async () => {
    // `ATLAS_RATE_LIMIT_RPM_WORKSPACE` is workspace-scoped in the settings
    // registry, and a scoped setting with no org threaded resolves to the
    // platform value for every tenant.
    await app.fetch(req("/"));
    const opts = mocks.mockCheckRateLimit.mock.calls[0][1] as { orgId?: string };
    expect(opts.orgId).toBe("org-dash");
  });

  it("still answers 429 when that bucket is exhausted", async () => {
    mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 30000 }));
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSeconds: number; requestId: string };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(30);
    expect(body.requestId).toBeTruthy();
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

// ── The migration write-lock ─────────────────────────────────────────

describe("#5191 — writes are locked while the workspace is migrating", () => {
  it("409s a dashboard create during an active region migration", async () => {
    mockIsWorkspaceMigrating.mockImplementation(async () => true);
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("workspace_migrating");
    // The 409 must be actionable and correlatable — the whole reason a silent
    // 200 that loses the write is the failure being replaced.
    expect(body.message).toContain("migrated to a new region");
    expect(body.requestId).toBeTruthy();
  });

  it("leaves READS working during a migration", async () => {
    // A read-only dashboard view during a migration is exactly what a user
    // should still get; locking it would be a worse outage than the one being
    // prevented.
    mockIsWorkspaceMigrating.mockImplementation(async () => true);
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
  });

  it("leaves a read-classified POST working during a migration", async () => {
    // ⚠️ The regression review round 1 caught, and the reason the lock rides on
    // the WRITE GATE rather than on the router.
    //
    // `checkMigrationWriteLock` keys on the HTTP METHOD, and this surface has
    // read-classified POSTs: `…/cards/{id}/render` and `…/export`. Mounted
    // router-wide, a region migration 409'd every card of a dashboard anybody
    // merely OPENED — an outage strictly worse than the lost write the lock
    // exists to prevent, and the previous version of this file certified it as
    // correct because its only read fixture was a GET.
    mockIsWorkspaceMigrating.mockImplementation(async () => true);
    const res = await app.fetch(
      req(`/${VALID_ID}/cards/${VALID_CARD_ID}/render`, "POST", {}),
    );
    // The lock was never CONSULTED — the exact assertion, not `not.toBe(409)`.
    // The render handler is unmocked here, so its status is whatever the
    // absent DB produces; `not.toBe(409)` would be satisfied by that failure
    // just as well as by the property under test. Whether the gate ran is the
    // property, and it is directly observable.
    expect(mockIsWorkspaceMigrating).not.toHaveBeenCalled();
    expect(res.status).not.toBe(409);
  });

  it("does not even CONSULT migration status on a read", async () => {
    // The stronger form: a read must not reach the lock at all. Asserting only
    // the status would pass if the lock ran and happened to allow — which is
    // what a router-wide mount plus a `false` stub looks like.
    mockIsWorkspaceMigrating.mockImplementation(async () => true);
    await app.fetch(req("/"));
    expect(mockIsWorkspaceMigrating).not.toHaveBeenCalled();
  });

  it("does not lock writes when no migration is active", async () => {
    // The negative control. Without it, a lock that returned 409
    // unconditionally would pass the two tests above.
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(201);
  });

  it("allows the write when the region_migrations table does not exist", async () => {
    // #5191 round 2 — an unmigrated internal DB (the table arrives in 0012)
    // cannot have a migration in flight, so refusing every write there would be
    // a self-inflicted outage naming a subsystem the operator never configured.
    // The narrowing is deliberately MORE permissive than the arm below, which
    // is why it gets its own test rather than riding on the 503 one.
    mockIsWorkspaceMigrating.mockImplementation(async () => {
      throw new Error('relation "region_migrations" does not exist');
    });
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(201);
  });

  it("answers 403, not 409, when the caller lacks the flag AND a migration is active", async () => {
    // `workspaceWriteGate` returns [permission gate, migrationWriteLock] and its
    // docstring calls the order load-bearing. Nothing asserted it: the only
    // check was `toHaveLength(2)`, which is order-blind, and neither behavioural
    // suite could see it (this one always allows the permission; the permission
    // suite never has a migration in flight).
    //
    // Swapped, an UNAUTHORIZED caller would be told the workspace is migrating —
    // the wrong remedy, and a small leak of migration state to someone with no
    // permission on this workspace at all.
    mockCheckPermission.mockImplementation((_u, permission, requestId) =>
      Effect.succeed(
        permission === "dashboards:write"
          ? {
              body: {
                error: "insufficient_permissions",
                message: 'This action requires the "dashboards:write" permission.',
                requestId,
              },
              status: 403 as const,
            }
          : null,
      ),
    );
    mockIsWorkspaceMigrating.mockImplementation(async () => true);

    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_permissions");
    // The lock was never reached, which is the ordering property itself.
    expect(mockIsWorkspaceMigrating).not.toHaveBeenCalled();
  });

  for (const [label, message] of [
    ["a missing COLUMN (a partially-applied migration set)", 'column "workspace_id" does not exist'],
    ["a type-mismatch query bug", "operator does not exist: uuid = text"],
    ["a wrong search_path", 'schema "atlas" does not exist'],
    ["a mispointed DATABASE_URL", 'database "atlas_wrong" does not exist'],
    ["rotated internal-DB credentials", 'role "atlas" does not exist'],
  ] as const) {
    it(`still fails CLOSED on ${label}`, async () => {
      // ⚠️ THE NEGATIVE CONTROLS, and the reason the narrowing is keyed on the
      // RELATION rather than on a bare `does not exist`.
      //
      // Every message here contains that substring. Under the broad match all
      // five answered "no migration in flight" — during an ACTIVE migration
      // that allows the write, which lands in the source region and is silently
      // lost. That is precisely the failure the lock exists to prevent, so the
      // round-1 fix had inverted the failure mode for this whole class.
      //
      // Measured: with the broad predicate restored, the table-absent test
      // above still passes — both predicates accept it — so the positive case
      // alone certifies nothing. These are what can fail.
      mockIsWorkspaceMigrating.mockImplementation(async () => {
        throw new Error(message);
      });
      const res = await app.fetch(req("/", "POST", { title: "T" }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("migration_check_failed");
    });
  }

  it("fails CLOSED with 503 when migration status cannot be read", async () => {
    // "We could not check" must never be reported as "not migrating" — that is
    // the branch that loses a write.
    mockIsWorkspaceMigrating.mockImplementation(async () => {
      throw new Error("region registry unreachable");
    });
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("migration_check_failed");
    // A 5xx without a correlation handle is the one shape CLAUDE.md forbids
    // outright, and the 503 is the harder of the two to diagnose.
    expect(body.requestId).toBeTruthy();
  });
});
