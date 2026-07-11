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

// context-loader dynamically imports internal ONLY inside loadRejectedKeys, and
// uses just these two exports — a partial mock is complete for this file.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string) => {
    capturedSql = sql;
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
});
