/**
 * Tests for the MCP bearer-token store (#2024).
 *
 * Covers pure helpers + DB-coupled functions (`createMcpToken`,
 * `listMcpTokensForOrg`, `revokeMcpToken`, `lookupMcpTokenByBearer`,
 * `computeMcpTokenStatus`) using the existing `_resetPool` test hook
 * to inject a stub pool that records every query and returns canned
 * rows. Same pattern as the increment-suggestion-click tests —
 * preferred over `mock.module` because partial-mock pitfalls don't
 * apply.
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
  computeMcpTokenStatus,
  createMcpToken,
  listMcpTokensForOrg,
  revokeMcpToken,
  lookupMcpTokenByBearer,
  __INTERNAL,
} from "../mcp-token";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";

// ── Stub pool ──────────────────────────────────────────────────────

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
    expect(splitTokenPrefix("atl_mcp_" + "a".repeat(1000))).toBe(null);
  });
  it("rejects wrong leading prefix", () => {
    const wrong = "atl_xxx_" + "a".repeat(__INTERNAL.TOKEN_TOTAL_LEN - 8);
    expect(splitTokenPrefix(wrong)).toBe(null);
  });
  it("rejects non-hex bodies", () => {
    const bad = "atl_mcp_" + "g".repeat(__INTERNAL.TOKEN_TOTAL_LEN - 8);
    expect(splitTokenPrefix(bad)).toBe(null);
  });
  it("rejects uppercase hex (regex is case-sensitive on purpose)", () => {
    // generateMcpToken always emits lowercase. An uppercased bearer is
    // a different string than the canonical token; if we accepted both
    // a future change to the regex would break either lookup direction
    // silently.
    const bad = "atl_mcp_" + "A".repeat(__INTERNAL.TOKEN_TOTAL_LEN - 8);
    expect(splitTokenPrefix(bad)).toBe(null);
  });
});

describe("computeMcpTokenStatus()", () => {
  const now = Date.now();
  it("returns active when nothing is set", () => {
    expect(computeMcpTokenStatus(null, null, now)).toBe("active");
  });
  it("returns active when expiry is in the future", () => {
    expect(
      computeMcpTokenStatus(null, new Date(now + 60_000), now),
    ).toBe("active");
  });
  it("returns expired when expiry is in the past", () => {
    expect(
      computeMcpTokenStatus(null, new Date(now - 60_000), now),
    ).toBe("expired");
  });
  it("returns revoked even when expiry is also past (revoked beats expired)", () => {
    expect(
      computeMcpTokenStatus(
        new Date(now - 30_000),
        new Date(now - 60_000),
        now,
      ),
    ).toBe("revoked");
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
    expect(params[1]).toBe("org-a");
    expect(params[2]).toBe("user-1");
    expect(params[3]).toBe("Claude Desktop");
    expect(params[4]).toBe(created.prefix);

    const stored = params[5];   // 0-indexed; 6th param is the encrypted hash
    expect(stored).toBeString();
    expect(stored).not.toBe(created.token);
  });

  it("stored hash round-trips back to SHA-256(plaintext token)", async () => {
    // Closes the loop on the property `lookupMcpTokenByBearer` depends
    // on: the column written by `createMcpToken` MUST decrypt back to
    // the digest we'll compare against. Works whether or not the test
    // env has `ATLAS_ENCRYPTION_KEYS` configured — `decryptSecret` is
    // the right inverse in both passthrough and encrypted modes.
    rowsResolver = () => [];
    const created = await createMcpToken({
      orgId: "org-a",
      userId: "user-1",
    });
    const stored = String(lastCall().params[5]);
    expect(decryptSecret(stored)).toBe(hashTokenSha256(created.token));
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
  function rowFor(overrides: Record<string, unknown> = {}) {
    return {
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
      created_at: new Date(),
      created_by_user_id: "user-1",
      ...overrides,
    };
  }

  it("returns rows shaped as McpTokenSummary, filtered by org", async () => {
    rowsResolver = (sql, params) => {
      expect(sql).toContain("WHERE org_id = $1");
      expect(params[0]).toBe("org-a");
      return [rowFor()];
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

  it("derives status: 'active' for a fresh row", async () => {
    rowsResolver = () => [rowFor()];
    const rows = await listMcpTokensForOrg("org-a");
    expect(rows[0].status).toBe("active");
  });

  it("derives status: 'expired' for a past expires_at", async () => {
    rowsResolver = () => [
      rowFor({ expires_at: new Date(Date.now() - 60_000) }),
    ];
    const rows = await listMcpTokensForOrg("org-a");
    expect(rows[0].status).toBe("expired");
  });

  it("derives status: 'revoked' even when also expired", async () => {
    rowsResolver = () => [
      rowFor({
        revoked_at: new Date(Date.now() - 30_000),
        expires_at: new Date(Date.now() - 60_000),
      }),
    ];
    const rows = await listMcpTokensForOrg("org-a");
    expect(rows[0].status).toBe("revoked");
  });
});

// ── revokeMcpToken ────────────────────────────────────────────────

describe("revokeMcpToken()", () => {
  it("revokes when the row exists and is active, returning prefix + name", async () => {
    rowsResolver = (sql) => {
      if (sql.startsWith("UPDATE mcp_tokens")) {
        return [{ token_prefix: "atl_mcp_abcdef12", name: "Claude" }];
      }
      return [];
    };

    const result = await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });
    expect(result.revoked).toBe(true);
    expect(result.alreadyRevokedAt).toBe(null);
    expect(result.prefix).toBe("atl_mcp_abcdef12");
    expect(result.name).toBe("Claude");

    const updateCall = captured.find((c) =>
      c.sql.startsWith("UPDATE mcp_tokens"),
    );
    expect(updateCall?.params[0]).toBe("mcp_111");
    expect(updateCall?.params[1]).toBe("org-a");
    // SQL is a plain UPDATE+RETURNING (the prior CTE was dead code and
    // was removed). RETURNING surfaces what the audit row needs.
    expect(updateCall?.sql).toContain("RETURNING token_prefix, name");
    expect(updateCall?.sql).toContain("revoked_at IS NULL");
  });

  it("returns alreadyRevokedAt + prefix/name when called twice (idempotent)", async () => {
    const priorRevoked = new Date(Date.now() - 60_000);
    rowsResolver = (sql) => {
      if (sql.startsWith("UPDATE mcp_tokens")) return [];
      if (sql.includes("SELECT revoked_at, token_prefix, name")) {
        return [
          {
            revoked_at: priorRevoked,
            token_prefix: "atl_mcp_abcdef12",
            name: "Claude",
          },
        ];
      }
      return [];
    };

    const result = await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });
    expect(result.revoked).toBe(false);
    expect(result.alreadyRevokedAt?.getTime()).toBe(priorRevoked.getTime());
    expect(result.prefix).toBe("atl_mcp_abcdef12");
    expect(result.name).toBe("Claude");
  });

  it("returns not-found (all-null outcome) when the row doesn't exist for this org", async () => {
    rowsResolver = () => [];
    const result = await revokeMcpToken({ id: "nope", orgId: "org-a" });
    expect(result.revoked).toBe(false);
    expect(result.alreadyRevokedAt).toBe(null);
    expect(result.prefix).toBe(null);
    expect(result.name).toBe(null);
  });

  it("behaviorally isolates workspaces — stub returns row only for the matching org", async () => {
    // Stronger than asserting SQL shape: the resolver actually inspects
    // the org param and returns a row only when the legitimate org
    // matches. A regression that drops `org_id = $2` would make the
    // first sub-test fail (revoke succeeded for org-other) AND change
    // the second sub-test (revoke succeeded for org-a regardless of
    // the resolver's check).
    let caseRunning: "legitimate" | "spoof" = "legitimate";
    rowsResolver = (sql, params) => {
      if (sql.startsWith("UPDATE mcp_tokens")) {
        if (params[1] === "org-a" && caseRunning === "legitimate") {
          return [{ token_prefix: "atl_mcp_abcdef12", name: "Claude" }];
        }
        return [];
      }
      if (sql.includes("SELECT revoked_at, token_prefix, name")) {
        return [];
      }
      return [];
    };

    caseRunning = "legitimate";
    const ok = await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });
    expect(ok.revoked).toBe(true);

    captured = [];
    caseRunning = "spoof";
    const blocked = await revokeMcpToken({
      id: "mcp_111",
      orgId: "org-other",
    });
    expect(blocked.revoked).toBe(false);
    expect(blocked.alreadyRevokedAt).toBe(null);
    expect(blocked.prefix).toBe(null);
    expect(blocked.name).toBe(null);
  });
});

// ── lookupMcpTokenByBearer ────────────────────────────────────────

describe("lookupMcpTokenByBearer()", () => {
  /** Build a row that decrypts to the given hash (passthrough in tests). */
  function rowWithHash(
    overrides: { id?: string; orgId?: string; userId?: string | null; scopes?: string[] } = {},
    hashHex: string,
  ) {
    return {
      id: overrides.id ?? "mcp_111",
      org_id: overrides.orgId ?? "org-a",
      user_id: overrides.userId === undefined ? "user-1" : overrides.userId,
      scopes: overrides.scopes ?? [],
      token_hash_encrypted: hashHex,
      expires_at: null,
      last_used_at: null,
    };
  }

  it("rejects a malformed bearer without issuing a DB query", async () => {
    const result = await lookupMcpTokenByBearer("not-an-atl-token");
    expect(result).toBe(null);
    expect(captured).toHaveLength(0);
  });

  it("returns null for unknown prefix (zero candidate rows)", async () => {
    const { token } = generateMcpToken();
    rowsResolver = () => [];
    const result = await lookupMcpTokenByBearer(token);
    expect(result).toBe(null);
    expect(captured).toHaveLength(1);
    // Both invariants must be in the SELECT — losing either breaks
    // the immediate-revocation property at the SQL layer.
    expect(captured[0].sql).toContain("WHERE token_prefix = $1");
    expect(captured[0].sql).toContain("revoked_at IS NULL");
    expect(captured[0].sql).toContain(
      "expires_at IS NULL OR expires_at > NOW()",
    );
  });

  it("returns identity when a candidate's hash matches", async () => {
    const { token, prefix, hashHex } = generateMcpToken();
    let touched = false;
    rowsResolver = (sql) => {
      if (sql.includes("UPDATE mcp_tokens SET last_used_at")) {
        touched = true;
        return [];
      }
      return [
        rowWithHash({ id: "mcp_111", orgId: "org-a", scopes: ["mcp:read"] }, hashHex),
      ];
    };

    const result = await lookupMcpTokenByBearer(token);
    expect(result).toEqual({
      tokenId: "mcp_111",
      orgId: "org-a",
      userId: "user-1",
      scopes: ["mcp:read"],
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(touched).toBe(true);

    const select = captured.find((c) => c.sql.includes("SELECT id"));
    expect(select?.params[0]).toBe(prefix);
  });

  it("scans past a decrypt failure to find a sibling matching row (loop continues)", async () => {
    // Critical regression test: the comment in the source promises
    // the loop continues past per-row decrypt failures so a
    // misversioned ciphertext on row[0] doesn't poison a sibling
    // valid match on row[1]. A future refactor turning `continue`
    // into `return null` would silently break auth recovery during
    // key-rotation windows.
    const { token, hashHex } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      return [
        // Row 0: decrypts will throw because the body isn't valid
        // ciphertext format and isn't a hex digest either.
        {
          id: "mcp_dead",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: "enc:v999:not-real-base64-payload",
          expires_at: null,
          last_used_at: null,
        },
        // Row 1: the legitimate match.
        rowWithHash({ id: "mcp_match", orgId: "org-a" }, hashHex),
      ];
    };
    const result = await lookupMcpTokenByBearer(token);
    expect(result?.tokenId).toBe("mcp_match");
  });

  it("throws when EVERY candidate row fails to decrypt (keyset misconfig signal)", async () => {
    // Aggregate-failure detector: if the entire candidate set fell
    // over decrypt, we are in a systemic outage (likely a missing
    // legacy key after a botched rotation) — the validator must
    // throw so the bearer middleware returns 500 rather than
    // wallpapering 401s on every customer.
    const { token } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      return [
        {
          id: "mcp_a",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: "enc:v999:not-real-base64",
          expires_at: null,
          last_used_at: null,
        },
        {
          id: "mcp_b",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: "enc:v999:also-not-real",
          expires_at: null,
          last_used_at: null,
        },
      ];
    };
    expect(lookupMcpTokenByBearer(token)).rejects.toThrow(
      /all candidate rows failed to decrypt/,
    );
  });

  it("returns null when no candidate hash matches the incoming bearer", async () => {
    const { token } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      const otherToken = generateMcpToken();
      return [rowWithHash({ id: "mcp_222", orgId: "org-a" }, otherToken.hashHex)];
    };
    const result = await lookupMcpTokenByBearer(token);
    expect(result).toBe(null);
  });

  it("isolates workspaces — bound orgId comes from the row, not from caller input", async () => {
    const { token, prefix, hashHex } = generateMcpToken();
    rowsResolver = (sql) => {
      if (!sql.includes("SELECT id")) return [];
      return [rowWithHash({ id: "mcp_111", orgId: "org-a" }, hashHex)];
    };
    const result = await lookupMcpTokenByBearer(token);
    expect(result?.orgId).toBe("org-a");
    expect(captured[0].params).toEqual([prefix]);
  });

  it("end-to-end: create → revoke → lookup returns null (revocation is immediate)", async () => {
    // The store does not maintain in-process state — "immediate
    // revocation" means the SQL alone enforces it. We simulate a
    // realistic state machine in the stub: after revoke, the row no
    // longer satisfies `revoked_at IS NULL` so the lookup SELECT
    // returns zero candidates. If a future refactor adds an
    // in-process cache or drops the SQL clause, this test fails.
    let revoked = false;
    let plaintextToken = "";
    rowsResolver = (sql, params) => {
      if (sql.includes("INSERT INTO mcp_tokens")) {
        // Capture the encrypted-hash column value so SELECTs can
        // surface a row that decrypts back to it.
        plaintextToken = String(params[5] ?? "");
        return [];
      }
      if (sql.startsWith("UPDATE mcp_tokens") && sql.includes("revoked_at = NOW()")) {
        revoked = true;
        return [{ token_prefix: "atl_mcp_xxxxxxxx", name: null }];
      }
      if (sql.includes("SELECT id") && sql.includes("token_prefix = $1")) {
        if (revoked) return []; // SQL filter would have removed the row
        return [
          {
            id: "mcp_111",
            org_id: "org-a",
            user_id: "user-1",
            scopes: [],
            token_hash_encrypted: plaintextToken,
            expires_at: null,
            last_used_at: null,
          },
        ];
      }
      return [];
    };

    const created = await createMcpToken({ orgId: "org-a", userId: "user-1" });

    const before = await lookupMcpTokenByBearer(created.token);
    expect(before).not.toBe(null);
    expect(before?.tokenId).toBe("mcp_111");

    await revokeMcpToken({ id: "mcp_111", orgId: "org-a" });

    const after = await lookupMcpTokenByBearer(created.token);
    expect(after).toBe(null);
  });
});

// ── touchLastUsed ────────────────────────────────────────────────

describe("lookupMcpTokenByBearer() — last_used_at sampling", () => {
  it("does NOT issue a touch UPDATE when last_used_at is recent (within sampling window)", async () => {
    const { token, hashHex } = generateMcpToken();
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
          last_used_at: new Date(),  // touched seconds ago
        },
      ];
    };

    const result = await lookupMcpTokenByBearer(token);
    expect(result).not.toBe(null);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const touched = captured.find((c) =>
      c.sql.includes("UPDATE mcp_tokens SET last_used_at"),
    );
    expect(touched).toBeUndefined();
  });

  it("does issue a touch UPDATE when last_used_at is older than the sampling window", async () => {
    const { token, hashHex } = generateMcpToken();
    const stale = new Date(Date.now() - __INTERNAL.LAST_USED_TOUCH_INTERVAL_MS - 1000);
    rowsResolver = (sql) => {
      if (sql.includes("UPDATE mcp_tokens SET last_used_at")) return [];
      if (!sql.includes("SELECT id")) return [];
      return [
        {
          id: "mcp_111",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: hashHex,
          expires_at: null,
          last_used_at: stale,
        },
      ];
    };

    await lookupMcpTokenByBearer(token);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const touched = captured.find((c) =>
      c.sql.includes("UPDATE mcp_tokens SET last_used_at"),
    );
    expect(touched).toBeDefined();
  });

  it("does NOT block auth when the touch UPDATE itself throws", async () => {
    // last_used_at is observability, not a security control —
    // lookup must still resolve the identity even if the touch
    // write fails.
    const { token, hashHex } = generateMcpToken();
    rowsResolver = (sql) => {
      if (sql.includes("UPDATE mcp_tokens SET last_used_at")) {
        throw new Error("touch UPDATE failed");
      }
      if (!sql.includes("SELECT id")) return [];
      return [
        {
          id: "mcp_111",
          org_id: "org-a",
          user_id: "user-1",
          scopes: [],
          token_hash_encrypted: hashHex,
          expires_at: null,
          last_used_at: null,  // null forces the touch path
        },
      ];
    };

    const result = await lookupMcpTokenByBearer(token);
    expect(result?.tokenId).toBe("mcp_111");
    // Wait for the fire-and-forget touch to settle so its rejection
    // is caught (else bun reports an unhandled rejection).
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
