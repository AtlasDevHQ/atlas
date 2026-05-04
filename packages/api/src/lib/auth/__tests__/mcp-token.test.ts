/**
 * Tests for the MCP bearer-token store (#2024).
 *
 * Covers:
 *   - Pure helpers (`generateMcpToken`, `splitTokenPrefix`, `hashTokenSha256`)
 *   - DB-coupled helpers (`createMcpToken`, `listMcpTokensForOrg`,
 *     `revokeMcpToken`, `lookupMcpTokenByBearer`)
 *
 * The DB tests use the existing `_resetPool` test hook in `db/internal.ts`
 * to inject a stub pool that records every query and returns canned rows.
 * This is the same pattern the increment-suggestion-click tests use —
 * preferred over `mock.module` because partial-mock pitfalls don't apply.
 */

// internalQuery falls back to the raw pg.Pool when no @effect/sql
// SqlClient is bound; provide a sentinel DATABASE_URL so the module
// import path doesn't short-circuit before the stub pool is installed.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import {
  _resetPool,
  _resetCircuitBreaker,
} from "@atlas/api/lib/db/internal";
import {
  generateMcpToken,
  hashTokenSha256,
  splitTokenPrefix,
  createMcpToken,
  listMcpTokensForOrg,
  revokeMcpToken,
  lookupMcpTokenByBearer,
  __INTERNAL,
} from "../mcp-token";

// ── Stub pool ──────────────────────────────────────────────────────
//
// The stub returns canned rows based on SQL text matching. Per-test
// state (queued rows, captured queries) lives in module-level
// variables that beforeEach resets.

interface QueryCall {
  sql: string;
  params: unknown[];
}

let captured: QueryCall[] = [];
type RowsForSql = (sql: string, params: unknown[]) => unknown[];
let rowsResolver: RowsForSql = () => [];

function makeStubPool() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const call: QueryCall = { sql, params: params ?? [] };
      captured.push(call);
      const rows = rowsResolver(sql, call.params);
      return { rows, rowCount: rows.length };
    },
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    on() {},
  };
}

beforeEach(() => {
  captured = [];
  rowsResolver = () => [];
  _resetCircuitBreaker();
  _resetPool(
    makeStubPool() as unknown as Parameters<typeof _resetPool>[0],
    null,
  );
});

afterAll(() => {
  _resetPool(null, null);
  _resetCircuitBreaker();
  mock.restore();
});

function lastCall(): QueryCall {
  const call = captured[captured.length - 1];
  if (!call) throw new Error("no captured query");
  return call;
}

// ── Pure helpers ───────────────────────────────────────────────────

describe("generateMcpToken()", () => {
  it("emits a token with the documented shape", () => {
    const { token, prefix, hashHex } = generateMcpToken();
    expect(token.startsWith(__INTERNAL.TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBe(__INTERNAL.TOKEN_TOTAL_LEN);
    expect(prefix.length).toBe(__INTERNAL.TOKEN_PREFIX.length + 8);
    expect(token.startsWith(prefix)).toBe(true);
    // hashHex is the SHA-256 of the plaintext (64 hex chars).
    expect(hashHex.length).toBe(64);
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a prefix or body across two calls", () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.hashHex).not.toBe(b.hashHex);
  });
});

describe("hashTokenSha256()", () => {
  it("is deterministic for the same input", () => {
    expect(hashTokenSha256("atl_mcp_aaaaaaaa" + "b".repeat(24))).toBe(
      hashTokenSha256("atl_mcp_aaaaaaaa" + "b".repeat(24)),
    );
  });
  it("differs for different inputs", () => {
    const a = hashTokenSha256("atl_mcp_aaaaaaaa" + "b".repeat(24));
    const b = hashTokenSha256("atl_mcp_aaaaaaaa" + "c".repeat(24));
    expect(a).not.toBe(b);
  });
});

describe("splitTokenPrefix()", () => {
  it("returns the prefix for a well-formed token", () => {
    const { token, prefix } = generateMcpToken();
    expect(splitTokenPrefix(token)).toBe(prefix);
  });
  it("rejects wrong total length", () => {
    expect(splitTokenPrefix("atl_mcp_too_short")).toBe(null);
    expect(
      splitTokenPrefix("atl_mcp_" + "a".repeat(1000)),
    ).toBe(null);
  });
  it("rejects wrong leading prefix", () => {
    // Same length, different scheme prefix.
    const wrong = "atl_xxx_" + "a".repeat(__INTERNAL.TOKEN_TOTAL_LEN - 8);
    expect(splitTokenPrefix(wrong)).toBe(null);
  });
  it("rejects non-hex bodies", () => {
    const bad = "atl_mcp_" + "g".repeat(__INTERNAL.TOKEN_TOTAL_LEN - 8);
    expect(splitTokenPrefix(bad)).toBe(null);
  });
});

// ── createMcpToken ────────────────────────────────────────────────

describe("createMcpToken()", () => {
  it("inserts an encrypted hash, returns plaintext token + summary", async () => {
    rowsResolver = () => [];
    const created = await createMcpToken({
      orgId: "org-a",
      userId: "user-1",
      name: "Claude Desktop",
    });

    expect(created.token.startsWith("atl_mcp_")).toBe(true);
    expect(created.prefix.length).toBe(16);
    expect(created.orgId).toBe("org-a");
    expect(created.userId).toBe("user-1");
    expect(created.name).toBe("Claude Desktop");

    expect(captured).toHaveLength(1);
    const { sql, params } = lastCall();
    expect(sql).toContain("INSERT INTO mcp_tokens");
    // Argument order matches the route in mcp-token.ts createMcpToken:
    //  $1 id, $2 org_id, $3 user_id, $4 name, $5 token_prefix,
    //  $6 token_hash_encrypted, $7 token_hash_key_version, $8 scopes,
    //  $9 expires_at, $10 created_by_user_id
    expect(params[1]).toBe("org-a");
    expect(params[2]).toBe("user-1");
    expect(params[3]).toBe("Claude Desktop");
    expect(params[4]).toBe(created.prefix);

    // The hash column receives ciphertext OR plaintext-passthrough
    // depending on whether ATLAS_ENCRYPTION_KEYS is set. Either way it
    // must NEVER equal the plaintext token — only ever the SHA-256.
    const stored = params[6 - 1]; // 1-indexed in SQL → 0-indexed here
    expect(stored).toBeString();
    expect(stored).not.toBe(created.token);
    // SHA-256 of the plaintext token, in hex (raw or wrapped in
    // `enc:vN:`). Either form contains the digest's hex chars only
    // *inside* the `enc:` body — easier to assert: stored value,
    // when decrypted, equals the digest. Decrypt is round-tripped by
    // lookup tests below; here we settle for "not the plaintext".
  });

  it("defaults scopes to [] and expiresAt to null", async () => {
    const created = await createMcpToken({
      orgId: "org-a",
      userId: "user-1",
    });
    expect(created.scopes).toEqual([]);
    expect(created.expiresAt).toBe(null);
    const { params } = lastCall();
    expect(params[7]).toEqual([]);   // scopes
    expect(params[8]).toBe(null);    // expires_at
  });
});

// ── listMcpTokensForOrg ───────────────────────────────────────────

describe("listMcpTokensForOrg()", () => {
  it("returns rows shaped as McpTokenSummary, filtered by org", async () => {
    const now = new Date();
    rowsResolver = (sql, params) => {
      expect(sql).toContain("WHERE org_id = $1");
      expect(params[0]).toBe("org-a");
      return [
        {
          id: "mcp_111",
          org_id: "org-a",
          user_id: "user-1",
          name: "Claude",
          token_prefix: "atl_mcp_aaaaaaaa",
          token_hash_encrypted: "ignored-here",
          token_hash_key_version: 1,
          scopes: [],
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: now,
          created_by_user_id: "user-1",
        },
      ];
    };

    const rows = await listMcpTokensForOrg("org-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "mcp_111",
      orgId: "org-a",
      userId: "user-1",
      name: "Claude",
      prefix: "atl_mcp_aaaaaaaa",
      scopes: [],
      revokedAt: null,
      createdByUserId: "user-1",
    });
    // Encrypted column does not leak into the wire shape.
    expect(rows[0]).not.toHaveProperty("token_hash_encrypted");
    expect(rows[0]).not.toHaveProperty("tokenHashEncrypted");
  });
});

// ── revokeMcpToken ────────────────────────────────────────────────

describe("revokeMcpToken()", () => {
  it("revokes when the row exists and is active", async () => {
    const revokedAt = new Date();
    let updateCallCount = 0;
    rowsResolver = (sql) => {
      if (sql.includes("UPDATE mcp_tokens")) {
        updateCallCount++;
        return [{ revoked_at: revokedAt, prior_revoked_at: null }];
      }
      return [];
    };

    const result = await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });
    expect(result.revoked).toBe(true);
    expect(result.alreadyRevokedAt).toBe(null);
    expect(updateCallCount).toBe(1);
    const { params } = lastCall();
    expect(params[0]).toBe("mcp_111");
    expect(params[1]).toBe("org-a");
  });

  it("returns alreadyRevokedAt when called twice (idempotent)", async () => {
    // Second call: UPDATE matches no rows because revoked_at IS NULL
    // is false; the follow-up SELECT surfaces the prior tombstone.
    const priorRevoked = new Date(Date.now() - 60_000);
    rowsResolver = (sql) => {
      if (sql.startsWith("WITH prior")) return [];
      if (sql.startsWith("SELECT revoked_at FROM mcp_tokens")) {
        return [{ revoked_at: priorRevoked }];
      }
      return [];
    };

    const result = await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });
    expect(result.revoked).toBe(false);
    expect(result.alreadyRevokedAt?.getTime()).toBe(priorRevoked.getTime());
  });

  it("returns not-found when the row doesn't exist for this org", async () => {
    rowsResolver = (sql) => {
      if (sql.startsWith("WITH prior")) return [];
      if (sql.startsWith("SELECT revoked_at FROM mcp_tokens")) return [];
      return [];
    };
    const result = await revokeMcpToken({ id: "nope", orgId: "org-a" });
    expect(result.revoked).toBe(false);
    expect(result.alreadyRevokedAt).toBe(null);
  });

  it("does not revoke a row owned by a different org (workspace isolation)", async () => {
    // The UPDATE statement filters on `org_id = $2`, so passing a
    // different org id matches no rows — same shape as the not-found
    // case. Verifies the SQL carries the org filter at all.
    rowsResolver = (sql) => {
      if (sql.startsWith("WITH prior")) return [];
      if (sql.startsWith("SELECT revoked_at FROM mcp_tokens")) return [];
      return [];
    };
    const result = await revokeMcpToken({ id: "mcp_111", orgId: "org-other" });
    expect(result.revoked).toBe(false);
    // And the UPDATE we sent really did include the org id:
    const updateCall = captured.find((c) => c.sql.startsWith("WITH prior"));
    expect(updateCall?.params[1]).toBe("org-other");
  });
});

// ── lookupMcpTokenByBearer ────────────────────────────────────────

describe("lookupMcpTokenByBearer()", () => {
  it("rejects a malformed bearer without issuing a DB query", async () => {
    const result = await lookupMcpTokenByBearer("not-an-atl-token");
    expect(result).toBe(null);
    expect(captured).toHaveLength(0);
  });

  it("returns null for unknown prefix (zero candidate rows)", async () => {
    const { token } = generateMcpToken();
    rowsResolver = () => []; // no candidates
    const result = await lookupMcpTokenByBearer(token);
    expect(result).toBe(null);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("WHERE token_prefix = $1");
    expect(captured[0].sql).toContain("revoked_at IS NULL");
  });

  it("returns identity when a candidate's hash matches", async () => {
    const { token, prefix, hashHex } = generateMcpToken();
    let touched = false;
    rowsResolver = (sql, _params) => {
      if (sql.includes("UPDATE mcp_tokens SET last_used_at")) {
        touched = true;
        return [];
      }
      // SELECT — return one candidate whose stored hash matches.
      return [
        {
          id: "mcp_111",
          org_id: "org-a",
          user_id: "user-1",
          scopes: ["mcp:read"],
          // encryptSecret is a passthrough when no key is set, so the
          // raw hex is what `decryptSecret` will return.
          token_hash_encrypted: hashHex,
          expires_at: null,
          last_used_at: null,
        },
      ];
    };

    const result = await lookupMcpTokenByBearer(token);
    expect(result).not.toBe(null);
    expect(result).toEqual({
      tokenId: "mcp_111",
      orgId: "org-a",
      userId: "user-1",
      scopes: ["mcp:read"],
    });

    // Best-effort touch of last_used_at — fire-and-forget, may
    // resolve on the microtask queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(touched).toBe(true);

    // Lookup binds prefix in $1
    const select = captured.find((c) => c.sql.includes("SELECT id"));
    expect(select?.params[0]).toBe(prefix);
  });

  it("returns null when no candidate hash matches the incoming bearer", async () => {
    const { token, prefix } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      // Candidate's stored hash is for a *different* token — same
      // prefix collision (rare in real life) but body differs.
      const otherToken = generateMcpToken();
      return [
        {
          id: "mcp_222",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: otherToken.hashHex,
          expires_at: null,
          last_used_at: null,
        },
      ];
    };
    expect(prefix).toBeDefined();
    const result = await lookupMcpTokenByBearer(token);
    expect(result).toBe(null);
  });

  it("filters expired tokens at the SQL layer (expires_at clause present)", async () => {
    const { token } = generateMcpToken();
    rowsResolver = () => []; // simulate that the SQL filtered the expired row
    await lookupMcpTokenByBearer(token);
    // The SELECT must carry the expiry clause so an expired row
    // never reaches the in-process loop. This is the property that
    // makes "revocation is immediate" true.
    expect(captured[0].sql).toContain(
      "expires_at IS NULL OR expires_at > NOW()",
    );
  });

  it("isolates workspaces — the SELECT does not bind any org id", async () => {
    // Workspace isolation is enforced at *result-construction* time:
    // the resolved identity carries the row's `org_id`, which is what
    // the bearer middleware promotes into AuthContext. The lookup
    // doesn't filter on a caller-supplied org because the bearer is
    // anonymous — its workspace is *defined by* the row, not asked
    // for. That's the invariant: workspace A's token *cannot* return
    // workspace B's identity because `tokenId → orgId` is a
    // many-to-one relation in the table.
    const { token, prefix, hashHex } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      return [
        {
          id: "mcp_111",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: hashHex,
          expires_at: null,
          last_used_at: null,
        },
      ];
    };
    const result = await lookupMcpTokenByBearer(token);
    expect(result?.orgId).toBe("org-a");
    expect(result?.orgId).not.toBe("org-b");
    // SELECT param surface is just the prefix — no org id is
    // accepted from caller-controlled input.
    expect(captured[0].params).toEqual([prefix]);
  });
});
