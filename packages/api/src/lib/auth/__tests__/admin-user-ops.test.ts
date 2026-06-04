/**
 * Direct internal-DB user-management ops that replace the Better Auth admin
 * plugin (#3159). The plugin authorized off the raw `user.role` column; these
 * reimplementations are server-side and platform_admin-gated at the route
 * layer, so the only thing under test here is that each op issues the exact
 * SQL the plugin used to issue (so ban / revoke / delete behavior is preserved
 * byte-for-byte) plus the pure ban-state predicate.
 *
 * `@atlas/api/lib/db/internal` is mocked down to the two symbols this module
 * imports (`internalQuery`, `hasInternalDB`). The factory is SYNC — an async
 * mock.module factory deadlocks bun's loader. A partial mock is safe because
 * the isolated runner gives this file its own process and nothing else here
 * imports internal's other exports.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { APIError } from "better-auth/api";

const queries: Array<{ sql: string; params?: unknown[] }> = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];
let internalDbAvailable = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mock((sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return queryImpl(sql, params);
  }),
  hasInternalDB: mock(() => internalDbAvailable),
}));

const {
  listPlatformUsers,
  banUserDirect,
  unbanUserDirect,
  removeUserDirect,
  revokeUserSessionsDirect,
  isEffectivelyBanned,
  enforceBanOnSessionCreate,
} = await import("@atlas/api/lib/auth/admin-user-ops");

beforeEach(() => {
  queries.length = 0;
  internalDbAvailable = true;
  queryImpl = async () => [];
});

function find(predicate: (sql: string) => boolean) {
  return queries.find((q) => predicate(q.sql));
}

// ---------------------------------------------------------------------------
// isEffectivelyBanned — pure predicate (no DB)
// ---------------------------------------------------------------------------

describe("isEffectivelyBanned", () => {
  const now = new Date("2026-06-04T12:00:00Z").getTime();

  it("false when banned is false/null/undefined", () => {
    expect(isEffectivelyBanned(false, null, now)).toBe(false);
    expect(isEffectivelyBanned(null, null, now)).toBe(false);
    expect(isEffectivelyBanned(undefined, null, now)).toBe(false);
  });

  it("true when banned with no expiry (permanent ban)", () => {
    expect(isEffectivelyBanned(true, null, now)).toBe(true);
    expect(isEffectivelyBanned(true, undefined, now)).toBe(true);
  });

  it("true when banned and expiry is in the future", () => {
    expect(isEffectivelyBanned(true, new Date(now + 60_000), now)).toBe(true);
    expect(isEffectivelyBanned(true, new Date(now + 60_000).toISOString(), now)).toBe(true);
  });

  it("false when banned but expiry has passed (effectively unbanned)", () => {
    expect(isEffectivelyBanned(true, new Date(now - 60_000), now)).toBe(false);
    expect(isEffectivelyBanned(true, new Date(now - 60_000).toISOString(), now)).toBe(false);
  });

  it("treats an unparseable banExpires as a permanent ban (fail closed)", () => {
    expect(isEffectivelyBanned(true, "not-a-date", now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// banUserDirect — UPDATE user + DELETE sessions (matches plugin banUser)
// ---------------------------------------------------------------------------

describe("banUserDirect", () => {
  it("sets banned/reason/expiry and deletes the target's sessions", async () => {
    const expiresAt = await banUserDirect({ userId: "u1", reason: "spam", expiresInSec: 3600 });

    const update = find((s) => s.includes("UPDATE") && s.includes('"user"'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("banned");
    expect(update!.sql).toContain('"banReason"');
    expect(update!.sql).toContain('"banExpires"');
    expect(update!.params?.[0]).toBe("u1");
    expect(update!.params?.[1]).toBe("spam");
    // expiry param is a Date roughly 1h out
    const exp = update!.params?.[2] as Date;
    expect(exp).toBeInstanceOf(Date);
    expect(exp.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(expiresAt).toBeInstanceOf(Date);

    const del = find((s) => s.includes("DELETE FROM session"));
    expect(del).toBeDefined();
    expect(del!.params?.[0]).toBe("u1");
  });

  it("permanent ban (no expiry) writes NULL banExpires and still deletes sessions", async () => {
    const expiresAt = await banUserDirect({ userId: "u2" });
    expect(expiresAt).toBeNull();
    const update = find((s) => s.includes("UPDATE") && s.includes('"user"'));
    expect(update!.params?.[2]).toBeNull();
    expect(find((s) => s.includes("DELETE FROM session"))?.params?.[0]).toBe("u2");
  });
});

describe("unbanUserDirect", () => {
  it("clears banned/reason/expiry, does not touch sessions", async () => {
    await unbanUserDirect("u3");
    const update = find((s) => s.includes("UPDATE") && s.includes('"user"'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("banned");
    expect(update!.params?.[0]).toBe("u3");
    expect(find((s) => s.includes("DELETE FROM session"))).toBeUndefined();
  });
});

describe("revokeUserSessionsDirect", () => {
  it("deletes all of the user's sessions and returns the revoked count", async () => {
    queryImpl = async (sql) =>
      sql.includes("DELETE FROM session") ? [{ id: "s1" }, { id: "s2" }] : [];
    const count = await revokeUserSessionsDirect("u4");
    expect(count).toBe(2);
    const del = find((s) => s.includes("DELETE FROM session"));
    expect(del!.params?.[0]).toBe("u4");
  });
});

describe("removeUserDirect", () => {
  it("deletes session, account, then user — in that order", async () => {
    await removeUserDirect("u5");
    const order = queries.map((q) => q.sql);
    const sessIdx = order.findIndex((s) => s.includes("DELETE FROM session"));
    const acctIdx = order.findIndex((s) => s.includes("DELETE FROM account"));
    const userIdx = order.findIndex((s) => s.includes('DELETE FROM "user"'));
    expect(sessIdx).toBeGreaterThanOrEqual(0);
    expect(acctIdx).toBeGreaterThan(sessIdx);
    expect(userIdx).toBeGreaterThan(acctIdx);
    for (const q of queries) expect(q.params?.[0]).toBe("u5");
  });
});

// ---------------------------------------------------------------------------
// listPlatformUsers — direct user query w/ pagination, search, role filter
// ---------------------------------------------------------------------------

describe("listPlatformUsers", () => {
  it("returns users + total with no filters", async () => {
    queryImpl = async (sql) => {
      if (sql.includes("COUNT(")) return [{ count: "7" }];
      return [
        { id: "a", email: "a@x.com", name: "A", role: "platform_admin", banned: false, banReason: null, banExpires: null, createdAt: "2026-01-01" },
      ];
    };
    const res = await listPlatformUsers({ limit: 50, offset: 0 });
    expect(res.total).toBe(7);
    expect(res.users).toHaveLength(1);
    expect(res.users[0]).toMatchObject({ id: "a", email: "a@x.com", role: "platform_admin", banned: false });
  });

  it("applies an email search (ILIKE) and a role filter with correctly-positioned params", async () => {
    queryImpl = async (sql) => (sql.includes("COUNT(") ? [{ count: "1" }] : []);
    // Distinct limit/offset so a LIMIT↔OFFSET swap or a placeholder off-by-one
    // (when both filters shift the index) can't hide behind equal values.
    await listPlatformUsers({ limit: 25, offset: 50, search: "bob", role: "platform_admin" });
    const list = find((s) => s.includes("FROM") && s.includes('"user"') && !s.includes("COUNT("));
    expect(list!.sql).toContain("ILIKE");
    expect(list!.sql.toLowerCase()).toContain("role");
    // Exact order: search ($1), role ($2), limit ($3), offset ($4).
    expect(list!.params).toEqual(["%bob%", "platform_admin", 25, 50]);
    // COUNT query gets only the filter params (no limit/offset).
    const count = find((s) => s.includes("COUNT("));
    expect(count!.params).toEqual(["%bob%", "platform_admin"]);
  });
});

// ---------------------------------------------------------------------------
// enforceBanOnSessionCreate — reproduces the admin plugin's
// databaseHooks.session.create.before (block + auto-unban on expiry)
// ---------------------------------------------------------------------------

describe("enforceBanOnSessionCreate", () => {
  it("allows when the user is not banned", async () => {
    queryImpl = async () => [{ banned: false, banExpires: null }];
    await enforceBanOnSessionCreate("u6"); // must not throw
    expect(find((s) => s.includes("UPDATE"))).toBeUndefined();
  });

  it("throws a BANNED_USER APIError for an active ban", async () => {
    queryImpl = async () => [{ banned: true, banExpires: null }];
    let thrown: unknown;
    try {
      await enforceBanOnSessionCreate("u7");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).body?.code).toBe("BANNED_USER");
    // no auto-unban for an active ban
    expect(find((s) => s.includes("UPDATE"))).toBeUndefined();
  });

  it("auto-unbans and allows when the ban has expired", async () => {
    queryImpl = async (sql) => {
      if (sql.includes("UPDATE")) return [];
      return [{ banned: true, banExpires: new Date(Date.now() - 60_000) }];
    };
    await enforceBanOnSessionCreate("u8"); // must not throw
    const update = find((s) => s.includes("UPDATE") && s.includes('"user"'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("banned");
    expect(update!.params?.[0]).toBe("u8");
  });

  it("allows (fails open) when no internal DB is configured", async () => {
    internalDbAvailable = false;
    await enforceBanOnSessionCreate("u9"); // must not throw, no query
    expect(queries).toHaveLength(0);
  });

  it("allows when the user row is not found", async () => {
    queryImpl = async () => [];
    await enforceBanOnSessionCreate("u10");
  });

  it("fails closed (throws BAN_CHECK_FAILED) when the ban lookup errors", async () => {
    queryImpl = async () => {
      throw new Error("pool timeout");
    };
    // A ban read we can't complete must refuse sign-in, not open the door —
    // the per-request check reads cookie-cache-stale state and can't be relied
    // on to catch a ban the create-time read missed.
    let thrown: unknown;
    try {
      await enforceBanOnSessionCreate("u11");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).body?.code).toBe("BAN_CHECK_FAILED");
  });
});
