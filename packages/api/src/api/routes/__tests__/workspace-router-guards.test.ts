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
 *   2. **`migrationWriteLock`.** `adminAuth` omits it deliberately — admins
 *      need to manage a workspace DURING its migration. That rationale is
 *      about admin work and does not transfer: a `member` editing a dashboard
 *      mid-region-migration has the edit land in the source region and
 *      silently lost, reported as a 200.
 *
 * Both are asserted against the composed app rather than the factory, because
 * the factory is not what serves the request — a `use()` that never runs
 * because of ordering would still be present in the source.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
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
void mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: mockIsWorkspaceMigrating,
}));

// Allow every permission — this file is about the guards in FRONT of the
// permission gate, and a 403 would mask both properties under test.
void mock.module("@atlas/api/lib/effect/enterprise-layer", () => {
  const { makeTestEnterpriseLayer } =
    // oxlint-disable-next-line @typescript-eslint/no-require-imports -- `mock.module()` factory must be synchronous (feedback_bun_test_async_mock_module)
    require("@atlas/api/__test-utils__/makeTestEnterpriseLayer") as typeof import("@atlas/api/__test-utils__/makeTestEnterpriseLayer");
  return makeTestEnterpriseLayer({
    RolesPolicy: { checkPermission: (() => Effect.succeed(null)) as never },
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
    // The lock is scoped to write METHODS. A read-only dashboard view during a
    // migration is exactly what a user should still get, and locking it would
    // be a worse outage than the one being prevented.
    mockIsWorkspaceMigrating.mockImplementation(async () => true);
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
  });

  it("does not lock writes when no migration is active", async () => {
    // The negative control. Without it, a lock that returned 409
    // unconditionally would pass the two tests above.
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(201);
  });

  it("fails CLOSED with 503 when migration status cannot be read", async () => {
    // "We could not check" must never be reported as "not migrating" — that is
    // the branch that loses a write.
    mockIsWorkspaceMigrating.mockImplementation(async () => {
      throw new Error("region registry unreachable");
    });
    const res = await app.fetch(req("/", "POST", { title: "T" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("migration_check_failed");
  });
});
