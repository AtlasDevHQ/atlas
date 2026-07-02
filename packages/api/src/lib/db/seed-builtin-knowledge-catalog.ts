/**
 * Boot-time idempotent seed pass for the single built-in Knowledge Base
 * catalog row, `okf-upload` (#4206, ADR-0028).
 *
 * The v0 Knowledge Base lifecycle (ADR-0028 §5) is one built-in catalog row:
 * an **explicit, degenerate form install** — no credentials, minimal
 * `config_schema`. Installing it creates a *collection* (a `workspace_plugins`
 * row, pillar `knowledge`); ingest is a separate admin act. Per ADR-0028 §5 the
 * row ships inside Atlas and is operator-curated — not declared in
 * `atlas.config.ts` — so it is seeded here at boot through the operator-curated
 * seam (`assertOperatorCatalogWrite`, `lib/plugins/catalog-provenance.ts`),
 * exactly mirroring the built-in Datasource catalog seed.
 *
 * Unlike the Datasource rows, `okf-upload` carries **no credentials and no
 * `INTEGRATION_TABLES` entry** — connectors (Notion/Confluence OAuth installs
 * with credentials + Scheduler sync) are deliberate follow-ups. The row's
 * `pillar = 'knowledge'` is admitted by migration 0161's widened CHECK, which
 * `Migration` guarantees has run before this seed (the Layer's `Migration`
 * dependency).
 *
 * Idempotency: unqualified `ON CONFLICT DO NOTHING` covers both the `slug`
 * unique index and the `id` primary key, so re-running on a populated catalog
 * is a no-op. A seed-time failure logs at error and the API keeps booting —
 * the row from a prior boot answers admin-UI reads.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import { assertOperatorCatalogWrite } from "@atlas/api/lib/plugins/catalog-provenance";

const log = createLogger("db.seed-builtin-knowledge-catalog");

/**
 * Declarative description of the built-in Knowledge Base catalog row.
 * Mirrors `plugin_catalog`'s column shape for the columns the seed sets.
 * `type` (`context`), `pillar` (`knowledge`), `implementation_status`
 * (`available`), `min_plan` (`starter`), and `enabled` (`true`) are pinned
 * as SQL literals in the INSERT.
 */
export interface BuiltinKnowledgeCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly installModel: "form";
  readonly autoInstall: boolean;
  readonly saasEligible: boolean;
  readonly configSchema: ReadonlyArray<ConfigSchemaField>;
}

/**
 * The single built-in Knowledge Base catalog row (ADR-0028 §5). A
 * credential-less form install: the only config field is an optional
 * human description of the collection. The collection's identity is the
 * install slug chosen at install time, not a config field.
 */
export const BUILTIN_KNOWLEDGE_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: "catalog:okf-upload",
  slug: "okf-upload",
  name: "Knowledge Base (Upload)",
  description:
    "Upload an Open Knowledge Format bundle as a review-gated knowledge collection.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/**
 * Narrow shape of the DB client the seeder needs. Mirrors
 * `BuiltinDatasourceCatalogSeedDb` so a single mock pool serves both
 * seeders in tests.
 */
export interface BuiltinKnowledgeCatalogSeedDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface BuiltinKnowledgeCatalogSeedResult {
  /** True when the `ON CONFLICT DO NOTHING` ran an insert (row didn't exist). */
  readonly inserted: boolean;
}

/**
 * Idempotently seed the built-in `okf-upload` Knowledge Base catalog row.
 *
 * Column order matches the built-in Datasource seed's VALUES block so the two
 * seeds stay structurally recognizable; `type` and `pillar` differ (`context` /
 * `knowledge`). `RETURNING slug` reports whether the row was inserted vs
 * preserved.
 */
export async function seedBuiltinKnowledgeCatalog(
  db: BuiltinKnowledgeCatalogSeedDb,
): Promise<BuiltinKnowledgeCatalogSeedResult> {
  const row = BUILTIN_KNOWLEDGE_CATALOG_ROW;

  // Operator-curated-only gate (#4174/#4099): this row ships inside Atlas.
  assertOperatorCatalogWrite("builtin-knowledge-seed");
  const { rows } = await db.query<{ slug: string }>(
    `INSERT INTO plugin_catalog
       (id, name, slug, description, type, install_model, pillar,
        implementation_status, auto_install, min_plan, enabled, saas_eligible,
        config_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'context', $5, 'knowledge', 'available', $6,
             'starter', true, $7, $8::jsonb, NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING slug`,
    [
      row.id,
      row.name,
      row.slug,
      row.description,
      row.installModel,
      row.autoInstall,
      row.saasEligible,
      JSON.stringify(row.configSchema),
    ],
  );

  const inserted = rows.length > 0;
  log.info(
    { inserted, slug: row.slug },
    "Built-in Knowledge Base catalog seed complete",
  );
  return { inserted };
}

/**
 * Discriminated outcome of {@link runBuiltinKnowledgeCatalogSeedBoot}.
 * Mirrors the Datasource seed's boot result so the Effect Layer can surface
 * skip vs error to health consumers without conflating them.
 */
export type BuiltinKnowledgeCatalogSeedBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" }
  | { readonly kind: "seeded"; readonly inserted: boolean }
  | { readonly kind: "error"; readonly message: string };

/**
 * Boot-pass wrapper. Log-and-continue posture (mirrors
 * `runBuiltinDatasourceCatalogSeedBoot`): a seed failure leaves the
 * pre-existing row authoritative rather than crashing the API.
 */
export async function runBuiltinKnowledgeCatalogSeedBoot(): Promise<BuiltinKnowledgeCatalogSeedBootResult> {
  const { hasInternalDB, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );

  if (!hasInternalDB()) {
    log.info(
      "Built-in Knowledge Base catalog seed: no internal DB configured, skipping",
    );
    return { kind: "skipped", reason: "no-internal-db" };
  }

  const pool = getInternalDB();
  const db: BuiltinKnowledgeCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    const result = await seedBuiltinKnowledgeCatalog(db);
    return { kind: "seeded", inserted: result.inserted };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized },
      "Built-in Knowledge Base catalog seed failed — okf-upload row from prior boot remains authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
