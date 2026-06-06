/**
 * Tests for `getYAMLSnapshots` group-namespace traversal (#3245, ADR-0012).
 *
 * The drift YAML-snapshot reader used to reconstruct each entity's path as the
 * LEGACY `<root>/<source>/entities/<table>.yml`, which:
 *   - silently skipped the canonical `groups/<group>/entities/` namespace
 *     (`existsSync` failed → entity dropped → drift drawer empty for groups), and
 *   - rebuilt the filename from `table` instead of the file stem (`name`), so a
 *     YAML whose filename differed from its `table` never resolved.
 *
 * These tests exercise the real `getYAMLSnapshots` against a temp semantic root
 * (no DB, no mocked modules — it reads disk via `ATLAS_SEMANTIC_ROOT`).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve, join } from "path";
import { getYAMLSnapshots } from "../diff";

const tmp = resolve(import.meta.dir, ".tmp-diff-group-snapshots");
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.ATLAS_SEMANTIC_ROOT;
  process.env.ATLAS_SEMANTIC_ROOT = tmp;
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = prevRoot;
  rmSync(tmp, { recursive: true, force: true });
});

/** Write an entity YAML under `<tmp>/<...segments>/entities/<file>`. */
function writeEntity(file: string, content: string, ...segments: string[]) {
  const dir = join(tmp, ...segments, "entities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

const entity = (table: string, extra = "") =>
  `${extra}table: ${table}\ndimensions:\n  - name: id\n    type: number\n  - name: created_at\n    type: date\n`;

describe("getYAMLSnapshots — group-scoped layout (#3245)", () => {
  it("resolves grouped entities from groups/<group>/entities/", () => {
    writeEntity("sales.yml", entity("sales"), "groups", "prod");

    const { snapshots, warnings } = getYAMLSnapshots("prod");

    expect(snapshots.has("sales")).toBe(true);
    expect(snapshots.get("sales")!.columns.get("id")).toBe("number");
    expect(warnings).toHaveLength(0);
  });

  it("resolves a grouped entity via its file stem (name), not its table", () => {
    // File stem `sales_entity` ≠ `table: fact_sales`. The legacy path
    // reconstruction keyed on `table`, so this never resolved.
    writeEntity(
      "sales_entity.yml",
      entity("fact_sales", "name: sales_entity\n"),
      "groups",
      "prod",
    );

    const { snapshots } = getYAMLSnapshots("prod");

    expect(snapshots.has("fact_sales")).toBe(true);
  });

  it("scopes grouped entities to their own group (does not leak across groups)", () => {
    writeEntity("orders.yml", entity("orders_us"), "groups", "us");
    writeEntity("orders.yml", entity("orders_eu"), "groups", "eu");

    const us = getYAMLSnapshots("us");
    const eu = getYAMLSnapshots("eu");

    expect(us.snapshots.has("orders_us")).toBe(true);
    expect(us.snapshots.has("orders_eu")).toBe(false);
    expect(eu.snapshots.has("orders_eu")).toBe(true);
    expect(eu.snapshots.has("orders_us")).toBe(false);
  });

  it("scopes a grouped entity by its directory, not a disagreeing connection field (ADR-0012)", () => {
    // A canonical groups/<group>/ entity whose `connection:` field disagrees
    // with its directory must scope to the DIRECTORY (matching the importer +
    // whitelist), not the field — otherwise the drift view diverges from the
    // imported whitelist for the same files (#3245).
    writeEntity("sales.yml", entity("sales", "connection: staging\n"), "groups", "prod");

    const prod = getYAMLSnapshots("prod");
    const staging = getYAMLSnapshots("staging");

    expect(prod.snapshots.has("sales")).toBe(true); // directory wins
    expect(staging.snapshots.has("sales")).toBe(false); // field does NOT win
  });

  it("leaves the flat default layout unchanged", () => {
    writeEntity("users.yml", entity("users"));

    const { snapshots } = getYAMLSnapshots("default");

    expect(snapshots.has("users")).toBe(true);
  });

  it("leaves the legacy <source>/entities/ layout unchanged", () => {
    writeEntity("orders.yml", entity("orders"), "warehouse");

    const { snapshots } = getYAMLSnapshots("warehouse");

    expect(snapshots.has("orders")).toBe(true);
  });

  it("includes a grouped entity in the computed diff, mirroring flat entities", async () => {
    writeEntity("sales.yml", entity("sales"), "groups", "prod");
    const { computeDiff } = await import("../diff");

    const { snapshots } = getYAMLSnapshots("prod");
    const dbSide = new Map(snapshots); // identical → unchanged, not skipped
    const diff = computeDiff(dbSide, snapshots);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.removedTables).not.toContain("sales");
  });
});
