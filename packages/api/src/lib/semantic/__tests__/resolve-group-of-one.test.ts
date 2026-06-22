/**
 * Tests for the standalone-datasource group-of-one resolution (#3855).
 *
 * The onboarding wizard's `generate` → `save` flow scopes every saved entity
 * by `resolveGroupIdForConnection(orgId, connectionId)`. A standalone
 * datasource with no `config.group_id` resolved to `null`, so two saves of a
 * same-named table from two DIFFERENT connections (e.g. `mysql-staging` and
 * `clickhouse`) shared the conflict key
 * `(org_id, entity_type, name, coalesce(connection_group_id,'default'))` and
 * the second silently clobbered the first (last-write-wins).
 *
 * Fix: a group-less install resolves to its own `connectionId` (a
 * group-of-one) rather than `null`, so:
 *   - two same-named tables on different connections get distinct
 *     `connection_group_id` values → no collision, and
 *   - `executeSQL(connectionId=...)` finds the entity under its own id.
 *
 * This suite pins the TS-resolver contract (`internalQuery` stubbed); the
 * pg-mem integration in `overlay-queries-integration.test.ts` proves the
 * two-connection same-name case produces two correctly-scoped, visible rows
 * end to end (exercising the inline-SQL mirror + the visibility join).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resolve } from "path";
import * as realInternal from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Stage the workspace_plugins lookup per scenario. We spread the REAL module
// and override only the two functions `resolveGroupIdForConnection` touches —
// `mock.module` mocks all exports (the rest pass through unchanged).
// ---------------------------------------------------------------------------

let queuedRows: Record<string, unknown>[][] = [];
const capturedCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];

const mockInternalQuery = mock(async (sql: string, params?: unknown[]) => {
  capturedCalls.push({ sql, params });
  return queuedRows.shift() ?? [];
});

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
}));

const entitiesPath = resolve(__dirname, "../entities.ts");
const entitiesMod = await import(`${entitiesPath}?t=${Date.now()}`);
const resolveGroupIdForConnection =
  entitiesMod.resolveGroupIdForConnection as typeof import("../entities").resolveGroupIdForConnection;
const DEMO_CONNECTION_ID = entitiesMod.DEMO_CONNECTION_ID as string;

describe("resolveGroupIdForConnection — group-of-one for standalone datasources (#3855)", () => {
  beforeEach(() => {
    queuedRows = [];
    capturedCalls.length = 0;
  });

  it("returns the explicit group when the install carries one", async () => {
    queuedRows.push([{ group_id: "g_prod" }]);

    expect(await resolveGroupIdForConnection("org-1", "mysql-staging")).toBe("g_prod");
  });

  it("returns the connectionId itself when a group-less install exists (group-of-one)", async () => {
    // The install row exists (pillar='datasource') but config->>'group_id' is
    // NULL — the standalone, never-grouped datasource. Pre-#3855 this returned
    // null and collided with every other group-less connection in the org.
    queuedRows.push([{ group_id: null }]);

    expect(await resolveGroupIdForConnection("org-1", "clickhouse")).toBe("clickhouse");
  });

  it("scopes two group-less connections to two DISTINCT groups (no shared key)", async () => {
    queuedRows.push([{ group_id: null }]);
    const a = await resolveGroupIdForConnection("org-1", "mysql-staging");
    queuedRows.push([{ group_id: null }]);
    const b = await resolveGroupIdForConnection("org-1", "clickhouse");

    expect(a).toBe("mysql-staging");
    expect(b).toBe("clickhouse");
    expect(a).not.toBe(b);
  });

  it("returns null for an unknown connection (no install row)", async () => {
    // No row → the connection isn't a real datasource install (default/unknown)
    // → flat default group, preserving legacy NULL-scope behavior.
    queuedRows.push([]);

    expect(await resolveGroupIdForConnection("org-1", "does-not-exist")).toBeNull();
  });

  it("returns null for a null/undefined connectionId without a DB call", async () => {
    expect(await resolveGroupIdForConnection("org-1", null)).toBeNull();
    expect(await resolveGroupIdForConnection("org-1", undefined)).toBeNull();
    expect(capturedCalls.length).toBe(0);
  });

  it("treats the demo connection as its own group-of-one when group-less", async () => {
    // The per-workspace demo install is a real datasource install with no
    // `config.group_id` post-0096, so it resolves to its own id rather than
    // NULL — its entities key under `__demo__` and stay distinct from any
    // other group-less datasource in the org.
    queuedRows.push([{ group_id: null }]);

    expect(await resolveGroupIdForConnection("org-1", DEMO_CONNECTION_ID)).toBe(DEMO_CONNECTION_ID);
  });
});
