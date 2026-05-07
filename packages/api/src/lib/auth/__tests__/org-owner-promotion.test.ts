/**
 * Regression coverage for the org-owner → user.role="admin" promotion.
 *
 * Why this file exists: the previous wiring lived under
 * `databaseHooks.member.create.after` and silently never fired in
 * production — Better Auth's organization plugin inserts the initial
 * owner-member through its own internal context, bypassing user-defined
 * `databaseHooks`. Every org owner shipped with `user.role="member"` and
 * the bug went unnoticed until a real user complained, because zero
 * tests exercised the hook.
 *
 * Two layers of coverage here:
 *
 *   1. Unit-test the {@link promoteOrgOwnerToAdmin} function in isolation
 *      with a mock pool injected via `_resetPool`. Catches body-level
 *      regressions (forgot the platform_admin guard, swallows wrong
 *      errors, etc.).
 *
 *   2. Assert the organization plugin is actually present in
 *      {@link buildPlugins}'s output. Catches "someone deleted the
 *      whole plugin" — a coarse but cheap structural guard.
 *
 * What this test cannot catch: a refactor that drops only the
 * `organizationHooks.afterCreateOrganization: promoteOrgOwnerToAdmin`
 * line while keeping the plugin and the function. Better Auth closes
 * over its plugin options so the wiring isn't introspectable from
 * outside the plugin — closing that residual gap requires either a
 * full integration test against a live `betterAuth()` instance with
 * mocked DB (substantial setup) or an out-of-band production invariant
 * check. Filed separately.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { promoteOrgOwnerToAdmin, buildPlugins } from "../server";

const USER = { id: "user_test_123" };
const ORG = { id: "org_test_456" };

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

interface MockPool {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockPool(opts: {
  selectRole?: string | null;
  selectThrows?: boolean;
  updateThrows?: boolean;
}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const isSelect = /^\s*SELECT\b/i.test(sql);
      if (isSelect) {
        if (opts.selectThrows) throw new Error("connection refused");
        return {
          rows: opts.selectRole === undefined
            ? [{ role: "member" }]
            : opts.selectRole === null
              ? []
              : [{ role: opts.selectRole }],
          rowCount: 1,
        };
      }
      // UPDATE path
      if (opts.updateThrows) throw new Error("UPDATE failed");
      return { rows: [], rowCount: 1 };
    },
  } as unknown as InternalPool;
  return { pool, queries };
}

describe("promoteOrgOwnerToAdmin — body", () => {
  beforeEach(() => {
    // hasInternalDB() reads DATABASE_URL. Default to "available" — tests
    // that need the unavailable path override below.
    process.env.DATABASE_URL = "postgresql://test/test";
  });

  afterAll(() => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  it("promotes a member-role user to admin", async () => {
    const { pool, queries } = makeMockPool({ selectRole: "member" });
    _resetPool(pool);

    await promoteOrgOwnerToAdmin({ user: USER, organization: ORG });

    // Expect SELECT then UPDATE
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toMatch(/SELECT role FROM "user"/);
    expect(queries[1].sql).toMatch(/UPDATE "user" SET role = 'admin'/);
    expect(queries[1].params).toEqual([USER.id]);
  });

  it("skips when internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;
    const { pool, queries } = makeMockPool({ selectRole: "member" });
    _resetPool(pool);

    await promoteOrgOwnerToAdmin({ user: USER, organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("does not downgrade a platform_admin to admin", async () => {
    const { pool, queries } = makeMockPool({ selectRole: "platform_admin" });
    _resetPool(pool);

    await promoteOrgOwnerToAdmin({ user: USER, organization: ORG });

    // SELECT runs, but UPDATE must not
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SELECT/);
  });

  it("is idempotent — skip when user is already admin", async () => {
    const { pool, queries } = makeMockPool({ selectRole: "admin" });
    _resetPool(pool);

    await promoteOrgOwnerToAdmin({ user: USER, organization: ORG });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SELECT/);
  });

  it("does not throw when the SELECT fails — failure is logged, signup continues", async () => {
    const { pool } = makeMockPool({ selectThrows: true });
    _resetPool(pool);

    // Throwing here would block org creation — strictly worse than
    // landing in a recoverable state where user.role stays "member".
    await expect(
      promoteOrgOwnerToAdmin({ user: USER, organization: ORG }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the UPDATE fails", async () => {
    const { pool } = makeMockPool({ selectRole: "member", updateThrows: true });
    _resetPool(pool);

    await expect(
      promoteOrgOwnerToAdmin({ user: USER, organization: ORG }),
    ).resolves.toBeUndefined();
  });
});

describe("promoteOrgOwnerToAdmin — wiring", () => {
  it("the organization plugin is present in buildPlugins() output", () => {
    // Coarse but cheap: catches "someone deleted the org plugin entirely",
    // which would silently break every signup. Does NOT catch
    // "someone deleted the organizationHooks.afterCreateOrganization line"
    // — Better Auth closes over its options, so the hook isn't visible
    // on the returned plugin descriptor. See file-level comment.
    const plugins = buildPlugins();
    const ids = plugins.map((p: { id?: string }) => p.id);
    expect(ids).toContain("organization");
  });
});
