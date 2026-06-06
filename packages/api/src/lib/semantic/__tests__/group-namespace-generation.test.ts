/**
 * Tests for group-namespace generation — the WRITE side of ADR-0012 (#3234).
 *
 * `atlas init` and the wizard write a generated semantic layer via
 * `outputDirForGroup`. These tests pin that the canonical `groups/<group>/`
 * layout it produces is exactly what the #3232 loader
 * (`getEntityDirs` / `scanEntities`) reads back under the same group — i.e.
 * generate → load round-trips, the default group stays flat (no `groups/`
 * dir), and a non-default group is attributed to its directory.
 *
 * The logger is mocked (sync factory) so scanner warnings can't crash the
 * loader — see docs/development/testing.md.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve, join, relative } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import type { TableProfile } from "../../profiler";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  withRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
}));

const { outputDirForGroup, generateEntityYAML } = await import("../../profiler");
const { getEntityDirs, scanEntities } = await import("../scanner");

const tmpBase = resolve(__dirname, ".tmp-group-namespace-gen-test");
let counter = 0;

function freshRoot(): string {
  counter++;
  const r = join(tmpBase, `t-${counter}`);
  mkdirSync(r, { recursive: true });
  return r;
}

/**
 * The path (relative to the default flat root) that `outputDirForGroup`
 * lays a group's layer into — the literal directory the CLI/wizard write.
 * Deriving the test layout from the production helper makes this a true
 * round-trip rather than a hand-built fixture that could drift.
 */
function groupSubpath(group: string | undefined): string {
  return relative(outputDirForGroup(undefined), outputDirForGroup(group));
}

function profile(table: string): TableProfile {
  return {
    table_name: table,
    object_type: "table",
    row_count: 100,
    columns: [
      {
        name: "id",
        type: "integer",
        nullable: false,
        unique_count: 100,
        null_count: 0,
        sample_values: [],
        is_primary_key: true,
        is_foreign_key: false,
        fk_target_table: null,
        fk_target_column: null,
        is_enum_like: false,
        profiler_notes: [],
      },
    ],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  };
}

beforeEach(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

afterEach(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

describe("group-namespace generation (#3234, ADR-0012)", () => {
  it("writes a non-default group into groups/<group>/ that the loader reads back under that group", () => {
    const root = freshRoot();
    // The CLI/wizard write to outputDirForGroup("warehouse", …) — derive the
    // same on-disk layout under a temp root.
    const sub = groupSubpath("warehouse");
    expect(sub).toBe(join("groups", "warehouse"));

    const entitiesDir = join(root, sub, "entities");
    mkdirSync(entitiesDir, { recursive: true });
    writeFileSync(
      join(entitiesDir, "orders.yml"),
      generateEntityYAML(profile("orders"), [profile("orders")], "postgres", "public", "warehouse"),
    );

    // Loader (read side, #3232) attributes the dir to group "warehouse".
    const { dirs } = getEntityDirs(root);
    const warehouse = dirs.find((d) => d.sourceName === "warehouse");
    expect(warehouse).toBeDefined();
    expect(warehouse!.origin).toBe("group");

    const { entities, warnings } = scanEntities(root);
    expect(warnings).toHaveLength(0);
    const orders = entities.find((e) => e.raw.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.sourceName).toBe("warehouse");
    expect(orders!.origin).toBe("group");

    // #3285: the generator emits the canonical `group:` field, not the
    // deprecated `connection:` alias (ADR-0012). Pin it on the parsed output —
    // the round-trip above passes either way because the directory is canonical
    // for `groups/` origin, so it can't catch a deprecated-field regression.
    expect(orders!.raw.group).toBe("warehouse");
    expect(orders!.raw.connection).toBeUndefined();
  });

  it("writes the default group flat at the root with no groups/ directory", () => {
    const root = freshRoot();
    // The default group adds zero nesting — flat root, the standalone-DB case.
    expect(groupSubpath(undefined)).toBe("");
    expect(groupSubpath("default")).toBe("");

    const entitiesDir = join(root, "entities");
    mkdirSync(entitiesDir, { recursive: true });
    writeFileSync(
      join(entitiesDir, "orders.yml"),
      generateEntityYAML(profile("orders"), [profile("orders")], "postgres", "public", undefined),
    );

    // AC: a standalone DB generates a flat default-group layout (no groups/).
    expect(existsSync(join(root, "groups"))).toBe(false);

    const { dirs } = getEntityDirs(root);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].sourceName).toBe("default");
    expect(dirs[0].origin).toBe("flat");

    const { entities } = scanEntities(root);
    const orders = entities.find((e) => e.raw.table === "orders");
    expect(orders!.sourceName).toBe("default");
    expect(orders!.origin).toBe("flat");

    // #3285: the default group emits no group field at all (flat root), so a
    // standalone DB gains neither `group:` nor the deprecated `connection:`.
    expect(orders!.raw.group).toBeUndefined();
    expect(orders!.raw.connection).toBeUndefined();
  });

  it("keeps multiple groups isolated on disk and distinctly attributed", () => {
    const root = freshRoot();
    for (const group of ["warehouse", "crm"]) {
      const dir = join(root, groupSubpath(group), "entities");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${group}_events.yml`),
        generateEntityYAML(profile(`${group}_events`), [profile(`${group}_events`)], "postgres", "public", group),
      );
    }

    const { dirs } = getEntityDirs(root);
    expect(dirs.filter((d) => d.origin === "group").map((d) => d.sourceName).sort()).toEqual(["crm", "warehouse"]);

    const { entities } = scanEntities(root);
    const bySource = Object.fromEntries(entities.map((e) => [e.raw.table, e.sourceName]));
    expect(bySource["warehouse_events"]).toBe("warehouse");
    expect(bySource["crm_events"]).toBe("crm");
  });
});
