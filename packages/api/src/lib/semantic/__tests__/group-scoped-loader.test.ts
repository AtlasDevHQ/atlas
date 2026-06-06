/**
 * Tests for the group-scoped semantic-layer on-disk layout + loader (ADR-0012).
 *
 * Verifies the read side of ADR-0012:
 *   - the canonical `semantic/groups/<group>/entities/` namespace,
 *   - the flat default group at `semantic/entities/` (unchanged),
 *   - directory-as-canonical group inference (with `group:`/`connection:`
 *     as an override / deprecated alias),
 *   - a directory/field mismatch in the canonical namespace logging a
 *     warning (never silently honoring the field), and
 *   - back-compat for the legacy `semantic/<source>/entities/` layout.
 *
 * The logger is mocked (sync factory) so the mismatch warning is
 * observable — see `docs/development/testing.md` and the existing
 * `config-deploy-mode-warning.test.ts` for the pattern.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  hashShareToken: (token: string) => token,
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  redactPaths: [] as string[],
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler"] as const,
}));

const { getWhitelistedTables, getCrossSourceJoins, _resetWhitelists } = await import("../whitelist");
const { getEntityDirs, resolveEntityGroup } = await import("../scanner");

const tmpBase = resolve(__dirname, ".tmp-group-scoped-loader-test");
let testCounter = 0;

function ensureDir(subdir: string): string {
  const dir = resolve(tmpBase, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpBase() {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
}

function writeEntity(dir: string, filename: string, content: string) {
  writeFileSync(join(dir, filename), content);
}

const entity = (table: string, extra = "") =>
  `table: ${table}\n${extra}columns:\n  id:\n    type: integer\n`;

beforeEach(() => {
  _resetWhitelists();
  logCalls.length = 0;
  testCounter++;
});

afterEach(() => {
  _resetWhitelists();
  cleanTmpBase();
});

describe("getEntityDirs — group-scoped layout (ADR-0012)", () => {
  it("tags the flat default entities/ dir with origin 'flat'", () => {
    const root = ensureDir(`flat-${testCounter}`);
    ensureDir(`flat-${testCounter}/entities`);

    const { dirs } = getEntityDirs(root);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].sourceName).toBe("default");
    expect(dirs[0].origin).toBe("flat");
  });

  it("discovers semantic/groups/<group>/entities/ with origin 'group'", () => {
    const root = ensureDir(`grp-${testCounter}`);
    ensureDir(`grp-${testCounter}/entities`);
    ensureDir(`grp-${testCounter}/groups/warehouse/entities`);

    const { dirs } = getEntityDirs(root);
    const group = dirs.find((d) => d.sourceName === "warehouse");
    expect(group).toBeDefined();
    expect(group!.origin).toBe("group");
    // The flat default is still present and distinct.
    expect(dirs.some((d) => d.sourceName === "default" && d.origin === "flat")).toBe(true);
  });

  it("does NOT treat the groups/ namespace dir itself as a legacy source", () => {
    const root = ensureDir(`reserved-groups-${testCounter}`);
    ensureDir(`reserved-groups-${testCounter}/entities`);
    ensureDir(`reserved-groups-${testCounter}/groups/crm/entities`);

    const { dirs } = getEntityDirs(root);
    // No EntityDir should be named "groups" (it is a reserved namespace, not a source).
    expect(dirs.some((d) => d.sourceName === "groups")).toBe(false);
    expect(dirs.some((d) => d.sourceName === "crm" && d.origin === "group")).toBe(true);
  });

  it("still discovers the legacy semantic/<source>/entities/ layout with origin 'legacy'", () => {
    const root = ensureDir(`legacy-dir-${testCounter}`);
    ensureDir(`legacy-dir-${testCounter}/entities`);
    ensureDir(`legacy-dir-${testCounter}/sales/entities`);

    const { dirs } = getEntityDirs(root);
    const legacy = dirs.find((d) => d.sourceName === "sales");
    expect(legacy).toBeDefined();
    expect(legacy!.origin).toBe("legacy");
  });
});

describe("resolveEntityGroup — precedence (ADR-0012)", () => {
  it("uses the directory group when no field is present", () => {
    expect(resolveEntityGroup("warehouse", "group", undefined)).toEqual({ group: "warehouse", mismatch: false });
    expect(resolveEntityGroup("default", "flat", undefined)).toEqual({ group: "default", mismatch: false });
    expect(resolveEntityGroup("sales", "legacy", undefined)).toEqual({ group: "sales", mismatch: false });
  });

  it("flat-root field assigns the group (the override path)", () => {
    expect(resolveEntityGroup("default", "flat", "crm")).toEqual({ group: "crm", mismatch: false });
  });

  it("canonical group dir: a matching field is consistent (no mismatch)", () => {
    expect(resolveEntityGroup("warehouse", "group", "warehouse")).toEqual({ group: "warehouse", mismatch: false });
  });

  it("canonical group dir: a disagreeing field is a foot-gun → directory wins, mismatch flagged", () => {
    expect(resolveEntityGroup("warehouse", "group", "crm")).toEqual({ group: "warehouse", mismatch: true });
  });

  it("legacy dir preserves field-wins precedence (back-compat, no mismatch)", () => {
    expect(resolveEntityGroup("warehouse", "legacy", "analytics")).toEqual({ group: "analytics", mismatch: false });
  });
});

describe("getWhitelistedTables — group partitioning (ADR-0012)", () => {
  it("default-flat: single-DB layout is unchanged (shared whitelist)", () => {
    const root = ensureDir(`flat-share-${testCounter}`);
    const entities = ensureDir(`flat-share-${testCounter}/entities`);
    writeEntity(entities, "orders.yml", entity("orders"));
    writeEntity(entities, "users.yml", entity("users"));

    const def = getWhitelistedTables("default", undefined, root);
    const any = getWhitelistedTables("anything", undefined, root);
    expect(def.has("orders")).toBe(true);
    expect(def.has("users")).toBe(true);
    // No partition trigger → backward-compat shared mode.
    expect(any.has("orders")).toBe(true);
    expect(any.has("users")).toBe(true);
  });

  it("per-group dir: entities under groups/<group>/ are queryable under <group>", () => {
    const root = ensureDir(`grp-query-${testCounter}`);
    ensureDir(`grp-query-${testCounter}/entities`);
    const warehouse = ensureDir(`grp-query-${testCounter}/groups/warehouse/entities`);
    writeEntity(warehouse, "events.yml", entity("events"));

    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);
    const defaultTables = getWhitelistedTables("default", undefined, root);
    expect(warehouseTables.has("events")).toBe(true);
    expect(defaultTables.has("events")).toBe(false);
  });

  it("two groups under groups/ stay isolated", () => {
    const root = ensureDir(`grp-iso-${testCounter}`);
    ensureDir(`grp-iso-${testCounter}/entities`);
    const warehouse = ensureDir(`grp-iso-${testCounter}/groups/warehouse/entities`);
    const crm = ensureDir(`grp-iso-${testCounter}/groups/crm/entities`);
    writeEntity(warehouse, "events.yml", entity("events"));
    writeEntity(crm, "leads.yml", entity("leads"));

    expect(getWhitelistedTables("warehouse", undefined, root).has("events")).toBe(true);
    expect(getWhitelistedTables("warehouse", undefined, root).has("leads")).toBe(false);
    expect(getWhitelistedTables("crm", undefined, root).has("leads")).toBe(true);
    expect(getWhitelistedTables("crm", undefined, root).has("events")).toBe(false);
  });

  it("field override: a flat-root entity with group: assigns to that group", () => {
    const root = ensureDir(`field-override-${testCounter}`);
    const entities = ensureDir(`field-override-${testCounter}/entities`);
    writeEntity(entities, "leads.yml", entity("leads", "group: crm\n"));

    expect(getWhitelistedTables("crm", undefined, root).has("leads")).toBe(true);
    expect(getWhitelistedTables("default", undefined, root).has("leads")).toBe(false);
  });

  it("connection: is a deprecated alias for group: (flat-root assignment)", () => {
    const root = ensureDir(`alias-${testCounter}`);
    const entities = ensureDir(`alias-${testCounter}/entities`);
    writeEntity(entities, "accounts.yml", entity("accounts", "connection: crm\n"));

    expect(getWhitelistedTables("crm", undefined, root).has("accounts")).toBe(true);
    expect(getWhitelistedTables("default", undefined, root).has("accounts")).toBe(false);
  });

  it("group: takes precedence over the deprecated connection: alias", () => {
    const root = ensureDir(`alias-precedence-${testCounter}`);
    const entities = ensureDir(`alias-precedence-${testCounter}/entities`);
    // Both fields set: the canonical `group:` wins over the deprecated alias.
    writeEntity(entities, "x.yml", entity("x", "group: warehouse\nconnection: crm\n"));

    expect(getWhitelistedTables("warehouse", undefined, root).has("x")).toBe(true);
    expect(getWhitelistedTables("crm", undefined, root).has("x")).toBe(false);
  });

  it("dir/field mismatch in groups/: directory wins AND a warning is logged", () => {
    const root = ensureDir(`mismatch-${testCounter}`);
    ensureDir(`mismatch-${testCounter}/entities`);
    const warehouse = ensureDir(`mismatch-${testCounter}/groups/warehouse/entities`);
    // Foot-gun: entity sits in groups/warehouse/ but declares group: crm.
    writeEntity(warehouse, "sneaky.yml", entity("sneaky", "group: crm\n"));

    // Directory is canonical → routes to warehouse, NOT crm.
    expect(getWhitelistedTables("warehouse", undefined, root).has("sneaky")).toBe(true);
    expect(getWhitelistedTables("crm", undefined, root).has("sneaky")).toBe(false);

    // The mismatch must not be silent.
    const warned = logCalls.some(
      (c) => c.level === "warn" && /differs from its directory/i.test(c.message),
    );
    expect(warned).toBe(true);
  });

  it("legacy layout: semantic/<source>/entities/ still loads (back-compat)", () => {
    const root = ensureDir(`legacy-load-${testCounter}`);
    ensureDir(`legacy-load-${testCounter}/entities`);
    const sales = ensureDir(`legacy-load-${testCounter}/sales/entities`);
    writeEntity(sales, "deals.yml", entity("deals"));

    expect(getWhitelistedTables("sales", undefined, root).has("deals")).toBe(true);
    expect(getWhitelistedTables("default", undefined, root).has("deals")).toBe(false);
  });

  it("canonical groups/ and legacy <source>/ coexist", () => {
    const root = ensureDir(`coexist-${testCounter}`);
    ensureDir(`coexist-${testCounter}/entities`);
    const warehouse = ensureDir(`coexist-${testCounter}/groups/warehouse/entities`);
    const sales = ensureDir(`coexist-${testCounter}/sales/entities`);
    writeEntity(warehouse, "events.yml", entity("events"));
    writeEntity(sales, "deals.yml", entity("deals"));

    expect(getWhitelistedTables("warehouse", undefined, root).has("events")).toBe(true);
    expect(getWhitelistedTables("sales", undefined, root).has("deals")).toBe(true);
    expect(getWhitelistedTables("warehouse", undefined, root).has("deals")).toBe(false);
  });
});

describe("getCrossSourceJoins — group-scoped fromSource (ADR-0012)", () => {
  it("uses the canonical directory group as fromSource for groups/ entities", () => {
    const root = ensureDir(`csj-grp-${testCounter}`);
    ensureDir(`csj-grp-${testCounter}/entities`);
    const warehouse = ensureDir(`csj-grp-${testCounter}/groups/warehouse/entities`);
    writeEntity(
      warehouse,
      "events.yml",
      [
        "table: events",
        "columns:",
        "  id:",
        "    type: integer",
        "cross_source_joins:",
        "  - source: default",
        "    target_table: users",
        "    on: events.user_id = users.id",
        "    relationship: many_to_one",
      ].join("\n"),
    );

    const joins = getCrossSourceJoins(root);
    expect(joins).toHaveLength(1);
    expect(joins[0].fromSource).toBe("warehouse");
    expect(joins[0].toSource).toBe("default");
  });
});
