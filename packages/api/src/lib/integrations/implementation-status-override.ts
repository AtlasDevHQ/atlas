/**
 * `applyImplementationStatusOverride` — boot-time consumer of
 * `atlas.config.ts:overrideImplementationStatus` per 1.5.3 slice 9
 * (#2747 / ADR-0007).
 *
 * The override exists so a self-host operator who's shipped their own
 * install handler for a row Atlas marks `coming_soon` can flip it to
 * `available` without forking the catalog (and vice versa, marking a
 * row `coming_soon` that Atlas ships `available` — e.g. an internal
 * compliance hold on Slack).
 *
 * Runs AFTER both catalog seeds complete so the override is the final
 * word: any UPDATE issued here cannot be clobbered by the catalog
 * seeder's `EXCLUDED.implementation_status` upsert on the same boot.
 * The {@link CatalogImplementationStatusOverride} Layer encodes this
 * ordering via Tag dependencies on `CatalogSeed` +
 * `BuiltinDatasourceCatalogSeed`.
 *
 * SaaS: the override field is unused — `deploy/api/atlas.config.ts`
 * declares every row's `implementation_status` directly, so the
 * boot-time UPDATE here finds an empty map and exits as a no-op.
 *
 * Slugs that don't match any catalog row are logged at warn — the
 * operator likely typo'd the slug; we don't want a silent miss to
 * present as "override didn't take effect".
 *
 * Pure function + thin DB driver split mirrors `catalog-seeder.ts`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { type ImplementationStatus } from "@useatlas/types";
import { assertOperatorCatalogWrite } from "@atlas/api/lib/plugins/catalog-provenance";

const log = createLogger("integrations.implementation-status-override");

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/**
 * One operator-declared override that survived planning. Catalog row
 * exists, current status differs from the declared override, UPDATE
 * should fire.
 */
export interface ImplementationStatusOverrideAction {
  readonly slug: string;
  readonly from: ImplementationStatus;
  readonly to: ImplementationStatus;
}

export interface ImplementationStatusOverridePlan {
  /** Slug → new status UPDATEs the driver should issue. */
  readonly actions: ReadonlyArray<ImplementationStatusOverrideAction>;
  /** Slugs in the override that don't match any catalog row. Logged at warn. */
  readonly unmatchedSlugs: ReadonlyArray<string>;
  /** Slugs already at the declared status. UPDATE skipped — kept for log/observability. */
  readonly noopSlugs: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

/** Narrow projection of `plugin_catalog` rows the planner reads. */
export interface CurrentCatalogRow {
  readonly slug: string;
  readonly implementationStatus: ImplementationStatus;
}

/**
 * Pure function: declared override map × current catalog state →
 * action plan. No I/O; same inputs always yield the same plan.
 *
 * The override-vs-current comparison is case-sensitive on slug to
 * match the DB's catalog `slug` unique index (lowercase
 * alphanumeric+dashes per `CatalogEntrySchema`). An operator who
 * typo'd casing surfaces in `unmatchedSlugs`.
 */
export function planImplementationStatusOverride(
  override: Record<string, ImplementationStatus>,
  existing: ReadonlyArray<CurrentCatalogRow>,
): ImplementationStatusOverridePlan {
  const existingBySlug = new Map<string, CurrentCatalogRow>();
  for (const row of existing) existingBySlug.set(row.slug, row);

  const actions: ImplementationStatusOverrideAction[] = [];
  const unmatchedSlugs: string[] = [];
  const noopSlugs: string[] = [];

  for (const [slug, to] of Object.entries(override)) {
    const row = existingBySlug.get(slug);
    if (!row) {
      unmatchedSlugs.push(slug);
      continue;
    }
    if (row.implementationStatus === to) {
      noopSlugs.push(slug);
      continue;
    }
    actions.push({ slug, from: row.implementationStatus, to });
  }

  return { actions, unmatchedSlugs, noopSlugs };
}

// ---------------------------------------------------------------------------
// DB driver
// ---------------------------------------------------------------------------

/** Narrow shape of the DB client the driver needs. Mirrors `CatalogSeedDb`. */
export interface ImplementationStatusOverrideDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ImplementationStatusOverrideResult {
  readonly updatedCount: number;
  readonly unmatchedSlugs: ReadonlyArray<string>;
  readonly noopSlugs: ReadonlyArray<string>;
}

const EMPTY_RESULT: ImplementationStatusOverrideResult = {
  updatedCount: 0,
  unmatchedSlugs: [],
  noopSlugs: [],
};

/**
 * Apply the operator override against `plugin_catalog`. Returns a
 * summary the boot pass can log.
 *
 * Atomic: the UPDATE loop runs inside a single `BEGIN`/`COMMIT` so a
 * mid-loop failure rolls back every prior UPDATE in the boot. Without
 * the wrap, a per-UPDATE crash would leave the catalog in a mixed
 * state — some slugs flipped, some not — which contradicts the
 * "override is the final word" contract. Per PR #2782 codex review.
 *
 * The override map is typically 0–3 entries, so the round-trip cost
 * (BEGIN + N UPDATEs + COMMIT vs. a single set-based UPDATE) is
 * negligible. Per-row UPDATE keeps the SQL readable and the warn-log
 * call site clean.
 */
export async function applyImplementationStatusOverride(
  db: ImplementationStatusOverrideDb,
  override: Record<string, ImplementationStatus>,
): Promise<ImplementationStatusOverrideResult> {
  if (Object.keys(override).length === 0) {
    log.info("Implementation-status override: empty map; skipping");
    return EMPTY_RESULT;
  }

  const { rows: existing } = await db.query<{
    slug: string;
    implementation_status: string;
  }>(`SELECT slug, implementation_status FROM plugin_catalog`);

  // Narrow at the SQL boundary — same fail-closed posture as
  // `PillarCatalogQuery`. A drifted value won't survive into the
  // planner; the row simply won't match the override slug.
  const narrowed: CurrentCatalogRow[] = [];
  for (const r of existing) {
    if (r.implementation_status === "available" || r.implementation_status === "coming_soon") {
      narrowed.push({
        slug: r.slug,
        implementationStatus: r.implementation_status,
      });
    }
  }

  const plan = planImplementationStatusOverride(override, narrowed);

  if (plan.actions.length > 0) {
    // Operator-curated-only gate (#4174/#4099): overrides come from the
    // operator's own atlas.config.ts declaration; one call covers the txn.
    assertOperatorCatalogWrite("implementation-status-override");
    await db.query("BEGIN");
    try {
      for (const action of plan.actions) {
        await db.query(
          `UPDATE plugin_catalog
              SET implementation_status = $1,
                  updated_at = NOW()
            WHERE slug = $2`,
          [action.to, action.slug],
        );
        log.info(
          { slug: action.slug, from: action.from, to: action.to },
          "Implementation-status override applied",
        );
      }
      await db.query("COMMIT");
    } catch (err) {
      // Best-effort rollback — if ROLLBACK itself fails (broken
      // socket / connection lost), the connection is already in a
      // bad state and Postgres will discard the txn on connection
      // close. Re-throw the original error so the boot wrapper's
      // try/catch can surface it as `outcome: "error"`.
      try {
        await db.query("ROLLBACK");
      } catch (rollbackErr) {
        log.warn(
          { rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) },
          "Implementation-status override ROLLBACK failed — connection will be discarded",
        );
      }
      throw err;
    }
  }

  for (const slug of plan.unmatchedSlugs) {
    log.warn(
      { slug, declaredOverride: override[slug] },
      "Implementation-status override declares slug not present in plugin_catalog — typo? Or did the seed fail?",
    );
  }

  return {
    updatedCount: plan.actions.length,
    unmatchedSlugs: plan.unmatchedSlugs,
    noopSlugs: plan.noopSlugs,
  };
}

// ---------------------------------------------------------------------------
// Boot wrapper
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome of {@link runImplementationStatusOverrideBoot}.
 * Mirrors the seed Layers' shapes so health-surface consumers can
 * treat the three signals (skipped, applied, error) uniformly.
 */
export type ImplementationStatusOverrideBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" | "no-config" | "empty-override" }
  | {
      readonly kind: "applied";
      readonly updatedCount: number;
      readonly unmatchedSlugs: ReadonlyArray<string>;
      readonly noopSlugs: ReadonlyArray<string>;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Boot-pass wrapper. Mirrors `runBuiltinDatasourceCatalogSeedBoot`'s
 * log-and-continue posture: a failure here leaves the catalog seeds'
 * output authoritative for the boot rather than crashing the API. The
 * UI degrades gracefully — a self-host operator who shipped a Discord
 * handler but whose override didn't apply sees the inert "Coming soon"
 * card; the API still boots.
 */
export async function runImplementationStatusOverrideBoot(): Promise<ImplementationStatusOverrideBootResult> {
  const { hasInternalDB, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  const { getConfig } = await import("@atlas/api/lib/config");

  if (!hasInternalDB()) {
    log.info("Implementation-status override: no internal DB configured, skipping");
    return { kind: "skipped", reason: "no-internal-db" };
  }
  const config = getConfig();
  if (!config) {
    log.info("Implementation-status override: no resolved config, skipping");
    return { kind: "skipped", reason: "no-config" };
  }
  const override = config.overrideImplementationStatus ?? {};
  if (Object.keys(override).length === 0) {
    return { kind: "skipped", reason: "empty-override" };
  }

  const pool = getInternalDB();
  const db: ImplementationStatusOverrideDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    const result = await applyImplementationStatusOverride(db, override);
    return {
      kind: "applied",
      updatedCount: result.updatedCount,
      unmatchedSlugs: result.unmatchedSlugs,
      noopSlugs: result.noopSlugs,
    };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized },
      "Implementation-status override failed — catalog rows from seeds remain authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
