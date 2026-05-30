/**
 * Boot-time idempotent seed for the built-in vendor `*-data` Datasource catalog
 * rows (v0.0.2 slice 6a, #3028). The data-candidate analogue of
 * `catalog-seed.ts::seedOpenApiDatasourceCatalog` — same posture, one row per
 * {@link DATA_CANDIDATES} entry:
 *
 *   - Each candidate is a real `plugin_catalog` datasource-pillar row so it
 *     surfaces in `/admin/connections` as its own card ("Stripe").
 *   - Like `openapi-generic`, these rows are INTENTIONALLY NOT in
 *     `BUILTIN_DATASOURCE_CATALOG_SLUGS` (the SQL pool allowlist) — a REST
 *     datasource has no SQL pool; it resolves through the parallel REST resolver
 *     (`workspace-datasource.ts`). Keeping them out means the SQL boot loader
 *     skips their installs for free.
 *   - Bare `ON CONFLICT DO NOTHING` (covers both the `slug` unique index and the
 *     `id` primary key) so a re-boot on a populated catalog is a no-op and an
 *     operator's out-of-band `name`/`description` edits survive.
 *
 * Re-asserts the same rows migration 0109 inserts on fresh DBs; the migration and
 * this seed share {@link DATA_CANDIDATE_CONFIG_SCHEMA} + the {@link DATA_CANDIDATES}
 * registry as the single source of truth (the `migration 0109 ↔ code alignment`
 * test asserts they match). Invoked from `catalog-seed.ts`'s boot wrapper so the
 * generic row and the candidate rows seed in one boot pass with no extra DAG node.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { DATA_CANDIDATES, DATA_CANDIDATE_CONFIG_SCHEMA } from "./data-candidates";
import type { OpenApiDatasourceCatalogSeedDb } from "./catalog-seed";

const log = createLogger("openapi.data-candidate-seed");

export interface DataCandidateCatalogSeedResult {
  /** Slugs the `ON CONFLICT DO NOTHING` actually inserted (were missing). */
  readonly insertedSlugs: ReadonlyArray<string>;
}

/**
 * Idempotently seed every data-candidate catalog row. Column order + the
 * `'datasource'` type+pillar / `'available'` status / `'form'` install_model /
 * `'starter'` min_plan / `true` enabled+saas_eligible literals all mirror
 * migration 0109 and the generic-row seed so the admin catalog surfaces these
 * identically. One INSERT per row keeps the SQL trivial and the idempotency
 * per-row (a partially-seeded catalog converges on the next boot).
 */
export async function seedDataCandidateCatalog(
  db: OpenApiDatasourceCatalogSeedDb,
): Promise<DataCandidateCatalogSeedResult> {
  const insertedSlugs: string[] = [];
  const configSchemaJson = JSON.stringify(DATA_CANDIDATE_CONFIG_SCHEMA);

  for (const candidate of DATA_CANDIDATES) {
    const { rows } = await db.query<{ slug: string }>(
      `INSERT INTO plugin_catalog
         (id, name, slug, description, type, install_model, pillar,
          implementation_status, auto_install, min_plan, enabled, saas_eligible,
          config_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'datasource', 'form', 'datasource', 'available',
               false, 'starter', true, true, $5::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING slug`,
      [candidate.catalogId, candidate.name, candidate.slug, candidate.description, configSchemaJson],
    );
    if (rows.length > 0) insertedSlugs.push(candidate.slug);
  }

  log.info(
    { insertedCount: insertedSlugs.length, total: DATA_CANDIDATES.length, insertedSlugs },
    "data-candidate catalog seed complete",
  );
  return { insertedSlugs };
}
