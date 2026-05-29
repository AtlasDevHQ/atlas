/**
 * Boot-time idempotent seed for the built-in `openapi-generic` Datasource
 * catalog row (PRD #2868 slice 2, #2926). Mirrors
 * `db/seed-builtin-datasource-catalog.ts` but for the single REST datasource
 * row, kept SEPARATE on purpose:
 *
 *   - The SQL seed's `BUILTIN_DATASOURCE_CATALOG_SLUGS` allowlist drives the
 *     boot loader + registry bridge (slug → `db_type` → `ConnectionRegistry`
 *     pool). `openapi-generic` has no SQL pool — it resolves through the
 *     parallel `OpenApiDatasourceRegistry` (PRD §"Option B"). Adding it to that
 *     allowlist would force `catalogSlugToDbType` to invent a fake db_type and
 *     pull the boot loader into a code path that doesn't apply.
 *   - Keeping it out means the SQL boot loader's `pc.slug = ANY(...)` filter
 *     skips `openapi-generic` installs for free — the fork stays clean.
 *
 * Re-asserts the same row migration 0108 inserts on fresh DBs, with a bare
 * `ON CONFLICT DO NOTHING` (covers both the `slug` unique index and the `id`
 * primary key) so a re-boot on a populated catalog is a no-op (and an
 * operator's out-of-band edits to `name`/`description` survive).
 * The migration and this seed share {@link OPENAPI_GENERIC_CATALOG_ID} /
 * {@link OPENAPI_GENERIC_CONFIG_SCHEMA} as the single source of truth.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_SLUG,
  OPENAPI_GENERIC_NAME,
  OPENAPI_GENERIC_DESCRIPTION,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
} from "./catalog";

const log = createLogger("openapi.catalog-seed");

/** Narrow shape of the DB client the seeder needs — mirrors `CatalogSeedDb`. */
export interface OpenApiDatasourceCatalogSeedDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface OpenApiDatasourceCatalogSeedResult {
  /** `true` when the `ON CONFLICT DO NOTHING` actually inserted the row. */
  readonly inserted: boolean;
}

/**
 * Idempotently seed the `openapi-generic` catalog row. Column order mirrors
 * migration 0108's VALUES block; the `'datasource'` type+pillar, `'available'`
 * status, `'starter'` min_plan, and `true` enabled/saas_eligible match the
 * built-in SQL datasource rows so the admin catalog surfaces it identically.
 */
export async function seedOpenApiDatasourceCatalog(
  db: OpenApiDatasourceCatalogSeedDb,
): Promise<OpenApiDatasourceCatalogSeedResult> {
  const { rows } = await db.query<{ slug: string }>(
    `INSERT INTO plugin_catalog
       (id, name, slug, description, type, install_model, pillar,
        implementation_status, auto_install, min_plan, enabled, saas_eligible,
        config_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'datasource', 'form', 'datasource', 'available',
             false, 'starter', true, true, $5::jsonb, NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING slug`,
    [
      OPENAPI_GENERIC_CATALOG_ID,
      OPENAPI_GENERIC_NAME,
      OPENAPI_GENERIC_SLUG,
      OPENAPI_GENERIC_DESCRIPTION,
      JSON.stringify(OPENAPI_GENERIC_CONFIG_SCHEMA),
    ],
  );

  const inserted = rows.length > 0;
  log.info({ inserted, slug: OPENAPI_GENERIC_SLUG }, "openapi-generic catalog seed complete");
  return { inserted };
}

/**
 * Discriminated outcome of {@link runOpenApiDatasourceCatalogSeedBoot}. Mirrors
 * the SQL datasource seed wrapper so the Effect Layer can surface skip vs error
 * to health consumers without conflating them.
 */
export type OpenApiDatasourceCatalogSeedBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" }
  | { readonly kind: "seeded"; readonly inserted: boolean }
  | { readonly kind: "error"; readonly message: string };

/**
 * Boot-pass wrapper. Log-and-continue posture (mirrors
 * `runBuiltinDatasourceCatalogSeedBoot`): a seed failure leaves the
 * migration-inserted row authoritative rather than crashing the API.
 */
export async function runOpenApiDatasourceCatalogSeedBoot(): Promise<OpenApiDatasourceCatalogSeedBootResult> {
  const { hasInternalDB, getInternalDB } = await import("@atlas/api/lib/db/internal");

  if (!hasInternalDB()) {
    log.info("openapi-generic catalog seed: no internal DB configured, skipping");
    return { kind: "skipped", reason: "no-internal-db" };
  }

  const pool = getInternalDB();
  const db: OpenApiDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    const result = await seedOpenApiDatasourceCatalog(db);
    return { kind: "seeded", inserted: result.inserted };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized },
      "openapi-generic catalog seed failed — migration-inserted row remains authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
