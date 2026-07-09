/**
 * Route-level tests for `admin-connection-group-descriptions` (ADR-0022 §4,
 * slice (b) #3894).
 *
 * Focus on THIS router's own logic — the data-access seam is mocked and the
 * shared admin middleware is replaced with pass-throughs (the org comes from the
 * per-test `CURRENT_ORG`), so the assertions are about list/patch/clear wiring,
 * org scoping, and request validation, not the perimeter (covered in
 * `admin-router.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

let CURRENT_ORG = "org-owner";
let listRows: Array<{ groupId: string; description: string; source: "auto" | "manual"; updatedAt: string }> = [];
let setCalls: Array<{ orgId: string; groupId: string; description: string }> = [];
/** Whether the captured `setManualGroupDescription` reports a row now exists. */
let setReturns = true;

void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger };
});

void mock.module("@atlas/api/lib/db/connection-group-descriptions", () => ({
  listGroupDescriptions: async (_orgId: string) => listRows,
  setManualGroupDescription: async (orgId: string, groupId: string, description: string) => {
    setCalls.push({ orgId, groupId, description });
    return setReturns;
  },
  // Unused by the route but required by the "mock all exports" rule.
  getGroupDescriptionMap: async () => new Map(),
  upsertAutoGroupDescription: async () => {},
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  requireOrgContext: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { adminConnectionGroupDescriptions } = await import("../admin-connection-group-descriptions");

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
  CURRENT_ORG = "org-owner";
  listRows = [];
  setCalls = [];
  setReturns = true;
});
afterEach(() => {
  CURRENT_ORG = "org-owner";
});

describe("admin-connection-group-descriptions — list", () => {
  it("returns the org's descriptions with provenance", async () => {
    listRows = [
      { groupId: "orders", description: "Order data.", source: "manual", updatedAt: "2026-06-22T00:00:00Z" },
      { groupId: "analytics", description: "Events.", source: "auto", updatedAt: "2026-06-22T00:00:00Z" },
    ];
    const res = await adminConnectionGroupDescriptions.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { descriptions: Array<{ groupId: string; source: string }> };
    expect(body.descriptions).toHaveLength(2);
    expect(body.descriptions[0]).toMatchObject({ groupId: "orders", source: "manual" });
  });

  it("returns an empty list when the org has no descriptions", async () => {
    const res = await adminConnectionGroupDescriptions.request("/");
    const body = (await res.json()) as { descriptions: unknown[] };
    expect(body.descriptions).toEqual([]);
  });
});

describe("admin-connection-group-descriptions — patch (set / clear)", () => {
  it("sets a manual description, scoped to the authed org", async () => {
    const res = await adminConnectionGroupDescriptions.request("/orders", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "Production orders." }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { present: boolean; source: string | null; description: string | null };
    expect(body).toMatchObject({ present: true, source: "manual", description: "Production orders." });
    expect(setCalls).toEqual([{ orgId: "org-owner", groupId: "orders", description: "Production orders." }]);
  });

  it("clears the description on a blank body (present=false, reverts to fallback)", async () => {
    setReturns = false; // data layer reports the row was deleted
    const res = await adminConnectionGroupDescriptions.request("/orders", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "   " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { present: boolean; source: string | null; description: string | null };
    expect(body).toMatchObject({ present: false, source: null, description: null });
  });

  it("scopes the write to the calling workspace (no cross-tenant write)", async () => {
    CURRENT_ORG = "org-attacker";
    await adminConnectionGroupDescriptions.request("/orders", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "x" }),
    });
    expect(setCalls[0]?.orgId).toBe("org-attacker");
  });

  it("rejects a description over the max length with 400", async () => {
    const res = await adminConnectionGroupDescriptions.request("/orders", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });
});
