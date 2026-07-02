/**
 * SQL artifacts for the platform-admin plugin-catalog CRUD routes
 * (`api/routes/admin-marketplace.ts` `POST /catalog` + `PUT /catalog/:id`).
 *
 * Extracted from the route handlers so real-Postgres coverage
 * (`__tests__/catalog-crud-pg.test.ts`) can execute the exact statements
 * the routes run — the same plan-time drift class
 * `install/persist-form-install-pg.test.ts` exists for (#4186): a mocked
 * route test can't see a column the live schema requires, so an INSERT
 * that omits a NOT-NULL column (#4232) stays green in unit tests and
 * 23502s in production.
 */

/**
 * Map a `plugin_catalog.type` to its ADR-0006 pillar. Mirrors the
 * BEFORE-INSERT trigger 0092 installed and 0096 dropped
 * (`trg_plugin_catalog_default_pillar`): chat→chat,
 * datasource→datasource, everything else (context, interaction, action,
 * sandbox, and the pre-#2650 admin-UI grouping `integration`)→action.
 * Every `plugin_catalog` writer must name `pillar` explicitly since 0096.
 *
 * `'knowledge'` (0161 / ADR-0028) is deliberately absent: it is never
 * derived from a type — the knowledge seeder/ingest names it explicitly
 * on rows of type `context`, and the update builder below only re-derives
 * pillar when `type` actually changes, so those rows survive CRUD edits.
 */
export function pillarFromCatalogType(type: string): "chat" | "datasource" | "action" {
  switch (type) {
    case "chat":
      return "chat";
    case "datasource":
      return "datasource";
    default:
      return "action";
  }
}

/** `POST /catalog` body after Zod validation (CreateCatalogBodySchema). */
export interface CatalogCreateFields {
  name: string;
  slug: string;
  description?: string;
  type: string;
  npmPackage?: string;
  iconUrl?: string;
  configSchema?: unknown;
  minPlan: string;
  enabled: boolean;
}

/** `PUT /catalog/:id` body after Zod validation (UpdateCatalogBodySchema). */
export interface CatalogUpdateFields {
  name?: string;
  description?: string;
  type?: string;
  npmPackage?: string;
  iconUrl?: string;
  configSchema?: unknown;
  minPlan?: string;
  enabled?: boolean;
}

/**
 * The INSERT behind `POST /catalog`, with its parameter list co-located
 * so SQL and params can't drift apart across call sites.
 */
export function buildCatalogCreateSql(
  id: string,
  fields: CatalogCreateFields,
): { sql: string; params: unknown[] } {
  // `pillar` named explicitly (#4232): NOT NULL since 0092, and 0096
  // dropped the trigger that used to derive it — omitting it is a 23502
  // on every create.
  return {
    sql: `INSERT INTO plugin_catalog (id, name, slug, description, type, pillar, npm_package, icon_url, config_schema, min_plan, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
    params: [
      id,
      fields.name,
      fields.slug,
      fields.description ?? null,
      fields.type,
      pillarFromCatalogType(fields.type),
      fields.npmPackage ?? null,
      fields.iconUrl ?? null,
      fields.configSchema ? JSON.stringify(fields.configSchema) : null,
      fields.minPlan,
      fields.enabled,
    ],
  };
}

/**
 * The dynamic UPDATE behind `PUT /catalog/:id`. Returns `null` when the
 * body carries no updatable field (the route maps that to 400).
 */
export function buildCatalogUpdateSql(
  id: string,
  fields: CatalogUpdateFields,
): { sql: string; params: unknown[] } | null {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (fields.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(fields.name); }
  if (fields.description !== undefined) { setClauses.push(`description = $${paramIdx++}`); params.push(fields.description); }
  if (fields.type !== undefined) {
    // Keep pillar consistent when type changes (#4232) — the semantics of
    // `trg_plugin_catalog_sync_pillar_on_type_change`, dropped by 0096.
    // In an UPDATE's SET, a bare column reference reads the OLD row, so
    // the CASE re-derives pillar only when type ACTUALLY changes; a
    // same-type PUT preserves an explicitly-named pillar (e.g. the
    // knowledge seeder's 'knowledge' rows, which the mapping never emits).
    const typeIdx = paramIdx++;
    const pillarIdx = paramIdx++;
    setClauses.push(`type = $${typeIdx}`);
    setClauses.push(`pillar = CASE WHEN type IS DISTINCT FROM $${typeIdx} THEN $${pillarIdx} ELSE pillar END`);
    params.push(fields.type, pillarFromCatalogType(fields.type));
  }
  if (fields.npmPackage !== undefined) { setClauses.push(`npm_package = $${paramIdx++}`); params.push(fields.npmPackage); }
  if (fields.iconUrl !== undefined) { setClauses.push(`icon_url = $${paramIdx++}`); params.push(fields.iconUrl); }
  if (fields.configSchema !== undefined) { setClauses.push(`config_schema = $${paramIdx++}`); params.push(JSON.stringify(fields.configSchema)); }
  if (fields.minPlan !== undefined) { setClauses.push(`min_plan = $${paramIdx++}`); params.push(fields.minPlan); }
  if (fields.enabled !== undefined) { setClauses.push(`enabled = $${paramIdx++}`); params.push(fields.enabled); }

  if (setClauses.length === 0) return null;

  setClauses.push(`updated_at = now()`);
  params.push(id);
  return {
    sql: `UPDATE plugin_catalog SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  };
}
