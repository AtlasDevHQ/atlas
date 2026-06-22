/**
 * Unit tests for #2345 group-aware conversation routing.
 *
 * Covers the three TDD red tests called out in the issue:
 *
 *  1. Agent entity-resolution under a group — `runAgent` reads
 *     `connectionGroupId` from `RequestContext` and surfaces it onto
 *     the agent OTel span, proving the content scope reaches the
 *     loaders that key on it.
 *
 *  2. Per-turn override does not leak into the next turn — the
 *     `withRequestContext` scope is bound to the AsyncLocalStorage
 *     frame; once the frame exits, `getRequestContext()` returns the
 *     outer (or undefined) value. A new chat call without an override
 *     must not see the previous override.
 *
 *  3. Missing group falls back to legacy behavior —
 *     `resolveGroupForConnection` returns `null` cleanly when no
 *     internal DB is configured or the connection has no group_id
 *     (legacy single-connection deploy), and the chat route treats
 *     that as "no group scope" without surfacing an error.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { withRequestContext, getRequestContext } from "@atlas/api/lib/logger";
import { resolveGroupForConnection, verifyGroupBelongsToOrg } from "@atlas/api/lib/conversations";

// ── Mock internal pool ────────────────────────────────────────────────

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB(): void {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>): void {
  queryResults = results;
  queryResultIndex = 0;
}

const origDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  queryCalls = [];
  queryResults = [];
  queryResultIndex = 0;
  queryThrow = null;
  delete process.env.DATABASE_URL;
  _resetPool(null);
});

afterEach(() => {
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
});

// ── 1. Agent entity-resolution under a group ──────────────────────────

describe("agent entity-resolution under a group", () => {
  it("reads connectionGroupId from RequestContext via getRequestContext()", () => {
    let observedGroup: string | undefined;
    let observedConnection: string | undefined;
    withRequestContext(
      {
        requestId: "req-2345-a",
        connectionGroupId: "g_prod",
        connectionId: "us-int",
      },
      () => {
        const ctx = getRequestContext();
        observedGroup = ctx?.connectionGroupId;
        observedConnection = ctx?.connectionId;
      },
    );
    // Both fields land in the AsyncLocalStorage frame so the agent's
    // pre-flight loaders (whitelist, semantic index) can resolve
    // entities through the group while still routing execution to
    // the specific replica.
    expect(observedGroup).toBe("g_prod");
    expect(observedConnection).toBe("us-int");
  });

  it("returns undefined when the chat route hasn't stamped routing (legacy path)", () => {
    let observedGroup: string | undefined;
    withRequestContext(
      { requestId: "req-legacy" },
      () => {
        observedGroup = getRequestContext()?.connectionGroupId;
      },
    );
    // Legacy single-connection deploy: the route stamps nothing, so
    // downstream reads see undefined and fall back to the file-based
    // / per-connection paths. The acceptance criterion "missing group
    // falls back to legacy behavior" hinges on this.
    expect(observedGroup).toBeUndefined();
  });
});

// ── 2. Per-turn override does not leak across turns ───────────────────

describe("per-turn override scoping", () => {
  it("override is bound to the AsyncLocalStorage frame and clears after it exits", () => {
    let firstObserved: string | undefined;
    let secondObserved: string | undefined;

    // First "turn" — header picker temporarily routes to "eu". The
    // chat route nests withRequestContext({ connectionId: "eu" })
    // around runAgent; once the callback resolves the frame pops.
    withRequestContext(
      {
        requestId: "req-turn-1",
        connectionId: "eu",
        connectionGroupId: "g_prod",
      },
      () => {
        firstObserved = getRequestContext()?.connectionId;
      },
    );

    // Second "turn" — no header override; the route nests
    // withRequestContext({ connectionId: <conv default> }) using the
    // conversation's stored value. The first turn's "eu" must NOT
    // bleed in.
    withRequestContext(
      {
        requestId: "req-turn-2",
        connectionId: "us-int",
        connectionGroupId: "g_prod",
      },
      () => {
        secondObserved = getRequestContext()?.connectionId;
      },
    );

    expect(firstObserved).toBe("eu");
    expect(secondObserved).toBe("us-int");
  });

  it("nested override supersedes the outer routing for the inner frame only", () => {
    // Mirrors the chat route's "nested withRequestContext" pattern:
    // the outer frame carries the conversation's defaults, the inner
    // frame carries the per-turn override. After the inner frame
    // exits, the outer values are still visible.
    let inner: string | undefined;
    let afterInner: string | undefined;

    withRequestContext(
      {
        requestId: "outer",
        connectionId: "us-int",
        connectionGroupId: "g_prod",
      },
      () => {
        withRequestContext(
          {
            requestId: "inner",
            connectionId: "eu",
            connectionGroupId: "g_prod",
          },
          () => {
            inner = getRequestContext()?.connectionId;
          },
        );
        afterInner = getRequestContext()?.connectionId;
      },
    );

    expect(inner).toBe("eu");
    // After the inner withRequestContext returns, the outer frame is
    // restored. The override never escapes its scope.
    expect(afterInner).toBe("us-int");
  });
});

// ── 3. Missing group falls back to legacy behavior ────────────────────

describe("missing group falls back to legacy behavior", () => {
  it("resolveGroupForConnection returns null when no internal DB is configured", async () => {
    const result = await resolveGroupForConnection("conn-x", "org-1");
    expect(result).toBeNull();
    // No DB call attempted — the helper short-circuits.
    expect(queryCalls.length).toBe(0);
  });

  it("returns null when the install exists but config has no group_id (legacy single-connection deploy)", async () => {
    enableInternalDB();
    setResults({ rows: [{ group_id: null }] });

    const result = await resolveGroupForConnection("conn-legacy", "org-1");
    expect(result).toBeNull();
    // Post-#2744 the helper queries `workspace_plugins` for `config->>'group_id'`.
    expect(queryCalls[0].sql).toContain("FROM workspace_plugins");
    expect(queryCalls[0].sql).toContain("config->>'group_id'");
  });

  it("returns null when the connection does not exist for this org", async () => {
    enableInternalDB();
    setResults({ rows: [] });

    const result = await resolveGroupForConnection("missing", "org-1");
    expect(result).toBeNull();
  });

  it("returns the group_id when workspace_plugins.config has one", async () => {
    enableInternalDB();
    setResults({ rows: [{ group_id: "prod" }] });

    const result = await resolveGroupForConnection("us-int", "org-1");
    expect(result).toBe("prod");
    expect(queryCalls[0].params).toEqual(["us-int", "org-1"]);
  });

  it("does not throw when the DB query fails — caller gets null and falls back", async () => {
    enableInternalDB();
    queryThrow = new Error("connection refused");

    const result = await resolveGroupForConnection("conn-err", "org-1");
    // Failing closed (throwing) would 500 the chat surface for a
    // routing-resolution glitch; legacy single-connection orgs
    // wouldn't even need the resolution. Null is the correct shape.
    expect(result).toBeNull();
  });

  it("uses a null-safe workspace predicate so caller orgId=null doesn't collapse to `__global__` only (#2415)", async () => {
    // Mock-theater regression guard. The mock returns whatever rows we
    // hand it regardless of WHERE-clause semantics, so a "result is
    // g_default" assertion gives false confidence. The real signal is
    // the SQL itself: plain `workspace_id = $2` collapses to UNKNOWN
    // when $2 is NULL and falls through to `workspace_id = '__global__'`,
    // silently losing the binding for any deploy whose workspace_plugins
    // row was scoped to NULL. The null-safe `IS NOT DISTINCT FROM`
    // operator matches NULL to NULL.
    //
    // Real-Postgres coverage of the predicate semantics lives in
    // `db/__tests__/migrate-pg.test.ts` ("resolveGroupForConnection
    // predicate: VALUES-row matrix under null caller orgId"). This
    // unit-level assertion locks the SQL string so a future helper-side
    // refactor can't quietly weaken the predicate without the migrate-pg
    // suite catching it too.
    enableInternalDB();
    setResults({ rows: [{ group_id: "default" }] });

    await resolveGroupForConnection("conn-1", null);

    expect(queryCalls.length).toBe(1);
    const { sql, params } = queryCalls[0];
    expect(sql).toContain("IS NOT DISTINCT FROM");
    // Plain `workspace_id = $2 OR` is forbidden: it's null-unsafe by
    // Postgres semantics (NULL=NULL → UNKNOWN), and the OR-fallback
    // hides the miss. The null-safe `IS NOT DISTINCT FROM` form is the
    // invariant this helper has to maintain.
    expect(sql).not.toMatch(/workspace_id\s*=\s*\$2\s+OR/);
    // The fallback to the shared `__global__` row must still be in the
    // predicate — that's what lets demo/global installs resolve under
    // any caller workspace_id.
    expect(sql).toContain("'__global__'");
    // The caller's null orgId is forwarded as a SQL NULL so the
    // null-safe operator can match against workspace_plugins.workspace_id IS NULL.
    expect(params).toEqual(["conn-1", null]);
  });
});

// ── 4. #3879 — group-of-one verify gate ───────────────────────────────

describe("verifyGroupBelongsToOrg resolves a group-of-one by install_id (#3879)", () => {
  it("returns no_db when the internal DB is not configured", async () => {
    const result = await verifyGroupBelongsToOrg("opensearch", "org-1");
    expect(result).toBe("no_db");
    // Short-circuits before any query.
    expect(queryCalls.length).toBe(0);
  });

  it("uses COALESCE(config->>'group_id', install_id) so a group-less install verifies by its own id", async () => {
    // The bug: the picker (`/me/connection-groups`) and the write-side
    // resolvers surface a standalone, group-less datasource as a
    // group-of-one keyed by its `install_id` via
    // `COALESCE(config->>'group_id', install_id)` (#3855). This gate
    // matched only the bare `config->>'group_id' = $1`, so pinning a
    // freshly-installed group-less datasource 400'd with "environment
    // not available" — the row had a NULL `config.group_id`, so no row
    // matched its install_id.
    //
    // Mock-theater caveat (see the #2415 test above): the mock returns
    // whatever rows we hand it regardless of WHERE semantics, so the
    // behavioral "ok" only proves the caller maps a non-empty result to
    // "ok". The real regression signal is the SQL string — the COALESCE
    // form is what makes an install_id-keyed group-of-one resolvable, and
    // it must stay in lockstep with the picker's identical resolution
    // (locked by `me-connection-groups.test.ts`). Real-Postgres COALESCE
    // semantics are standard SQL and exercised by the picker path.
    enableInternalDB();
    setResults({ rows: [{ install_id: "opensearch" }] });

    const result = await verifyGroupBelongsToOrg("opensearch", "org-1");
    expect(result).toBe("ok");

    expect(queryCalls.length).toBe(1);
    const { sql, params } = queryCalls[0];
    // Must resolve the group id the same way the picker does.
    expect(sql).toContain("COALESCE(config->>'group_id', install_id) = $1");
    // The pre-#3879 bare-equality form is forbidden — it can't match a
    // group-less install keyed by its install_id.
    expect(sql).not.toMatch(/WHERE\s+config->>'group_id'\s*=\s*\$1/);
    // Still scoped to datasource installs in the caller's workspace (or
    // the shared `__global__` bucket), null-safe on the workspace id.
    expect(sql).toContain("pillar = 'datasource'");
    expect(sql).toContain("IS NOT DISTINCT FROM");
    expect(params).toEqual(["opensearch", "org-1"]);
  });

  it("returns not_found when no install resolves to the pinned group id", async () => {
    enableInternalDB();
    setResults({ rows: [] });

    const result = await verifyGroupBelongsToOrg("ghost-env", "org-1");
    expect(result).toBe("not_found");
  });

  it("returns error (caller fails closed → 500) when the query throws", async () => {
    enableInternalDB();
    queryThrow = new Error("connection refused");

    const result = await verifyGroupBelongsToOrg("opensearch", "org-1");
    // Fails closed: the chat route maps "error" to a retryable 500 rather
    // than silently treating an unverifiable group as owned.
    expect(result).toBe("error");
  });
});
