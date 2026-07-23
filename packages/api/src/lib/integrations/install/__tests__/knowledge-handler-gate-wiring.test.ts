/**
 * Every knowledge form handler must route its collection write through BOTH
 * shared gates (#4235) — the pre-write cap check and the atomic
 * cap-check-and-UPSERT.
 *
 * Why a source-level test rather than a behavioral one: each handler's own
 * suite mocks the internal DB with `getWorkspaceDetails → null`, which is the
 * "no `organization` row → no plan → no cap" fail-open. Every one of those
 * suites therefore passes IDENTICALLY whether the cap is wired or not, so a
 * handler that silently lost its gate — the most likely regression, given the
 * cap was threaded through twelve files by hand — would be invisible. This
 * asserts the wiring itself, which is exactly the property those suites cannot
 * see.
 *
 * The list is DISCOVERED, not enumerated: any file that writes a
 * `pillar='knowledge'` `workspace_plugins` row is in scope, so a thirteenth
 * connector is covered the day it lands.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const INSTALL_DIR = join(import.meta.dir, "..");

/** Handler files that persist a knowledge collection, discovered from source. */
function knowledgeHandlerFiles(): string[] {
  return readdirSync(INSTALL_DIR)
    .filter((f) => f.endsWith("-form-handler.ts"))
    .filter((f) => {
      const src = readFileSync(join(INSTALL_DIR, f), "utf8");
      // The shape every collection UPSERT shares: a knowledge-pillar insert.
      return src.includes("'knowledge',") && src.includes("INSERT INTO workspace_plugins");
    })
    .sort();
}

const HANDLERS = knowledgeHandlerFiles();

describe("knowledge form handlers are wired to the shared cap gates (#4235)", () => {
  it("discovers the expected handler set", () => {
    // A floor, not an exact list — the point is that discovery actually found
    // the handlers, so a broken predicate can't vacuously pass every test below.
    expect(HANDLERS.length).toBeGreaterThanOrEqual(12);
    expect(HANDLERS).toContain("okf-upload-form-handler.ts");
    expect(HANDLERS).toContain("zendesk-form-handler.ts");
  });

  for (const file of HANDLERS) {
    describe(file, () => {
      const src = readFileSync(join(INSTALL_DIR, file), "utf8");

      it("runs a pre-write cap gate before persisting anything", () => {
        // Single-collection handlers use the per-slug gate; fan-out handlers
        // (one collection per brand / KB / category / site) MUST use the batch
        // gate instead — a per-slug loop passes N times against the same
        // pre-write count and strands a partial install.
        const single = src.includes("assertCollectionInstallable(");
        const batch = src.includes("assertCollectionBatchInstallable(");
        expect(single || batch).toBe(true);
      });

      it("persists through the atomic cap-gated upsert, never a bare internalQuery", () => {
        expect(src).toContain("upsertKnowledgeCollectionRow(");
        // The pre-#4235 shape: a direct UPSERT that bypasses the advisory-locked
        // recount entirely.
        expect(src).not.toMatch(/internalQuery<\{ id: string \}>\(\s*\w*_UPSERT_SQL/);
      });

      it("appends RETURNING id to its collection upsert", () => {
        // `upsertKnowledgeCollectionRow` rejects SQL without it, but that is a
        // runtime error on the install path; catching it here is free.
        expect(src).toMatch(/RETURNING id/);
      });
    });
  }
});

describe("fan-out handlers use the BATCH gate (#4235)", () => {
  // These four create one collection per vendor object in a single install, so
  // they are the only handlers for which the per-slug gate is wrong.
  const FANOUT = [
    "zendesk-form-handler.ts",
    "front-form-handler.ts",
    "freshdesk-form-handler.ts",
    "helpscout-form-handler.ts",
  ];

  for (const file of FANOUT) {
    it(`${file} calls the batch gate and not the per-slug one`, () => {
      expect(HANDLERS).toContain(file);
      const src = readFileSync(join(INSTALL_DIR, file), "utf8");
      expect(src).toContain("assertCollectionBatchInstallable(");
      expect(src).not.toMatch(/\bassertCollectionInstallable\(/);
    });

    it(`${file} lets a tagged plan denial reach the route unwrapped`, () => {
      // `retryableInstallError` would otherwise flatten `FeatureEntitlementError`
      // / `BillingCheckFailedError` into a plain Error, turning a 403/503 into a
      // 500 that also claims "retrying the install is safe".
      const src = readFileSync(join(INSTALL_DIR, file), "utf8");
      expect(src).toContain('from "./retryable-install-error"');
      expect(src).toContain("isPlanDenial(err)");
      // No local copy of the wrapper may survive — that copy would not have the
      // tagged-error passthrough.
      expect(src).not.toMatch(/function retryableInstallError\(/);
    });
  }
});
