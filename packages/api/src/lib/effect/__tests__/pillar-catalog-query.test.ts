/**
 * Tests for `PillarCatalogQuery` (#2741 — slice 3 of 1.5.3).
 *
 * Three layers of coverage:
 *
 * 1. `projectCatalogWithInstalls` — pure function. Plan gating × install
 *    presence × card-state per pillar (`coming_soon`, `available`).
 *    No Effect / no DB.
 * 2. `createPillarCatalogQueryTestLayer` — the test-layer factory itself
 *    (stub-by-default semantics + partial overrides land correctly).
 * 3. `PillarCatalogQueryLive` via an in-memory `InternalDB` Layer —
 *    drives the SQL projection end-to-end with a stub `db.query` so
 *    we exercise SQL fragment + row → entity mapping without standing
 *    up Postgres.
 */

import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { IMPLEMENTATION_STATUSES, PILLARS, type Pillar } from "@useatlas/types";
import {
  PillarCatalogQuery,
  PillarCatalogQueryLive,
  createPillarCatalogQueryTestLayer,
  projectCatalogWithInstalls,
  type CatalogEntry,
  type CatalogEntryWithState,
  type WorkspaceInstall,
} from "../pillar-catalog-query";
import { InternalDB, type InternalDBShape } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "catalog:slack",
    slug: "slack",
    name: "Slack",
    description: "Connect Slack",
    type: "chat",
    installModel: "oauth",
    iconUrl: null,
    configSchema: null,
    minPlan: "starter",
    saasEligible: true,
    pillar: "chat",
    implementationStatus: "available",
    autoInstall: false,
    ...overrides,
  };
}

function makeInstall(overrides: Partial<WorkspaceInstall> = {}): WorkspaceInstall {
  return {
    id: "install-1",
    catalogId: "catalog:slack",
    installId: "catalog:slack",
    workspaceId: "org-1",
    pillar: "chat",
    installedAt: "2026-05-20T10:00:00.000Z",
    installedBy: "user-1",
    status: null,
    disabled: false,
    config: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. projectCatalogWithInstalls — pure function
// ---------------------------------------------------------------------------

describe("projectCatalogWithInstalls", () => {
  describe("plan gating", () => {
    it("flags entries above the workspace plan as planAccessible=false", () => {
      const slack = makeEntry({ minPlan: "starter" });
      const salesforce = makeEntry({
        id: "catalog:salesforce",
        slug: "salesforce",
        minPlan: "business",
        type: "integration",
        pillar: "action",
      });
      const result = projectCatalogWithInstalls({
        catalog: [slack, salesforce],
        installs: [],
        plan: { planTier: "starter", isOperator: false },
      });
      const slackOut = result.find((e) => e.slug === "slack")!;
      const sfOut = result.find((e) => e.slug === "salesforce")!;
      expect(slackOut.planAccessible).toBe(true);
      expect(slackOut.state).toBe("accessible");
      expect(sfOut.planAccessible).toBe(false);
      expect(sfOut.state).toBe("upgrade_required");
    });

    it("operator workspaces bypass the plan gate even for above-plan rows", () => {
      const salesforce = makeEntry({
        id: "catalog:salesforce",
        slug: "salesforce",
        minPlan: "business",
        type: "integration",
        pillar: "action",
      });
      const result = projectCatalogWithInstalls({
        catalog: [salesforce],
        installs: [],
        plan: { planTier: "starter", isOperator: true },
      });
      expect(result[0]!.planAccessible).toBe(true);
      expect(result[0]!.state).toBe("accessible");
    });

    it("unknown min_plan values fail closed to upgrade_required", () => {
      const drift = makeEntry({ minPlan: "platinum" });
      const result = projectCatalogWithInstalls({
        catalog: [drift],
        installs: [],
        plan: { planTier: "business", isOperator: false },
      });
      expect(result[0]!.planAccessible).toBe(false);
      expect(result[0]!.state).toBe("upgrade_required");
    });
  });

  describe("install presence", () => {
    it("emits install=null and state=accessible when no install row matches", () => {
      const entry = makeEntry();
      const result = projectCatalogWithInstalls({
        catalog: [entry],
        installs: [],
        plan: { planTier: "starter", isOperator: false },
      });
      expect(result[0]!.install).toBeNull();
      expect(result[0]!.state).toBe("accessible");
    });

    it("matches install rows by catalog_id and emits state=connected", () => {
      const entry = makeEntry();
      const install = makeInstall({ catalogId: entry.id });
      const result = projectCatalogWithInstalls({
        catalog: [entry],
        installs: [install],
        plan: { planTier: "starter", isOperator: false },
      });
      expect(result[0]!.install).toEqual(install);
      expect(result[0]!.state).toBe("connected");
    });

    it("emits state=configured_but_downgraded when install present but plan denies", () => {
      const entry = makeEntry({ minPlan: "business" });
      const install = makeInstall({ catalogId: entry.id });
      const result = projectCatalogWithInstalls({
        catalog: [entry],
        installs: [install],
        plan: { planTier: "starter", isOperator: false },
      });
      expect(result[0]!.install).toEqual(install);
      expect(result[0]!.state).toBe("configured_but_downgraded");
    });

    it("does not match across catalog ids (cross-row install leakage guard)", () => {
      const slack = makeEntry();
      const sf = makeEntry({ id: "catalog:salesforce", slug: "salesforce", pillar: "action" });
      const sfInstall = makeInstall({ catalogId: "catalog:salesforce", installId: "catalog:salesforce" });
      const result = projectCatalogWithInstalls({
        catalog: [slack, sf],
        installs: [sfInstall],
        plan: { planTier: "starter", isOperator: false },
      });
      const slackOut = result.find((e) => e.slug === "slack")!;
      const sfOut = result.find((e) => e.slug === "salesforce")!;
      expect(slackOut.install).toBeNull();
      expect(sfOut.install).toEqual(sfInstall);
    });
  });

  describe("card-state per pillar", () => {
    // Walks all three pillars with the four state-machine endpoints
    // (`coming_soon`, `upgrade_required`, `connected`, `accessible`).
    // `configured_but_downgraded` is covered above; the misconfigured
    // gate is pinned `true` in slice 3 — see module header comment.
    const pillarCases: ReadonlyArray<{ pillar: Pillar; type: string }> = [
      { pillar: "chat", type: "chat" },
      { pillar: "action", type: "integration" },
      { pillar: "datasource", type: "datasource" },
    ];

    for (const { pillar, type } of pillarCases) {
      it(`pillar=${pillar}: coming_soon dominates plan + install gates`, () => {
        const entry = makeEntry({
          pillar,
          type,
          implementationStatus: "coming_soon",
        });
        const install = makeInstall({ pillar, catalogId: entry.id });
        const result = projectCatalogWithInstalls({
          catalog: [entry],
          installs: [install],
          plan: { planTier: "business", isOperator: true },
        });
        expect(result[0]!.state).toBe("coming_soon");
      });

      it(`pillar=${pillar}: available → upgrade_required when plan denies (no install)`, () => {
        const entry = makeEntry({
          pillar,
          type,
          minPlan: "business",
          implementationStatus: "available",
        });
        const result = projectCatalogWithInstalls({
          catalog: [entry],
          installs: [],
          plan: { planTier: "starter", isOperator: false },
        });
        expect(result[0]!.state).toBe("upgrade_required");
      });

      it(`pillar=${pillar}: available → connected when plan admits + install present`, () => {
        const entry = makeEntry({
          pillar,
          type,
          minPlan: "starter",
          implementationStatus: "available",
        });
        const install = makeInstall({ pillar, catalogId: entry.id });
        const result = projectCatalogWithInstalls({
          catalog: [entry],
          installs: [install],
          plan: { planTier: "starter", isOperator: false },
        });
        expect(result[0]!.state).toBe("connected");
      });

      it(`pillar=${pillar}: available → accessible when plan admits + no install`, () => {
        const entry = makeEntry({
          pillar,
          type,
          minPlan: "starter",
          implementationStatus: "available",
        });
        const result = projectCatalogWithInstalls({
          catalog: [entry],
          installs: [],
          plan: { planTier: "starter", isOperator: false },
        });
        expect(result[0]!.state).toBe("accessible");
      });
    }

    it("exercises every Pillar literal at least once (forces fixture to widen if PILLARS grows)", () => {
      const seenPillars = new Set(pillarCases.map((c) => c.pillar));
      for (const p of PILLARS) {
        expect(seenPillars.has(p), `no fixture row for pillar=${p}`).toBe(true);
      }
    });

    it("exercises every ImplementationStatus literal at least once", () => {
      const result = projectCatalogWithInstalls({
        catalog: IMPLEMENTATION_STATUSES.map((status, idx) =>
          makeEntry({
            id: `catalog:status-${idx}`,
            slug: `slug-${idx}`,
            implementationStatus: status,
          }),
        ),
        installs: [],
        plan: { planTier: "starter", isOperator: false },
      });
      const seen = new Set(result.map((r) => r.implementationStatus));
      for (const s of IMPLEMENTATION_STATUSES) {
        expect(seen.has(s), `no fixture row for implementationStatus=${s}`).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. createPillarCatalogQueryTestLayer
// ---------------------------------------------------------------------------

describe("createPillarCatalogQueryTestLayer", () => {
  it("partial overrides take precedence over the throwing default", async () => {
    const layer = createPillarCatalogQueryTestLayer({
      getBySlug: () => Effect.succeed(makeEntry({ slug: "telegram" })),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("telegram");
      }).pipe(Effect.provide(layer)),
    );
    expect(result?.slug).toBe("telegram");
  });

  it("unprovided methods fail loudly with a descriptive Effect error", async () => {
    const layer = createPillarCatalogQueryTestLayer({});
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.withInstallStatusFor("org-1");
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
    // We don't pin the exact message; just that it failed in the typed channel.
  });
});

// ---------------------------------------------------------------------------
// 3. PillarCatalogQueryLive — end-to-end with stub InternalDB
// ---------------------------------------------------------------------------

interface FakeDBRecord {
  matcher: (sql: string) => boolean;
  rows: Record<string, unknown>[];
}

function makeFakeInternalDBLayer(records: FakeDBRecord[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const shape: InternalDBShape = {
    sql: null,
    pool: null,
    available: true,
    execute: () => {},
    query: async <T extends Record<string, unknown>>(
      sqlStr: string,
      params: unknown[] = [],
    ) => {
      calls.push({ sql: sqlStr, params });
      for (const record of records) {
        if (record.matcher(sqlStr)) return record.rows as T[];
      }
      return [] as T[];
    },
  };
  return { layer: Layer.succeed(InternalDB, shape), calls };
}

const SLACK_ROW = {
  id: "catalog:slack",
  slug: "slack",
  name: "Slack",
  description: "Connect Slack",
  type: "chat",
  install_model: "oauth",
  icon_url: null,
  config_schema: null,
  min_plan: "starter",
  saas_eligible: true,
  pillar: "chat",
  implementation_status: "available",
  auto_install: false,
};

const SALESFORCE_ROW = {
  id: "catalog:salesforce",
  slug: "salesforce",
  name: "Salesforce",
  description: "Salesforce datasource",
  type: "integration",
  install_model: "oauth",
  icon_url: null,
  config_schema: null,
  min_plan: "business",
  saas_eligible: true,
  pillar: "action",
  implementation_status: "available",
  auto_install: false,
};

describe("PillarCatalogQueryLive", () => {
  it("withInstallStatusFor: joins plan + catalog + installs and applies the state machine", async () => {
    const { layer: dbLayer, calls } = makeFakeInternalDBLayer([
      {
        matcher: (sql) => sql.includes("FROM organization"),
        rows: [{ plan_tier: "starter", is_operator_workspace: false }],
      },
      {
        matcher: (sql) => sql.includes("FROM plugin_catalog"),
        rows: [SLACK_ROW, SALESFORCE_ROW],
      },
      {
        matcher: (sql) => sql.includes("FROM workspace_plugins"),
        rows: [
          {
            id: "install-1",
            catalog_id: "catalog:slack",
            install_id: "catalog:slack",
            workspace_id: "org-1",
            pillar: "chat",
            installed_at: "2026-05-20T10:00:00.000Z",
            installed_by: "user-1",
            install_status: null,
            enabled: true,
          },
        ],
      },
    ]);

    const program = Effect.gen(function* () {
      const facade = yield* PillarCatalogQuery;
      return yield* facade.withInstallStatusFor("org-1");
    });

    const result = (await Effect.runPromise(
      program.pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    )) as readonly CatalogEntryWithState[];

    expect(result).toHaveLength(2);
    const slack = result.find((e) => e.slug === "slack")!;
    const sf = result.find((e) => e.slug === "salesforce")!;

    // Slack: install present, plan admits — connected.
    expect(slack.state).toBe("connected");
    expect(slack.install).not.toBeNull();
    expect(slack.install!.installId).toBe("catalog:slack");
    expect(slack.pillar).toBe("chat");
    expect(slack.implementationStatus).toBe("available");
    expect(slack.planAccessible).toBe(true);

    // Salesforce: no install, plan denies (starter vs business) — upgrade_required.
    expect(sf.state).toBe("upgrade_required");
    expect(sf.install).toBeNull();
    expect(sf.pillar).toBe("action");
    expect(sf.planAccessible).toBe(false);

    // Workspace lookup was scoped by workspace_id — regression guard against
    // cross-tenant install leakage.
    const wpCall = calls.find((c) => c.sql.includes("FROM workspace_plugins"))!;
    expect(wpCall.sql).toContain("workspace_id = $1");
    expect(wpCall.params[0]).toBe("org-1");
  });

  it("getByPillar: SQL fragment carries the pillar predicate", async () => {
    const { layer: dbLayer, calls } = makeFakeInternalDBLayer([
      { matcher: (sql) => sql.includes("FROM plugin_catalog"), rows: [SLACK_ROW] },
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getByPillar("chat");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.pillar).toBe("chat");
    expect(calls[0]!.sql).toContain("pillar = $1");
    expect(calls[0]!.params[0]).toBe("chat");
  });

  it("getBySlug: returns null for an unknown slug", async () => {
    const { layer: dbLayer } = makeFakeInternalDBLayer([
      { matcher: (sql) => sql.includes("FROM plugin_catalog"), rows: [] },
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("nonexistent");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(result).toBeNull();
  });

  it("getBySlug: returns the row when found", async () => {
    const { layer: dbLayer } = makeFakeInternalDBLayer([
      { matcher: (sql) => sql.includes("FROM plugin_catalog"), rows: [SLACK_ROW] },
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("slack");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(result?.slug).toBe("slack");
    expect(result?.pillar).toBe("chat");
    expect(result?.implementationStatus).toBe("available");
  });

  // ── Regression guards (post-review) ──────────────────────────────────
  //
  // The generic readers (`getByPillar`, `getBySlug`) are advertised in
  // the Shape as pillar-agnostic. They must NOT carry the customer-
  // facing legacy-type filter that `withInstallStatusFor` applies —
  // doing so silently returns the empty set for a datasource-pillar
  // caller (slice 5 / #2746).
  it("getByPillar: does not narrow by legacy type (allows datasource rows)", async () => {
    const { layer: dbLayer, calls } = makeFakeInternalDBLayer([
      { matcher: (sql) => sql.includes("FROM plugin_catalog"), rows: [] },
    ]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getByPillar("datasource");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    const sql = calls[0]!.sql;
    expect(sql).not.toContain("type IN");
  });

  it("getBySlug: does not narrow by legacy type", async () => {
    const { layer: dbLayer, calls } = makeFakeInternalDBLayer([
      { matcher: (sql) => sql.includes("FROM plugin_catalog"), rows: [] },
    ]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("postgres");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(calls[0]!.sql).not.toContain("type IN");
  });

  it("withInstallStatusFor: still narrows by legacy type for byte-identical wire output", async () => {
    const { layer: dbLayer, calls } = makeFakeInternalDBLayer([
      {
        matcher: (sql) => sql.includes("FROM organization"),
        rows: [{ plan_tier: "starter", is_operator_workspace: false }],
      },
      {
        matcher: (sql) => sql.includes("FROM plugin_catalog"),
        rows: [SLACK_ROW],
      },
      { matcher: (sql) => sql.includes("FROM workspace_plugins"), rows: [] },
    ]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.withInstallStatusFor("org-1");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    const catalogCall = calls.find((c) =>
      c.sql.includes("FROM plugin_catalog"),
    )!;
    expect(catalogCall.sql).toContain("type IN ('chat', 'integration')");
  });
});

// ---------------------------------------------------------------------------
// 4. Row-mapper fallback semantics — fail-closed defaults
// ---------------------------------------------------------------------------

describe("row mapper fallback semantics", () => {
  // `asImplementationStatus` MUST default unknown values to `coming_soon`
  // (fail closed). Defaulting to `available` would make a corrupt-seed /
  // catalog-drift row surface as installable in the admin UI.
  it("unknown implementation_status maps to coming_soon (fail closed)", async () => {
    const { layer: dbLayer } = makeFakeInternalDBLayer([
      {
        matcher: (sql) => sql.includes("FROM plugin_catalog"),
        rows: [{ ...SLACK_ROW, implementation_status: "totally-bogus-value" }],
      },
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("slack");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(result?.implementationStatus).toBe("coming_soon");
  });

  it("unknown pillar maps to 'action' (miscellaneous bucket per ADR-0006)", async () => {
    const { layer: dbLayer } = makeFakeInternalDBLayer([
      {
        matcher: (sql) => sql.includes("FROM plugin_catalog"),
        rows: [{ ...SLACK_ROW, pillar: "weird-new-pillar" }],
      },
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.getBySlug("slack");
      }).pipe(Effect.provide(PillarCatalogQueryLive.pipe(Layer.provide(dbLayer)))),
    );
    expect(result?.pillar).toBe("action");
  });
});
