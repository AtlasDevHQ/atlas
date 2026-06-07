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
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import * as fs from "fs";

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

const { getWhitelistedTables, getWhitelistedTablesStrict, SemanticLayerScanError, getCrossSourceJoins, _resetWhitelists } = await import("../whitelist");
const { getEntityDirs, getGroupDirs, resolveEntityGroup } = await import("../scanner");

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

describe("getGroupDirs — shared layout traversal (ADR-0012 / #3240)", () => {
  it("resolves a named subdir (metrics) across flat / groups / legacy layouts", () => {
    const root = ensureDir(`gd-metrics-${testCounter}`);
    ensureDir(`gd-metrics-${testCounter}/metrics`); // flat default
    ensureDir(`gd-metrics-${testCounter}/groups/analytics/metrics`); // canonical
    ensureDir(`gd-metrics-${testCounter}/sales/metrics`); // legacy

    const { dirs } = getGroupDirs(root, "metrics");
    const byGroup = Object.fromEntries(dirs.map((d) => [d.group, d]));
    expect(byGroup["default"]?.origin).toBe("flat");
    expect(byGroup["analytics"]?.origin).toBe("group");
    expect(byGroup["sales"]?.origin).toBe("legacy");
    // Each resolved dir is the <base>/metrics target.
    expect(byGroup["analytics"]?.dir.endsWith(join("analytics", "metrics"))).toBe(true);
  });

  it("returns only existing target dirs for a named subdir", () => {
    const root = ensureDir(`gd-missing-${testCounter}`);
    ensureDir(`gd-missing-${testCounter}/groups/warehouse/entities`); // no metrics/ here

    const { dirs } = getGroupDirs(root, "metrics");
    // warehouse has entities/ but no metrics/ → not returned for subdir "metrics".
    expect(dirs.some((d) => d.group === "warehouse")).toBe(false);
  });

  it("subdir=null returns the per-group base dir (for glossary.yml / catalog.yml)", () => {
    const root = ensureDir(`gd-null-${testCounter}`);
    ensureDir(`gd-null-${testCounter}/groups/analytics/entities`);
    ensureDir(`gd-null-${testCounter}/sales/entities`);

    const { dirs } = getGroupDirs(root, null);
    const byGroup = Object.fromEntries(dirs.map((d) => [d.group, d]));
    // Flat default base is the root itself.
    expect(byGroup["default"]?.dir).toBe(root);
    expect(byGroup["default"]?.origin).toBe("flat");
    // Group base is groups/<group>, NOT groups/<group>/<subdir>.
    expect(byGroup["analytics"]?.dir.endsWith(join("groups", "analytics"))).toBe(true);
    expect(byGroup["analytics"]?.origin).toBe("group");
    expect(byGroup["sales"]?.origin).toBe("legacy");
  });

  it("never attributes a directory to a source named 'groups'", () => {
    const root = ensureDir(`gd-reserved-${testCounter}`);
    ensureDir(`gd-reserved-${testCounter}/groups/crm/metrics`);

    expect(getGroupDirs(root, "metrics").dirs.some((d) => d.group === "groups")).toBe(false);
    expect(getGroupDirs(root, null).dirs.some((d) => d.group === "groups")).toBe(false);
  });

  it("getEntityDirs is a faithful projection of getGroupDirs(root, 'entities')", () => {
    const root = ensureDir(`gd-parity-${testCounter}`);
    ensureDir(`gd-parity-${testCounter}/entities`);
    ensureDir(`gd-parity-${testCounter}/groups/warehouse/entities`);
    ensureDir(`gd-parity-${testCounter}/sales/entities`);

    const groupDirs = getGroupDirs(root, "entities").dirs;
    const entityDirs = getEntityDirs(root).dirs;
    expect(entityDirs.map((d) => [d.dir, d.sourceName, d.origin])).toEqual(
      groupDirs.map((d) => [d.dir, d.group, d.origin]),
    );
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

  it("same group name under groups/ and legacy <source>/ merges into one group (migration seam)", () => {
    // A half-migrated layout: groups/warehouse/ (canonical) and warehouse/
    // (legacy) for the same group. Both accrete into the one `warehouse` group.
    const root = ensureDir(`merge-${testCounter}`);
    ensureDir(`merge-${testCounter}/entities`);
    const canonical = ensureDir(`merge-${testCounter}/groups/warehouse/entities`);
    const legacy = ensureDir(`merge-${testCounter}/warehouse/entities`);
    writeEntity(canonical, "events.yml", entity("events"));
    writeEntity(legacy, "sessions.yml", entity("sessions"));

    const warehouse = getWhitelistedTables("warehouse", undefined, root);
    expect(warehouse.has("events")).toBe(true);
    expect(warehouse.has("sessions")).toBe(true);
  });

  it("empty groups/<group>/ dir fails closed (does not inherit default tables)", () => {
    // A discovered-but-empty canonical group must be its own empty group, not
    // silently fall back to shared mode and serve the default group's tables.
    const root = ensureDir(`empty-group-${testCounter}`);
    const entities = ensureDir(`empty-group-${testCounter}/entities`);
    ensureDir(`empty-group-${testCounter}/groups/warehouse/entities`); // empty
    writeEntity(entities, "orders.yml", entity("orders"));

    expect(getWhitelistedTables("default", undefined, root).has("orders")).toBe(true);
    // Partition is triggered by the discovered group → warehouse is empty,
    // NOT the default group's tables.
    const warehouse = getWhitelistedTables("warehouse", undefined, root);
    expect(warehouse.has("orders")).toBe(false);
    expect(warehouse.size).toBe(0);
  });

  it("all-invalid groups/<group>/ dir fails closed", () => {
    const root = ensureDir(`broken-group-${testCounter}`);
    const entities = ensureDir(`broken-group-${testCounter}/entities`);
    const warehouse = ensureDir(`broken-group-${testCounter}/groups/warehouse/entities`);
    writeEntity(entities, "orders.yml", entity("orders"));
    // Missing the required `table` field → fails EntityShape validation.
    writeEntity(warehouse, "broken.yml", "columns:\n  id:\n    type: integer\n");

    const warehouseTables = getWhitelistedTables("warehouse", undefined, root);
    expect(warehouseTables.has("orders")).toBe(false);
    expect(warehouseTables.size).toBe(0);
  });
});

describe("fail-closed on directory scan failure (#3243)", () => {
  // Simulate a real FS error (EACCES) on a single readdir path — distinct from
  // "directory absent", which `existsSync` already guards. The dir EXISTS but
  // cannot be enumerated, so its groups silently drop out of the whitelist
  // unless we fail closed. We delegate every non-target readdir to the real fs
  // so directory setup and the default `entities/` read still work.
  // `spyOn(fs, …)` patches the shared `fs` namespace that scanner.ts calls
  // through (same pattern as explore-backend.test.ts).
  function throwReaddirOn(targetPath: string, code = "EACCES"): ReturnType<typeof spyOn> {
    const realReaddir = fs.readdirSync.bind(fs) as (p: fs.PathLike, o?: unknown) => unknown;
    return spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, options?: unknown) => {
      if (typeof p === "string" && p === targetPath) {
        throw Object.assign(new Error(`${code}: simulated scan failure`), { code });
      }
      return realReaddir(p, options);
    }) as unknown as typeof fs.readdirSync);
  }

  it("getEntityDirs reports failedScans:['groups'] when the groups/ scan throws", () => {
    const root = ensureDir(`scanfail-groups-${testCounter}`);
    ensureDir(`scanfail-groups-${testCounter}/entities`);
    ensureDir(`scanfail-groups-${testCounter}/groups`); // exists → readdir attempted
    const spy = throwReaddirOn(join(root, "groups"));
    try {
      const { failedScans } = getEntityDirs(root);
      expect(failedScans).toContain("groups");
      expect(failedScans).not.toContain("legacy");
    } finally {
      spy.mockRestore();
    }
  });

  it("getEntityDirs reports failedScans:['legacy'] when the legacy root scan throws", () => {
    const root = ensureDir(`scanfail-legacy-${testCounter}`);
    ensureDir(`scanfail-legacy-${testCounter}/entities`);
    // No groups/ dir → groups scan skipped; the root (legacy) readdir throws.
    const spy = throwReaddirOn(root);
    try {
      const { failedScans } = getEntityDirs(root);
      expect(failedScans).toContain("legacy");
      expect(failedScans).not.toContain("groups");
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed groups/ scan fails CLOSED — affected group gets an EMPTY set, not default's tables", () => {
    const root = ensureDir(`scanfail-closed-${testCounter}`);
    const entities = ensureDir(`scanfail-closed-${testCounter}/entities`);
    ensureDir(`scanfail-closed-${testCounter}/groups`);
    writeEntity(entities, "orders.yml", entity("orders"));
    const spy = throwReaddirOn(join(root, "groups"));
    try {
      // default is unaffected by a groups/ scan failure → still serves its tables.
      expect(getWhitelistedTables("default", undefined, root).has("orders")).toBe(true);
      // The group whose scan failed must NOT inherit default's tables.
      const warehouse = getWhitelistedTables("warehouse", undefined, root);
      expect(warehouse.has("orders")).toBe(false);
      expect(warehouse.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed scan does NOT drop to shared-default mode", () => {
    // Pre-fix: with only `default` surviving, hasNonDefaultConnection=false →
    // shared mode → EVERY connection validates against default's tables. The
    // scan-failure signal must keep us out of shared mode (fail-toward-widening).
    const root = ensureDir(`scanfail-noshare-${testCounter}`);
    const entities = ensureDir(`scanfail-noshare-${testCounter}/entities`);
    ensureDir(`scanfail-noshare-${testCounter}/groups`);
    writeEntity(entities, "orders.yml", entity("orders"));
    const spy = throwReaddirOn(join(root, "groups"));
    try {
      // An arbitrary non-default connection must NOT see default's `orders`.
      expect(getWhitelistedTables("anything", undefined, root).has("orders")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("the escalated error names WHICH scan failed and is distinct from the no-entities warning", () => {
    const root = ensureDir(`scanfail-log-${testCounter}`);
    const entities = ensureDir(`scanfail-log-${testCounter}/entities`);
    ensureDir(`scanfail-log-${testCounter}/groups`);
    writeEntity(entities, "orders.yml", entity("orders"));
    const spy = throwReaddirOn(join(root, "groups"));
    try {
      getWhitelistedTables("warehouse", undefined, root);
      // Names the failed namespace in the escalated (error-level) log payload.
      const named = logCalls.some(
        (c) =>
          c.level === "error" &&
          Array.isArray((c.payload as { failedScans?: unknown }).failedScans) &&
          (c.payload as { failedScans: string[] }).failedScans.includes("groups"),
      );
      expect(named).toBe(true);
      // Distinguishes "scan failed (incomplete)" from "no entities configured":
      // the empty `warehouse` whitelist is logged as a scan failure, NOT the
      // benign "No entities configured" warning.
      const scanFailedMsg = logCalls.some(
        (c) => /scan failed/i.test(c.message) && /(load incomplete|failing closed)/i.test(c.message),
      );
      expect(scanFailedMsg).toBe(true);
      const noEntitiesMsg = logCalls.some((c) =>
        /No entities configured for connection/i.test(c.message),
      );
      expect(noEntitiesMsg).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("a successful scan with a genuinely empty group keeps the benign 'no entities configured' message", () => {
    // No scan failure: an absent group must keep today's behavior (benign warn,
    // not a scan-failure error) — the two operator situations stay distinct.
    const root = ensureDir(`noscanfail-${testCounter}`);
    const entities = ensureDir(`noscanfail-${testCounter}/entities`);
    ensureDir(`noscanfail-${testCounter}/groups/warehouse/entities`); // empty, real dir
    writeEntity(entities, "orders.yml", entity("orders"));

    // `crm` has no directory → empty set, but no scan failed.
    const crm = getWhitelistedTables("crm", undefined, root);
    expect(crm.size).toBe(0);
    const noEntitiesMsg = logCalls.some(
      (c) => c.level === "warn" && /No entities configured for connection/i.test(c.message),
    );
    expect(noEntitiesMsg).toBe(true);
    const scanFailedErr = logCalls.some((c) => c.level === "error" && /scan failed/i.test(c.message));
    expect(scanFailedErr).toBe(false);
  });

  // The bespoke plugin query tools (ES Query DSL / SOQL) treat an EMPTY set as
  // structural-only, so they must distinguish "empty because scan failed" (fail
  // closed) from "empty because no layer" (structural-only). `getWhitelistedTablesStrict`
  // is that signal: it throws on the former and returns `[]` on the latter (#3313).
  describe("getWhitelistedTablesStrict — fail closed on scan failure (#3313)", () => {
    it("THROWS SemanticLayerScanError when an empty whitelist is caused by a failed scan", () => {
      const root = ensureDir(`strict-scanfail-${testCounter}`);
      const entities = ensureDir(`strict-scanfail-${testCounter}/entities`);
      ensureDir(`strict-scanfail-${testCounter}/groups`);
      writeEntity(entities, "orders.yml", entity("orders"));
      const spy = throwReaddirOn(join(root, "groups"));
      try {
        // The group whose scan failed resolves to an empty set — strict refuses.
        expect(() => getWhitelistedTablesStrict("warehouse", undefined, root)).toThrow(
          SemanticLayerScanError,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("returns [] (does NOT throw) for a legitimately unconfigured layer — structural-only preserved", () => {
      const root = ensureDir(`strict-nolayer-${testCounter}`);
      const entities = ensureDir(`strict-nolayer-${testCounter}/entities`);
      ensureDir(`strict-nolayer-${testCounter}/groups/warehouse/entities`); // empty, real dir
      writeEntity(entities, "orders.yml", entity("orders"));
      // `crm` has no directory → empty set, but NO scan failed → must not throw.
      const crm = getWhitelistedTablesStrict("crm", undefined, root);
      expect(crm.size).toBe(0);
    });

    it("returns the resolved tables (does NOT throw) when the connection has a whitelist", () => {
      const root = ensureDir(`strict-haslayer-${testCounter}`);
      const entities = ensureDir(`strict-haslayer-${testCounter}/entities`);
      writeEntity(entities, "orders.yml", entity("orders"));
      const tables = getWhitelistedTablesStrict("default", undefined, root);
      expect(tables.has("orders")).toBe(true);
    });

    it("does NOT throw when a scan failed but the connection still resolves a non-empty whitelist", () => {
      // A non-empty set still enforces membership (unlisted names rejected), so an
      // incomplete scan can only over-restrict it — never widen — and need not refuse.
      const root = ensureDir(`strict-scanfail-nonempty-${testCounter}`);
      const entities = ensureDir(`strict-scanfail-nonempty-${testCounter}/entities`);
      ensureDir(`strict-scanfail-nonempty-${testCounter}/groups`);
      writeEntity(entities, "orders.yml", entity("orders"));
      const spy = throwReaddirOn(join(root, "groups"));
      try {
        // `default` is unaffected by the groups/ scan failure → non-empty → no throw.
        const def = getWhitelistedTablesStrict("default", undefined, root);
        expect(def.has("orders")).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
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
