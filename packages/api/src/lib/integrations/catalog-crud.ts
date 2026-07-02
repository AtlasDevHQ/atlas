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

import type { Pillar, PlanTier } from "@useatlas/types";
import { assertOperatorCatalogWrite } from "@atlas/api/lib/plugins/catalog-provenance";

/**
 * The `plugin_catalog.type` values the DB admits
 * (`chk_plugin_catalog_type` in db/schema.ts / migration 0092). The CRUD
 * route's Zod enum and the seeder's `CatalogEntryType` are both subsets.
 */
export type CatalogType =
  | "datasource"
  | "context"
  | "interaction"
  | "action"
  | "sandbox"
  | "chat"
  | "integration";

/** A statement + its positionally-aligned parameter list. */
export interface CatalogSqlStatement {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * Map a `plugin_catalog.type` to its ADR-0006 pillar. Mirrors the
 * BEFORE-INSERT trigger 0092 installed and 0096 dropped
 * (`trg_plugin_catalog_default_pillar`): chat→chat,
 * datasource→datasource, everything else (context, interaction, action,
 * sandbox, and the pre-#2650 admin-UI grouping `integration`)→action.
 * Every `plugin_catalog` writer must name `pillar` explicitly since 0096.
 *
 * `'knowledge'` (0161 / ADR-0028) is deliberately absent: it is never
 * derived from a type — the built-in knowledge seeder names it explicitly
 * on rows of type `context`, and the update builder below only re-derives
 * pillar when `type` actually changes, so those rows survive
 * type-preserving CRUD edits. A type change away from `context`
 * re-derives to `action` and is one-way: flipping type back does NOT
 * restore `knowledge` — re-seed or fix the row manually.
 */
export function pillarFromCatalogType(type: CatalogType): Exclude<Pillar, "knowledge"> {
  switch (type) {
    case "chat":
      return "chat";
    case "datasource":
      return "datasource";
    case "context":
    case "interaction":
    case "action":
    case "sandbox":
    case "integration":
      return "action";
    default: {
      // Compile-time exhaustiveness: adding a CatalogType forces a
      // pillar decision here instead of silently landing on 'action'.
      const unmapped: never = type;
      throw new Error(`Unmapped catalog type: ${String(unmapped)}`);
    }
  }
}

/** `POST /catalog` body after Zod validation (CreateCatalogBodySchema). */
export interface CatalogCreateFields {
  name: string;
  slug: string;
  description?: string;
  type: CatalogType;
  npmPackage?: string;
  iconUrl?: string;
  configSchema?: unknown;
  minPlan: PlanTier;
  enabled: boolean;
}

/** `PUT /catalog/:id` body after Zod validation (UpdateCatalogBodySchema). */
export interface CatalogUpdateFields {
  name?: string;
  description?: string;
  type?: CatalogType;
  npmPackage?: string;
  iconUrl?: string;
  configSchema?: unknown;
  minPlan?: PlanTier;
  enabled?: boolean;
}

/**
 * The INSERT behind `POST /catalog`, with its parameter list co-located
 * so SQL and params can't drift apart across call sites.
 */
export function buildCatalogCreateSql(
  id: string,
  fields: CatalogCreateFields,
): CatalogSqlStatement {
  // Operator-curated-only gate (#4174/#4099), moved here from the route
  // with the SQL: the statement can't be obtained without passing it.
  // The one interactive path that creates catalog rows; platform_admin-
  // gated at the route.
  assertOperatorCatalogWrite("platform-admin-crud");
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
): CatalogSqlStatement | null {
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
  // NOTE the create/update asymmetry, preserved verbatim from the
  // pre-#4232 route: create maps a falsy configSchema to SQL NULL, while
  // an update stringifies whatever arrived (`null` → JSONB 'null', a
  // non-NULL value) — there is no way to clear the column via PUT.
  if (fields.configSchema !== undefined) { setClauses.push(`config_schema = $${paramIdx++}`); params.push(JSON.stringify(fields.configSchema)); }
  if (fields.minPlan !== undefined) { setClauses.push(`min_plan = $${paramIdx++}`); params.push(fields.minPlan); }
  if (fields.enabled !== undefined) { setClauses.push(`enabled = $${paramIdx++}`); params.push(fields.enabled); }

  if (setClauses.length === 0) return null;

  // Operator-curated-only gate (#4174/#4099) — this UPDATE can repoint
  // trust-carrying fields (npm_package, config_schema); asserted only
  // when a statement is actually built (an empty body writes nothing).
  assertOperatorCatalogWrite("platform-admin-crud");
  setClauses.push(`updated_at = now()`);
  params.push(id);
  return {
    sql: `UPDATE plugin_catalog SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  };
}
