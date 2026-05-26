/**
 * Catalog seeder — boot-time idempotent upsert from `atlas.config.ts:catalog`
 * into `plugin_catalog`. Implements ADR-0002 S3 (config-driven, idempotently
 * seeded into catalog) and slice 2 of #2649 (issue #2650).
 *
 * Two layers:
 *
 *   1. `planCatalogSeed()` — pure function. Takes the declared catalog
 *      entries from config plus the rows currently in DB; returns a typed
 *      plan describing the writes. No I/O, fully unit-testable.
 *
 *   2. `seedCatalog()` — thin driver. Reads `plugin_catalog`, calls
 *      `planCatalogSeed()`, then runs the upserts inside one transaction.
 *      Idempotent: re-running with the same `(config, DB state)` is a
 *      no-op beyond the `updated_at` bump on changed rows.
 *
 * Semantics (mirrors PRD "Catalog seed semantics"):
 *
 *   - **Inserts** when no row exists for a declared slug.
 *   - **Updates** the declared-but-mutable columns (`name`, `description`,
 *     `icon_url`, `type`, `install_model`, `min_plan`, `saas_eligible`) when
 *     they differ.
 *   - **Preserves `enabled = false`** when DB says false but config says
 *     true (ops emergency-disable wins). Logs `warn` so the drift is
 *     observable.
 *   - **Orphans** — rows whose slug isn't in the declaration — emit a
 *     `warn` log and are LEFT IN PLACE. The seed never deletes. This
 *     preserves ops's ability to hand-add catalog rows (community
 *     marketplace future) without the seed reaping them.
 *
 * Hooked into the boot pass via `CatalogSeedLive` in
 * `packages/api/src/lib/effect/layers.ts`. Failure is non-fatal: a seed
 * error logs and the API keeps booting — pre-existing catalog rows still
 * answer admin-UI reads, just possibly out of date with the config.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  type CatalogEntry,
  type CatalogEntryType,
  type CatalogInstallModel,
  CATALOG_INSTALL_MODELS,
  CATALOG_ENTRY_TYPES,
} from "@atlas/api/lib/config";
import {
  IMPLEMENTATION_STATUSES,
  type ImplementationStatus,
} from "@useatlas/types";

const log = createLogger("integrations.catalog-seeder");

// ---------------------------------------------------------------------------
// DB row shape — narrow to the fields the seeder reads / writes
// ---------------------------------------------------------------------------

/**
 * Subset of `plugin_catalog` columns the seeder reads / writes. The full
 * Drizzle row carries `id`, `npm_package`, `config_schema`,
 * `created_at`, `updated_at` — none of which the seeder needs to compare
 * against the config. Keeping the read narrow keeps the planner pure.
 *
 * `type` and `installModel` are typed as their narrow union — DB rows
 * with values outside the enum are dropped at read time (see
 * `readExistingCatalog`) so the planner never compares a config entry
 * against a stale row and emits a phantom update.
 */
export interface CatalogDbRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: CatalogEntryType;
  readonly iconUrl: string | null;
  readonly minPlan: string;
  readonly enabled: boolean;
  readonly installModel: CatalogInstallModel;
  readonly saasEligible: boolean;
  /**
   * Whether Atlas has shipped a working install handler. Mirrors the
   * `plugin_catalog.implementation_status` column (#2747). When a row
   * lands here as `coming_soon`, the admin UI renders it inert; the
   * operator override consumer (`applyImplementationStatusOverride`)
   * can flip it to `available` post-seed on self-host. Reads that
   * encounter an unknown value drop the row — same fail-safe as `type`.
   */
  readonly implementationStatus: ImplementationStatus;
  /**
   * Decoded `config_schema` JSONB. `null` when the column is JSON null —
   * which is the legitimate state for OAuth / static-bot entries that
   * don't carry a form-field declaration. Form-based entries (`form`)
   * MUST have a declared schema; the planner doesn't enforce that here,
   * but the install route rejects form-based catalog rows whose stored
   * schema is null.
   */
  readonly configSchema: unknown | null;
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/**
 * Per-row action the driver should take. `action: 'noop'` rows are
 * surfaced for observability (`info` log of `preservedCount` in the
 * summary) but require no SQL write.
 */
export type CatalogSeedAction =
  | { readonly action: "insert"; readonly entry: CatalogEntry }
  | {
      readonly action: "update";
      readonly entry: CatalogEntry;
      readonly existing: CatalogDbRow;
      /** Names of columns that differ from the existing row. */
      readonly diff: ReadonlyArray<keyof CatalogDbRow>;
    }
  | {
      readonly action: "preserve-disabled";
      readonly entry: CatalogEntry;
      readonly existing: CatalogDbRow;
    }
  | { readonly action: "noop"; readonly entry: CatalogEntry };

/**
 * Orphan = a DB row whose slug isn't in the config. Surfaced as a
 * separate field on the plan because they're never written — only
 * logged — and conflating them with no-op writes hurts observability.
 */
export interface CatalogSeedPlan {
  readonly actions: ReadonlyArray<CatalogSeedAction>;
  readonly orphanSlugs: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/**
 * Build a write plan from declared catalog entries + current DB rows.
 *
 * Pure: same `(declared, existing)` always yields the same plan. No I/O.
 * Validation of `declared` shape is delegated to Zod at config load time
 * — entries arriving here are already typed `CatalogEntry`.
 *
 * Throws on duplicate slugs in `declared` to fail loud at config load —
 * the Zod refine on `AtlasConfigSchema.catalog` should catch this first,
 * but defending in depth makes the planner safe to call in tests without
 * re-running Zod.
 */
export function planCatalogSeed(
  declared: ReadonlyArray<CatalogEntry>,
  existing: ReadonlyArray<CatalogDbRow>,
): CatalogSeedPlan {
  const declaredBySlug = new Map<string, CatalogEntry>();
  for (const entry of declared) {
    if (declaredBySlug.has(entry.slug)) {
      throw new Error(
        `Catalog seed: duplicate slug "${entry.slug}" in declared entries`,
      );
    }
    declaredBySlug.set(entry.slug, entry);
  }

  const existingBySlug = new Map<string, CatalogDbRow>();
  for (const row of existing) existingBySlug.set(row.slug, row);

  const actions: CatalogSeedAction[] = [];

  for (const entry of declared) {
    const row = existingBySlug.get(entry.slug);
    if (!row) {
      actions.push({ action: "insert", entry });
      continue;
    }

    // Ops-disabled preservation: DB false beats config true. The reverse
    // (DB true, config false) lands as a normal update — the operator is
    // explicitly turning a row off via config; honor that.
    if (!row.enabled && entry.enabled) {
      actions.push({ action: "preserve-disabled", entry, existing: row });
      continue;
    }

    const diff = diffEntry(entry, row);
    if (diff.length === 0) {
      actions.push({ action: "noop", entry });
    } else {
      actions.push({ action: "update", entry, existing: row, diff });
    }
  }

  const orphanSlugs: string[] = [];
  for (const slug of existingBySlug.keys()) {
    if (!declaredBySlug.has(slug)) orphanSlugs.push(slug);
  }

  return { actions, orphanSlugs };
}

/**
 * Names of `CatalogDbRow` columns that differ between the declared entry
 * and the existing row. Used by `planCatalogSeed` to decide
 * `update` vs `noop` and surfaced on the action for log debugging.
 *
 * `enabled` IS compared here — the `preserve-disabled` branch in
 * `planCatalogSeed` short-circuits before this is called for the only
 * case where the comparison would be wrong (DB false, config true).
 * For DB true → config false (operator explicitly turning a row off),
 * `enabled` correctly flips and the action lands as `update`.
 */
function diffEntry(
  entry: CatalogEntry,
  row: CatalogDbRow,
): ReadonlyArray<keyof CatalogDbRow> {
  const diff: Array<keyof CatalogDbRow> = [];
  const wantName = entry.name ?? slugToDefaultName(entry.slug);
  if (row.name !== wantName) diff.push("name");

  const wantDescription = entry.description ?? null;
  if (row.description !== wantDescription) diff.push("description");

  if (row.type !== entry.type) diff.push("type");

  const wantIconUrl = entry.iconUrl ?? null;
  if (row.iconUrl !== wantIconUrl) diff.push("iconUrl");

  if (row.minPlan !== entry.min_plan) diff.push("minPlan");
  if (row.enabled !== entry.enabled) diff.push("enabled");
  if (row.installModel !== entry.install_model) diff.push("installModel");
  if (row.saasEligible !== entry.saas_eligible) diff.push("saasEligible");
  // implementation_status (#2747): re-seed overwrites operator overrides
  // applied via `applyImplementationStatusOverride` (separate boot pass).
  // That's intentional — the catalog declaration is the source of
  // truth for the *shipped* state; the override post-applies on every
  // boot. If you reverse the order, an operator override and a config
  // edit can race; running override-after-seed makes the override win.
  if (row.implementationStatus !== entry.implementation_status) diff.push("implementationStatus");

  // Stable structural compare via canonical JSON. The DB stores
  // `config_schema` as JSONB and PostgreSQL normalizes object keys
  // (length-then-lex in the on-disk binary form), so a naive
  // `JSON.stringify` compare against an operator-authored entry will
  // diff every boot — the author's key order won't match the round-
  // tripped order. `canonicalConfigSchemaJson` sorts object keys
  // recursively so both sides serialize identically regardless of
  // input order.
  const wantConfigSchema = entry.configSchema ?? null;
  if (!sameConfigSchema(row.configSchema, wantConfigSchema)) diff.push("configSchema");

  return diff;
}

function sameConfigSchema(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return canonicalConfigSchemaJson(a) === canonicalConfigSchemaJson(b);
}

/**
 * Serialize `value` with sorted object keys recursively, so two
 * structurally-equal objects always produce identical strings. Arrays
 * preserve order (array order is semantically meaningful for a
 * field-list schema).
 *
 * Exported for tests so the seeder-test mock DB can emit values that
 * match what PG would return after a real round-trip.
 */
export function canonicalConfigSchemaJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Fallback display name when the operator omits one — slug with dashes
 * replaced by spaces and the first letter of each word capitalized.
 * Matches the convention `"linear-apikey" → "Linear Apikey"`. Operators
 * who care about copy override via `name:` in the declaration.
 */
function slugToDefaultName(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

// ---------------------------------------------------------------------------
// DB driver
// ---------------------------------------------------------------------------

/**
 * Narrow shape of the DB client the seeder needs. Lets the test layer
 * substitute a mock pool without dragging in the full `pg.Pool` type.
 * Mirrors `getInternalDB()` and `internalQuery()` from `db/internal.ts`.
 */
export interface CatalogSeedDb {
  /** Run a parameterized query and return rows. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface CatalogSeedResult {
  readonly insertedCount: number;
  readonly updatedCount: number;
  readonly preservedCount: number;
  /**
   * Total `CatalogSeedAction` count returned by the planner — i.e.
   * `plan.actions.length`. Equals `insertedCount + updatedCount +
   * preservedCount + noopCount`, where `noopCount` is the implicit
   * fourth bucket (rows that matched the declaration without any
   * write).
   */
  readonly applied: number;
  /** Slugs whose DB row was left untouched because ops had disabled it. */
  readonly preservedSlugs: ReadonlyArray<string>;
  /** Slugs in DB without a matching declaration. Logged at warn. */
  readonly orphanSlugs: ReadonlyArray<string>;
}

const EMPTY_RESULT: CatalogSeedResult = {
  insertedCount: 0,
  updatedCount: 0,
  preservedCount: 0,
  applied: 0,
  preservedSlugs: [],
  orphanSlugs: [],
};

/**
 * Read `plugin_catalog`, plan the writes, then execute. Returns a
 * summary the boot pass can log. The summary doubles as the test
 * assertion target for the idempotency suite.
 */
export async function seedCatalog(
  db: CatalogSeedDb,
  declared: ReadonlyArray<CatalogEntry>,
): Promise<CatalogSeedResult> {
  if (declared.length === 0) {
    // No declarations means a self-host operator (or a SaaS region) that
    // doesn't want any chat / integration plugins. Still surface orphan
    // rows for visibility — but skip the upsert loop entirely.
    const orphans = await readOrphanSlugs(db);
    if (orphans.length > 0) {
      log.warn(
        { orphanSlugs: orphans },
        "Catalog seed: no entries declared, but plugin_catalog has rows — left in place (manual ops cleanup)",
      );
    }
    log.info("Catalog seed: no declared entries; skipping upsert");
    return { ...EMPTY_RESULT, orphanSlugs: orphans };
  }

  const existing = await readExistingCatalog(db);
  const plan = planCatalogSeed(declared, existing);

  let insertedCount = 0;
  let updatedCount = 0;
  let preservedCount = 0;
  const preservedSlugs: string[] = [];

  for (const action of plan.actions) {
    switch (action.action) {
      case "insert": {
        await upsertEntry(db, action.entry);
        insertedCount++;
        break;
      }
      case "update": {
        await upsertEntry(db, action.entry);
        updatedCount++;
        log.debug(
          { slug: action.entry.slug, diff: action.diff },
          "Catalog seed: updated row",
        );
        break;
      }
      case "preserve-disabled": {
        // The DB-disabled state wins. We still upsert the declared
        // metadata (name/description/etc.) so admin UI doesn't show
        // stale copy — but we explicitly clamp `enabled = false`.
        await upsertEntry(db, { ...action.entry, enabled: false });
        preservedCount++;
        preservedSlugs.push(action.entry.slug);
        log.warn(
          {
            slug: action.entry.slug,
            configEnabled: action.entry.enabled,
            dbEnabled: action.existing.enabled,
          },
          "Catalog seed: ops-disabled row preserved — config wants enabled=true but DB has enabled=false",
        );
        break;
      }
      case "noop":
        break;
    }
  }

  for (const slug of plan.orphanSlugs) {
    log.warn(
      { slug, deployMode: process.env.ATLAS_DEPLOY_MODE ?? "unknown" },
      "Catalog seed: orphan plugin_catalog row — left in place (manual ops cleanup)",
    );
  }

  const result: CatalogSeedResult = {
    insertedCount,
    updatedCount,
    preservedCount,
    applied: plan.actions.length,
    preservedSlugs,
    orphanSlugs: plan.orphanSlugs,
  };

  log.info(
    {
      insertedCount,
      updatedCount,
      preservedCount,
      orphanCount: plan.orphanSlugs.length,
      noopCount: plan.actions.length - insertedCount - updatedCount - preservedCount,
    },
    "Catalog seed complete",
  );

  return result;
}

interface CatalogDbRowRaw {
  slug: string;
  name: string;
  description: string | null;
  type: string;
  icon_url: string | null;
  min_plan: string;
  enabled: boolean;
  install_model: string;
  saas_eligible: boolean;
  implementation_status: string;
  config_schema: unknown | null;
}

async function readExistingCatalog(db: CatalogSeedDb): Promise<CatalogDbRow[]> {
  const { rows } = await db.query<CatalogDbRowRaw>(
    `SELECT slug, name, description, type, icon_url, min_plan, enabled,
            install_model, saas_eligible, implementation_status, config_schema
       FROM plugin_catalog`,
  );
  // Validate enum membership at read time so the planner can trust the
  // narrow `CatalogDbRow` shape. The DB CHECK constraints make a stray
  // value structurally impossible, but a future migration could relax
  // them; dropping unknown rows with a warn is fail-safe.
  const valid: CatalogDbRow[] = [];
  for (const r of rows) {
    if (!CATALOG_ENTRY_TYPES.includes(r.type as CatalogEntryType)) {
      log.warn(
        { slug: r.slug, type: r.type },
        "Catalog seed: plugin_catalog row has unknown `type` — dropping from planner input",
      );
      continue;
    }
    if (!CATALOG_INSTALL_MODELS.includes(r.install_model as CatalogInstallModel)) {
      log.warn(
        { slug: r.slug, install_model: r.install_model },
        "Catalog seed: plugin_catalog row has unknown `install_model` — dropping from planner input",
      );
      continue;
    }
    if (
      !IMPLEMENTATION_STATUSES.includes(
        r.implementation_status as ImplementationStatus,
      )
    ) {
      log.warn(
        { slug: r.slug, implementation_status: r.implementation_status },
        "Catalog seed: plugin_catalog row has unknown `implementation_status` — dropping from planner input",
      );
      continue;
    }
    valid.push({
      slug: r.slug,
      name: r.name,
      description: r.description,
      type: r.type as CatalogEntryType,
      iconUrl: r.icon_url,
      minPlan: r.min_plan,
      enabled: r.enabled,
      installModel: r.install_model as CatalogInstallModel,
      saasEligible: r.saas_eligible,
      implementationStatus: r.implementation_status as ImplementationStatus,
      configSchema: r.config_schema ?? null,
    });
  }
  return valid;
}

async function readOrphanSlugs(db: CatalogSeedDb): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT slug FROM plugin_catalog`,
  );
  return rows.map((r) => r.slug);
}

/**
 * Single-row upsert keyed on slug. `id` is derived from slug to keep the
 * seed deterministic — `catalog:<slug>` is stable across boots so foreign
 * keys (`workspace_plugins.catalog_id`) survive re-seed.
 *
 * `updated_at = NOW()` runs on conflict so admin UIs can sort by recency.
 * The CHECK constraints on `type` and `install_model` are the safety net
 * against a regression that drops the Zod validation upstream.
 */
async function upsertEntry(db: CatalogSeedDb, entry: CatalogEntry): Promise<void> {
  const id = `catalog:${entry.slug}`;
  const name = entry.name ?? slugToDefaultName(entry.slug);
  const description = entry.description ?? null;
  const iconUrl = entry.iconUrl ?? null;

  // Defense-in-depth: re-assert enum membership before issuing SQL — if
  // a regression dropped the Zod validation, this catches it before
  // hitting the DB CHECK (clearer error).
  if (!CATALOG_INSTALL_MODELS.includes(entry.install_model)) {
    throw new Error(
      `Catalog seed: unknown install_model "${entry.install_model}" for slug "${entry.slug}"`,
    );
  }
  if (!CATALOG_ENTRY_TYPES.includes(entry.type)) {
    throw new Error(
      `Catalog seed: unknown type "${entry.type}" for slug "${entry.slug}"`,
    );
  }
  if (!IMPLEMENTATION_STATUSES.includes(entry.implementation_status)) {
    throw new Error(
      `Catalog seed: unknown implementation_status "${entry.implementation_status}" for slug "${entry.slug}"`,
    );
  }

  // `config_schema` is JSONB — serialize undefined → null so the column
  // lands as JSON null instead of bombing the cast. Form-based entries
  // declare a non-null schema; OAuth / static-bot entries leave it null.
  const configSchemaJson =
    entry.configSchema === undefined || entry.configSchema === null
      ? null
      : JSON.stringify(entry.configSchema);

  // Derived per the three-pillar taxonomy (ADR-0006 / migration 0092).
  // Migration 0097 (#2744 hotfix) dropped the BEFORE-INSERT trigger that
  // used to default this from `type`, so every writer must name pillar
  // explicitly. Datasource rows are seeded by
  // `seed-builtin-datasource-catalog.ts` (pillar='datasource'); this
  // seeder only handles 'chat' + 'integration' rows.
  const pillar = pillarFromType(entry.type);

  await db.query(
    `INSERT INTO plugin_catalog
       (id, name, slug, description, type, pillar, icon_url, min_plan, enabled,
        install_model, saas_eligible, implementation_status, config_schema,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW(), NOW())
     ON CONFLICT (slug) DO UPDATE
       SET name                  = EXCLUDED.name,
           description           = EXCLUDED.description,
           type                  = EXCLUDED.type,
           pillar                = EXCLUDED.pillar,
           icon_url              = EXCLUDED.icon_url,
           min_plan              = EXCLUDED.min_plan,
           enabled               = EXCLUDED.enabled,
           install_model         = EXCLUDED.install_model,
           saas_eligible         = EXCLUDED.saas_eligible,
           implementation_status = EXCLUDED.implementation_status,
           config_schema         = EXCLUDED.config_schema,
           updated_at            = NOW()`,
    [
      id,
      name,
      entry.slug,
      description,
      entry.type,
      pillar,
      iconUrl,
      entry.min_plan,
      entry.enabled,
      entry.install_model,
      entry.saas_eligible,
      entry.implementation_status,
      configSchemaJson,
    ],
  );
}

/**
 * Map `CatalogEntry.type` to `plugin_catalog.pillar`. Mirrors the
 * mapping enforced by the 0092 BEFORE-INSERT trigger (dropped by 0097):
 * chat→chat, integration→action. `'datasource'` is handled by a
 * separate seeder so it isn't represented here — the type union doesn't
 * admit it.
 */
function pillarFromType(type: CatalogEntryType): "chat" | "action" {
  return type === "chat" ? "chat" : "action";
}

/**
 * Boot-pass wrapper. **Only this function** swallows errors — callers
 * that need error propagation (tests, future Effect-based wiring) should
 * use {@link seedCatalog} directly, which lets SQL / upsert errors
 * bubble.
 *
 * Pulls the declared catalog from `getConfig()` and the DB from
 * `getInternalDB()`, then runs `seedCatalog` inside a try/catch that
 * logs at error and returns `EMPTY_RESULT`. The boot pass is best-
 * effort: a failed seed leaves whichever rows were in `plugin_catalog`
 * pre-boot authoritative for this process.
 *
 * Mirrors `backfillSaasTrial`'s "log-and-continue" posture. Failure
 * modes are observable via (a) the `err` log line, which carries the
 * original Error so Pino's `err` serializer captures the stack and
 * (b) `CatalogSeedShape.outcome === "error"` on the Effect Tag for
 * health-surface consumers.
 */
export async function runCatalogSeedBoot(): Promise<CatalogSeedResult> {
  // Lazy imports keep config.ts and db/internal.ts off the static dep
  // graph for environments that import this module purely for its
  // types (e.g. unit tests of the pure planner).
  const { getConfig } = await import("@atlas/api/lib/config");
  const { hasInternalDB, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );

  if (!hasInternalDB()) {
    log.info("Catalog seed: no internal DB configured, skipping");
    return EMPTY_RESULT;
  }
  const config = getConfig();
  if (!config) {
    log.info("Catalog seed: no resolved config, skipping");
    return EMPTY_RESULT;
  }

  const pool = getInternalDB();
  // pg.Pool's `.query` returns `{ rows, ... }` — narrow to our shape.
  const db: CatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    return await seedCatalog(db, config.catalog ?? []);
  } catch (err) {
    // Pass the original Error to Pino's `err` serializer so the stack
    // is preserved — `errorMessage(err)` would scrub it to a string.
    // The seed failure is observable upstream via CatalogSeedShape.error.
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Catalog seed failed — plugin_catalog rows from prior boot remain authoritative",
    );
    return EMPTY_RESULT;
  }
}
