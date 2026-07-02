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
import {
  DATA_CANDIDATES,
  candidateConfigSchema,
  candidateInstallModel,
} from "./data-candidates";
import type { OpenApiDatasourceCatalogSeedDb } from "./catalog-seed";
import { assertOperatorCatalogWrite } from "@atlas/api/lib/plugins/catalog-provenance";

const log = createLogger("openapi.data-candidate-seed");

export interface DataCandidateCatalogSeedResult {
  /** Slugs the `ON CONFLICT DO NOTHING` actually inserted (were missing). */
  readonly insertedSlugs: ReadonlyArray<string>;
}

/**
 * Idempotently seed every data-candidate catalog row. Column order + the
 * `'datasource'` type+pillar / `'available'` status / `'starter'` min_plan /
 * `true` enabled+saas_eligible literals all mirror migrations 0109 / 0111 and
 * the generic-row seed so the admin catalog surfaces these identically. The
 * `install_model` and `config_schema` are PER-CANDIDATE (a `form` candidate
 * carries the credential form; an `oauth-datasource` candidate is `oauth-datasource`
 * with an empty form), bound rather than literal so one loop seeds both shapes.
 * One INSERT per row keeps the idempotency per-row (a partially-seeded catalog
 * converges on the next boot).
 */
export async function seedDataCandidateCatalog(
  db: OpenApiDatasourceCatalogSeedDb,
): Promise<DataCandidateCatalogSeedResult> {
  // Operator-curated-only gate (#4174/#4099): candidate rows ship inside
  // Atlas (`data-candidates.ts`), one gate call covers the whole batch.
  assertOperatorCatalogWrite("openapi-data-candidate-seed");
  const insertedSlugs: string[] = [];

  for (const candidate of DATA_CANDIDATES) {
    const configSchemaJson = JSON.stringify(candidateConfigSchema(candidate));
    const { rows } = await db.query<{ slug: string }>(
      `INSERT INTO plugin_catalog
         (id, name, slug, description, type, install_model, pillar,
          implementation_status, auto_install, min_plan, enabled, saas_eligible,
          config_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'datasource', $5, 'datasource', 'available',
               false, 'starter', true, true, $6::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING slug`,
      [
        candidate.catalogId,
        candidate.name,
        candidate.slug,
        candidate.description,
        candidateInstallModel(candidate),
        configSchemaJson,
      ],
    );
    if (rows.length > 0) insertedSlugs.push(candidate.slug);
  }

  log.info(
    { insertedCount: insertedSlugs.length, total: DATA_CANDIDATES.length, insertedSlugs },
    "data-candidate catalog seed complete",
  );
  return { insertedSlugs };
}
