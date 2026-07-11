/**
 * `loadRejectedKeys` — the single canonical, group-scoped rejected-key loader
 * consumed by the analyzer staleness path on every surface (scheduler + CLI;
 * #4507).
 *
 * Pins two things the DB-seam guard test can't (it exercises a different
 * query, `findConflictingAmendment`):
 *   - Acceptance criterion 3: rejection memory is PERMANENT — the query has NO
 *     time window. Re-introducing `reviewed_at >= now() - interval '30 days'`
 *     would silently restore expiry and pass every other gate.
 *   - Keys are reconstructed group-scoped via the shared
 *     `amendmentIdentityFromRow`, so the loader agrees with the analyzer's
 *     `stalenessFactor` and the insert-time guard.
 */

import { describe, it, expect, mock } from "bun:test";

let capturedSql = "";
let capturedParams: unknown[] = [];

// context-loader dynamically imports internal ONLY inside loadRejectedKeys, and
// uses just these two exports — a partial mock is complete for this file.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    capturedSql = sql;
    capturedParams = params;
    return [
      {
        source_entity: "orders",
        connection_group_id: "eu",
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
      {
        source_entity: "orders",
        connection_group_id: null,
        amendment_payload: JSON.stringify({ amendmentType: "add_measure", amendment: { name: "total_amount" } }),
      },
    ];
  },
}));

const { loadRejectedKeys } = await import("../context-loader");

describe("loadRejectedKeys (#4507)", () => {
  it("queries rejected rows with NO time window — rejection memory is permanent", async () => {
    await loadRejectedKeys();

    expect(capturedSql).toContain("status = 'rejected'");
    // Acceptance criterion 3 — no time-based expiry anywhere.
    expect(capturedSql).not.toContain("interval");
    expect(capturedSql).not.toContain("reviewed_at");
  });

  it("reconstructs group-scoped identity keys via the shared canonical builder", async () => {
    const keys = await loadRejectedKeys();

    // NULL group → "default"; a real group is preserved. Object and
    // JSON-string payloads both reconstruct.
    expect(keys.has("eu:orders:add_dimension:region")).toBe(true);
    expect(keys.has("default:orders:add_measure:total_amount")).toBe(true);
    expect(keys.size).toBe(2);
  });

  // #4516 — the SaaS per-workspace scheduler passes an orgId so the pre-filter
  // is scoped to one tenant; without it the union of every tenant's rejections
  // would over-suppress. Self-hosted / CLI omit it (global NULL-org scan).
  it("scopes the scan to one workspace when an orgId is passed", async () => {
    await loadRejectedKeys("org-42");

    expect(capturedSql).toContain("org_id = $1");
    expect(capturedParams).toEqual(["org-42"]);
  });

  it("does not filter by org when no orgId is passed (self-hosted / CLI)", async () => {
    await loadRejectedKeys();

    expect(capturedSql).not.toContain("org_id = $1");
    expect(capturedParams).toEqual([]);
  });
});
