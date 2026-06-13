/**
 * #3509 — MCP action policy store (gate 1 of the dispatch order, ADR-0016).
 *
 * Exercises the row→policy mapping, the default-allowed posture, the
 * dashboard merge, and the upsert SQL via an injected query seam (no real DB,
 * no `mock.module`).
 */

import { describe, expect, it } from "bun:test";
import {
  loadMcpActionPolicy,
  getMcpActionPolicyEntries,
  setMcpActionCategoryStatus,
  isMcpActionCategory,
  MCP_ACTION_CATEGORIES,
  MCP_ACTION_CATEGORY_META,
  type ActionPolicyQuery,
} from "../action-policy";

const hasDb = () => true;

/** A query stub that returns fixed rows and records the last call. */
function queryReturning(rows: Record<string, unknown>[]): {
  query: ActionPolicyQuery;
  calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query: ActionPolicyQuery = async (sql, params) => {
    calls.push({ sql, params });
    return rows as never;
  };
  return { query, calls };
}

describe("loadMcpActionPolicy", () => {
  it("marks a category blocked when a blocked row exists", async () => {
    const { query } = queryReturning([{ category: "datasource", status: "blocked" }]);
    const policy = await loadMcpActionPolicy("org_1", { hasInternalDb: hasDb, query });
    expect(policy.isBlocked("datasource")).toBe(true);
    expect(policy.isBlocked("integration")).toBe(false);
  });

  it("defaults to allowed for every category when no rows exist", async () => {
    const { query } = queryReturning([]);
    const policy = await loadMcpActionPolicy("org_1", { hasInternalDb: hasDb, query });
    for (const c of MCP_ACTION_CATEGORIES) {
      expect(policy.isBlocked(c)).toBe(false);
    }
  });

  it("returns an all-allowed policy (no query) when there is no internal DB", async () => {
    let called = false;
    const query: ActionPolicyQuery = async () => {
      called = true;
      return [] as never;
    };
    const policy = await loadMcpActionPolicy("org_1", {
      hasInternalDb: () => false,
      query,
    });
    expect(policy.isBlocked("datasource")).toBe(false);
    expect(called).toBe(false);
  });

  it("propagates a DB error so the dispatch gate can fail closed", async () => {
    const query: ActionPolicyQuery = async () => {
      throw new Error("table read failed");
    };
    await expect(
      loadMcpActionPolicy("org_1", { hasInternalDb: hasDb, query }),
    ).rejects.toThrow("table read failed");
  });
});

describe("getMcpActionPolicyEntries", () => {
  it("returns every canonical category, defaulting unstored ones to allowed", async () => {
    const { query } = queryReturning([
      { category: "datasource", status: "blocked", updated_at: "2026-06-13T00:00:00Z", updated_by: "u1" },
    ]);
    const entries = await getMcpActionPolicyEntries("org_1", { hasInternalDb: hasDb, query });
    expect(entries.map((e) => e.category).sort()).toEqual([...MCP_ACTION_CATEGORIES].sort());

    const ds = entries.find((e) => e.category === "datasource");
    expect(ds?.status).toBe("blocked");
    expect(ds?.updatedBy).toBe("u1");
    expect(ds?.label).toBe(
      MCP_ACTION_CATEGORY_META.find((m) => m.category === "datasource")?.label,
    );

    const integ = entries.find((e) => e.category === "integration");
    expect(integ?.status).toBe("allowed");
    expect(integ?.updatedAt).toBeNull();
  });
});

describe("setMcpActionCategoryStatus", () => {
  it("upserts on (org_id, category) with the new status + actor", async () => {
    const { query, calls } = queryReturning([]);
    await setMcpActionCategoryStatus("org_1", "datasource", "blocked", "admin_1", {
      hasInternalDb: hasDb,
      query,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO mcp_action_policy");
    expect(calls[0].sql).toContain("ON CONFLICT (org_id, category)");
    expect(calls[0].params).toEqual(["org_1", "datasource", "blocked", "admin_1"]);
  });

  it("throws when there is no internal DB rather than silently no-op'ing", async () => {
    const { query } = queryReturning([]);
    await expect(
      setMcpActionCategoryStatus("org_1", "datasource", "blocked", null, {
        hasInternalDb: () => false,
        query,
      }),
    ).rejects.toThrow("Internal database required");
  });
});

describe("isMcpActionCategory", () => {
  it("accepts canonical categories and rejects others", () => {
    expect(isMcpActionCategory("datasource")).toBe(true);
    expect(isMcpActionCategory("nope")).toBe(false);
  });
});
