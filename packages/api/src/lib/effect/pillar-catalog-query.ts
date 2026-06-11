/**
 * `PillarCatalogQuery` — read-side facade over `plugin_catalog`
 * (joined with `workspace_plugins`) that applies the per-row install-state
 * machine (`resolveInstallStatus`) to compute a `CardState` per catalog
 * row. Slice 3 of 1.5.3 (#2741) under [ADR-0006].
 *
 * The facade collapses the three SELECTs that `/api/v1/integrations/catalog`
 * inlined pre-slice-3 (plan + catalog + installs) into a single Effect
 * Context Tag with a stable shape. Subsequent slices (#2742 → workspace
 * installer, #2746 → datasource catalog rows on /admin/connections,
 * #2748 → admin-UI section split) all read through this facade so the
 * card-state semantics stay in lockstep with the state machine.
 *
 * Live impl uses `InternalDB` from Effect Context. Test impl uses
 * `createPillarCatalogQueryTestLayer` to stub the three methods with
 * static fixtures.
 *
 * Wire-shape note (#2741 acceptance criteria): `withInstallStatusFor`
 * returns ALL the data a card-renderer needs (state + install + the
 * catalog row). The route is responsible for projecting that down to
 * the on-wire JSON envelope (`accessible`, `upsellOnly`, `installed`,
 * `installStatus`, the two new `pillar` + `implementationStatus`
 * fields). The legacy `type: 'chat' | 'integration'` wire field is
 * preserved for back-compat — slice 8 splits the UI by `pillar`.
 *
 * Misconfigured / handler-registered semantics: this slice does NOT
 * yet thread `handlerRegistered` / `deployConfigured` through the state
 * machine — both default to `true` so the machine's output matches
 * existing UI behavior (no card flips to `misconfigured` mid-flight).
 * The state-machine's `TODO(#2741)` block calls out the remediation:
 * a future slice (or this one if reviewers want it now) can wire in
 * `hasInstallHandler` from `lib/integrations/install/dispatch.ts` and
 * a per-Platform env probe. Leaving them at `true` preserves the
 * "no-UX-change" guarantee in this slice.
 */

import { Context, Effect, Layer } from "effect";
import {
  IMPLEMENTATION_STATUSES,
  PILLARS,
  type ImplementationStatus,
  type PlanTier,
  type Pillar,
} from "@useatlas/types";
import {
  resolveInstallStatus,
  type CardState,
} from "@atlas/api/lib/integrations/install-status-machine";
import {
  isPlanEligible,
  parsePlanTier,
} from "@atlas/api/lib/integrations/install/plan-rank";
// Type-only — the Tag value is lazy-required inside `PillarCatalogQueryLive`
// so partial `mock.module("@atlas/api/lib/db/internal", { hasInternalDB, … })`
// stubs in unrelated tests don't surface a Bun static-link SyntaxError when
// they pull this module transitively (via `services.ts` re-exports).
type InternalDBTag = typeof import("@atlas/api/lib/db/internal").InternalDB;
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("pillar-catalog-query");

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Catalog row as the facade reads it from `plugin_catalog`. Field set is
 * the union of what the existing route exposed (slug, name, etc.) PLUS
 * the two new pillar columns from migration 0092 (#2739). Camel-cased
 * for JS ergonomics — DB snake_case stays inside the SQL layer.
 *
 * `configSchema` is `unknown` because it's a JSONB blob whose shape is
 * specified per-handler and validated at install time, not here.
 */
export interface CatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  /** Legacy admin-UI grouping — slice 8 pivots the UI to `pillar`. */
  readonly type: string;
  readonly installModel: string;
  readonly iconUrl: string | null;
  readonly configSchema: unknown;
  readonly minPlan: string;
  readonly saasEligible: boolean;
  readonly pillar: Pillar;
  readonly implementationStatus: ImplementationStatus;
  readonly autoInstall: boolean;
}

/**
 * Workspace install row as the facade exposes it. The denormalized
 * `pillar` column is included so multi-pillar callers (e.g. a future
 * Datasource-pillar lister) can branch without a re-join.
 */
export interface WorkspaceInstall {
  readonly id: string;
  readonly catalogId: string;
  readonly installId: string;
  readonly workspaceId: string;
  readonly pillar: Pillar;
  readonly installedAt: string;
  readonly installedBy: string | null;
  /** Pulled from `workspace_plugins.config->>'status'`. `"reconnect_needed"` per #2658. */
  readonly status: string | null;
  /** True when the install row's `enabled` column is false (disabled but not torn down). */
  readonly disabled: boolean;
  /**
   * Raw `workspace_plugins.config` JSONB. Carries operator-visible
   * install metadata (Salesforce `instance_url` / `org_id`, Jira
   * `cloud_id`, etc.). Secret-marked fields are NOT scrubbed here — the
   * route layer applies {@link maskSecretFields} against the catalog
   * row's `configSchema` before projecting to the wire.
   */
  readonly config: Record<string, unknown>;
}

/**
 * Catalog row + computed card state + (optional) install record. This is
 * the rich row the facade emits from `withInstallStatusFor`; the route
 * projects it down to the wire envelope.
 */
export interface CatalogEntryWithState extends CatalogEntry {
  readonly state: CardState;
  readonly install: WorkspaceInstall | null;
  /** Whether the row is plan-accessible for the queried workspace (operator bypass applied). */
  readonly planAccessible: boolean;
}

/** Per-workspace plan context the facade needs to evaluate plan gating. */
export interface WorkspacePlanContext {
  /** Narrowed via {@link parsePlanTier} at the SQL boundary — `null` for legacy `team` / NULL plan_tier values. */
  readonly planTier: PlanTier | null;
  readonly isOperator: boolean;
}

export interface PillarCatalogQueryShape {
  /** Read enabled catalog rows for a given pillar. Deploy-mode (saas/self-hosted) filter applied. */
  readonly getByPillar: (
    pillar: Pillar,
  ) => Effect.Effect<readonly CatalogEntry[], Error>;
  /**
   * Read a single catalog row by slug. Returns null when not found / not
   * enabled. Pillar-agnostic — works for `datasource`, `chat`, and
   * `action` rows alike.
   */
  readonly getBySlug: (
    slug: string,
  ) => Effect.Effect<CatalogEntry | null, Error>;
  /**
   * Join catalog × workspace_plugins for the given workspace, apply
   * the install-status machine, and return one annotated row per
   * catalog entry.
   *
   * Default (no `pillar`): excludes legacy types (`datasource`,
   * `context`, `interaction`, `action`, `sandbox`) — only `chat` +
   * `integration` are surfaced, byte-identical to the pre-#3377 wire
   * output.
   *
   * With `pillar`: restricts to that pillar instead of the legacy-type
   * filter, so a `datasource` caller (the `/admin/connections` Add
   * picker, #3377) gets catalog rows + install status for plugin
   * datasources. The deploy-mode gate (`saas_eligible = true` on SaaS)
   * applies in both branches via `buildCatalogWhere`.
   */
  readonly withInstallStatusFor: (
    workspaceId: string,
    pillar?: Pillar,
  ) => Effect.Effect<readonly CatalogEntryWithState[], Error>;
}

export class PillarCatalogQuery extends Context.Tag("PillarCatalogQuery")<
  PillarCatalogQuery,
  PillarCatalogQueryShape
>() {}

// ---------------------------------------------------------------------------
// Pillar validation
// ---------------------------------------------------------------------------

function asPillar(value: unknown): Pillar {
  if (typeof value === "string" && (PILLARS as readonly string[]).includes(value)) {
    return value as Pillar;
  }
  // Catalog drift — log loudly. The DB CHECK constraint should prevent
  // this, but a corrupt row shouldn't crash the facade — fall back to
  // `action` (the "miscellaneous" bucket per ADR-0006).
  log.warn({ value }, "Unknown pillar value in plugin_catalog; defaulting to 'action'");
  return "action";
}

function asImplementationStatus(value: unknown): ImplementationStatus {
  if (
    typeof value === "string" &&
    (IMPLEMENTATION_STATUSES as readonly string[]).includes(value)
  ) {
    return value as ImplementationStatus;
  }
  // Fail closed — an unknown status from catalog drift / corrupt seed
  // must NOT render as an installable card. `coming_soon` keeps the
  // row inert until an operator fixes the data; defaulting to
  // `available` would surface an unshipped integration as installable.
  log.warn({ value }, "Unknown implementation_status in plugin_catalog; defaulting to 'coming_soon'");
  return "coming_soon";
}

// ---------------------------------------------------------------------------
// Row types (DB-shape, snake_case)
// ---------------------------------------------------------------------------

interface CatalogRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  install_model: string;
  icon_url: string | null;
  config_schema: unknown;
  min_plan: string;
  saas_eligible: boolean;
  pillar: string;
  implementation_status: string;
  auto_install: boolean;
}

interface InstallRow extends Record<string, unknown> {
  id: string;
  catalog_id: string;
  install_id: string;
  workspace_id: string;
  pillar: string;
  installed_at: string | Date;
  installed_by: string | null;
  install_status: string | null;
  enabled: boolean;
  config: unknown;
}

interface OrgRow extends Record<string, unknown> {
  plan_tier: string | null;
  is_operator_workspace: boolean | null;
}

function rowToCatalogEntry(row: CatalogRow): CatalogEntry {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    installModel: row.install_model,
    iconUrl: row.icon_url,
    configSchema: row.config_schema ?? null,
    minPlan: row.min_plan,
    saasEligible: row.saas_eligible,
    pillar: asPillar(row.pillar),
    implementationStatus: asImplementationStatus(row.implementation_status),
    autoInstall: row.auto_install === true,
  };
}

function rowToWorkspaceInstall(row: InstallRow): WorkspaceInstall {
  const installedAt = row.installed_at instanceof Date
    ? row.installed_at.toISOString()
    : String(row.installed_at);
  // Defensive narrowing: the column is JSONB so pg returns either a plain
  // object or `null`. Arrays / scalars would only land here on schema
  // drift — treat them as empty config so the route's `maskSecretFields`
  // pass doesn't spread a non-object across the wire envelope.
  const config =
    row.config && typeof row.config === "object" && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    catalogId: row.catalog_id,
    installId: row.install_id,
    workspaceId: row.workspace_id,
    pillar: asPillar(row.pillar),
    installedAt,
    installedBy: row.installed_by,
    status: row.install_status,
    disabled: row.enabled === false,
    config,
  };
}

// ---------------------------------------------------------------------------
// Plan accessibility
// ---------------------------------------------------------------------------

function isAccessible(
  workspacePlan: PlanTier | null,
  requiredPlan: string,
  isOperator: boolean,
  context: { slug: string; id: string },
): boolean {
  if (isOperator) return true;
  // `requiredPlan` arrives as a raw catalog string — narrow here so an
  // unknown / drifted value (`"team"`, `""`) fails closed once instead
  // of every consumer redoing the membership check.
  const requiredTier = parsePlanTier(requiredPlan);
  if (requiredTier === null) {
    log.warn(
      { requiredPlan, slug: context.slug, id: context.id },
      "plugin_catalog.min_plan has unknown value — flagging entry as upsellOnly",
    );
    return false;
  }
  return isPlanEligible(workspacePlan, requiredTier);
}

// ---------------------------------------------------------------------------
// Pure computation — exported for testing
// ---------------------------------------------------------------------------

/**
 * Pure projection: catalog rows + workspace context + install rows →
 * annotated `CatalogEntryWithState[]`. Extracted from `withInstallStatusFor`
 * so tests can exercise the state-machine wiring without standing up an
 * `InternalDB` Layer. Mirrors the route's pre-slice-3 inline logic.
 *
 * The state-machine gates `handlerRegistered` and `deployConfigured`
 * are pinned to `true` in this slice — see the module header for the
 * "no-UX-change" rationale.
 */
export function projectCatalogWithInstalls(input: {
  readonly catalog: readonly CatalogEntry[];
  readonly installs: readonly WorkspaceInstall[];
  readonly plan: WorkspacePlanContext;
}): readonly CatalogEntryWithState[] {
  const installByCatalogId = new Map<string, WorkspaceInstall>();
  for (const install of input.installs) {
    // The chat+action pillars are singleton per (workspace, catalog) at
    // the DB layer (`workspace_plugins_singleton` partial unique). For
    // datasource (multi-instance) rows the Map collapses to the most-
    // recently iterated install — slice 5 (#2746) will switch the
    // datasource branch to grouping by catalogId before this becomes
    // a real concern.
    installByCatalogId.set(install.catalogId, install);
  }

  return input.catalog.map((entry) => {
    const install = installByCatalogId.get(entry.id) ?? null;
    const planAccessible = isAccessible(
      input.plan.planTier,
      entry.minPlan,
      input.plan.isOperator,
      { slug: entry.slug, id: entry.id },
    );
    const state = resolveInstallStatus({
      catalogRow: { implementationStatus: entry.implementationStatus },
      workspaceInstall: install ? { installId: install.installId } : null,
      planAdmits: planAccessible,
      // See module header — pinned `true` in this slice.
      handlerRegistered: true,
      deployConfigured: true,
    });
    return {
      ...entry,
      install,
      state,
      planAccessible,
    };
  });
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

const CATALOG_COLUMNS = `
  id, slug, name, description, type, install_model, icon_url,
  config_schema, min_plan, saas_eligible, pillar, implementation_status,
  auto_install
`.trim();

/**
 * Build the `WHERE` clause for catalog reads. Always applies the
 * `enabled = true` + deploy-mode (`saas_eligible = true` on SaaS) gates.
 * The legacy-type narrowing (`type IN ('chat', 'integration')`) is
 * caller-controlled via `restrictToLegacyTypes` — `withInstallStatusFor`
 * keeps the pre-slice-3 byte-identical wire output by passing `true`,
 * while generic readers (`getByPillar`, `getBySlug`) pass `false` so a
 * `datasource`-pillar caller in slice 5 (#2746) doesn't get an empty
 * result set from the customer-facing-only filter.
 */
function buildCatalogWhere(extra: string, restrictToLegacyTypes: boolean): string {
  const isSaas = getConfig()?.deployMode === "saas";
  const clauses = [
    "enabled = true",
    ...(isSaas ? ["saas_eligible = true"] : []),
    ...(restrictToLegacyTypes ? ["type IN ('chat', 'integration')"] : []),
    extra,
  ].filter((c) => c.length > 0);
  return clauses.join(" AND ");
}

// ---------------------------------------------------------------------------
// Live Layer
// ---------------------------------------------------------------------------

/**
 * Live PillarCatalogQuery backed by `InternalDB`. `Layer.effect` (not
 * `Layer.scoped`) — the service has no finalizer; the pool is owned by
 * `internal.ts`.
 *
 * The `InternalDB` Tag is `require`'d lazily inside the factory to keep
 * this module's static import surface narrow — see the type-only
 * `InternalDBTag` alias at the top of the file for the rationale.
 */
export const PillarCatalogQueryLive: Layer.Layer<
  PillarCatalogQuery,
  never,
  import("@atlas/api/lib/db/internal").InternalDB
> = Layer.unwrapEffect(
  Effect.sync(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { InternalDB } = require("@atlas/api/lib/db/internal") as {
      InternalDB: InternalDBTag;
    };
    return Layer.effect(
      PillarCatalogQuery,
      buildPillarCatalogQueryService(InternalDB),
    );
  }),
);

function buildPillarCatalogQueryService(
  InternalDB: InternalDBTag,
): Effect.Effect<
  PillarCatalogQueryShape,
  never,
  import("@atlas/api/lib/db/internal").InternalDB
> {
  return Effect.gen(function* () {
    const db = yield* InternalDB;

    const getByPillar: PillarCatalogQueryShape["getByPillar"] = (pillar) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db.query<CatalogRow>(
            `SELECT ${CATALOG_COLUMNS}
               FROM plugin_catalog
              WHERE ${buildCatalogWhere("pillar = $1", false)}
              ORDER BY name ASC`,
            [pillar],
          );
          return rows.map(rowToCatalogEntry);
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

    const getBySlug: PillarCatalogQueryShape["getBySlug"] = (slug) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db.query<CatalogRow>(
            `SELECT ${CATALOG_COLUMNS}
               FROM plugin_catalog
              WHERE ${buildCatalogWhere("slug = $1", false)}
              LIMIT 1`,
            [slug],
          );
          return rows.length === 0 ? null : rowToCatalogEntry(rows[0]!);
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

    const withInstallStatusFor: PillarCatalogQueryShape["withInstallStatusFor"] =
      (workspaceId, pillar) =>
        Effect.tryPromise({
          try: async () => {
            // Pillar-scoped callers (#3377) swap the legacy-type filter
            // for a pillar predicate; the default branch stays
            // byte-identical to the pre-#3377 catalog read.
            const catalogQuery =
              pillar === undefined
                ? db.query<CatalogRow>(
                    `SELECT ${CATALOG_COLUMNS}
                   FROM plugin_catalog
                  WHERE ${buildCatalogWhere("", true)}
                  ORDER BY type ASC, name ASC`,
                  )
                : db.query<CatalogRow>(
                    `SELECT ${CATALOG_COLUMNS}
                   FROM plugin_catalog
                  WHERE ${buildCatalogWhere("pillar = $1", false)}
                  ORDER BY type ASC, name ASC`,
                    [pillar],
                  );
            // Three independent reads — `Promise.all` lets them ride the
            // same connection-acquire latency. Matches the pre-slice-3
            // route's parallel-fetch behavior.
            const [planRows, catalogRows, installRows] = await Promise.all([
              db.query<OrgRow>(
                "SELECT plan_tier, is_operator_workspace FROM organization WHERE id = $1",
                [workspaceId],
              ),
              catalogQuery,
              db.query<InstallRow>(
                `SELECT id, catalog_id, install_id, workspace_id, pillar,
                        installed_at, installed_by, enabled, config,
                        config->>'status' AS install_status
                   FROM workspace_plugins
                  WHERE workspace_id = $1`,
                [workspaceId],
              ),
            ]);
            // Narrow at the SQL boundary: `plan_tier` is a raw string
            // off the DB. parsePlanTier maps unknown / legacy values to
            // `null` so downstream callers can rely on `PlanTier | null`.
            const planTier = parsePlanTier(planRows[0]?.plan_tier);
            // Surface the rare "row exists but plan_tier is unparseable"
            // case at debug so the "why is this workspace upsell-only?"
            // ticket investigation has a hit. The row-missing case
            // (no org / self-hosted) intentionally stays quiet — it's
            // the default for self-hosted dev.
            if (
              planRows[0] !== undefined &&
              planRows[0].plan_tier !== null &&
              planTier === null
            ) {
              log.debug(
                { workspaceId, rawPlanTier: planRows[0].plan_tier },
                "organization.plan_tier is not a recognized plan tier — treating as rank 0",
              );
            }
            const isOperator = planRows[0]?.is_operator_workspace === true;
            return projectCatalogWithInstalls({
              catalog: catalogRows.map(rowToCatalogEntry),
              installs: installRows.map(rowToWorkspaceInstall),
              plan: { planTier, isOperator },
            });
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        });

    return {
      getByPillar,
      getBySlug,
      withInstallStatusFor,
    } satisfies PillarCatalogQueryShape;
  });
}

// ---------------------------------------------------------------------------
// Test layer factory
// ---------------------------------------------------------------------------

/**
 * Test layer factory. Methods not provided throw a descriptive error
 * — see `createAnswerMeterTestLayer` for the same pattern. Prefer this
 * over `mock.module()` for Effect-based tests.
 *
 * @example
 * ```ts
 * const layer = createPillarCatalogQueryTestLayer({
 *   withInstallStatusFor: () =>
 *     Effect.succeed([{ ...slackRow, state: "accessible", install: null }]),
 * });
 * ```
 */
export function createPillarCatalogQueryTestLayer(
  partial: Partial<PillarCatalogQueryShape> = {},
): Layer.Layer<PillarCatalogQuery> {
  const stub: PillarCatalogQueryShape = {
    getByPillar:
      partial.getByPillar ??
      (() =>
        Effect.fail(
          new Error(
            "PillarCatalogQuery test stub: getByPillar() called but not provided",
          ),
        )),
    getBySlug:
      partial.getBySlug ??
      (() =>
        Effect.fail(
          new Error(
            "PillarCatalogQuery test stub: getBySlug() called but not provided",
          ),
        )),
    withInstallStatusFor:
      partial.withInstallStatusFor ??
      (() =>
        Effect.fail(
          new Error(
            "PillarCatalogQuery test stub: withInstallStatusFor() called but not provided",
          ),
        )),
  };
  return Layer.succeed(PillarCatalogQuery, stub);
}
