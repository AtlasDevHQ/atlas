/**
 * Operator-curated-only provenance gate for `plugin_catalog` writes —
 * #4174, the tracked precondition of #4099 (plugin-execution isolation).
 *
 * Plugin code runs FULLY IN-PROCESS in the API, holding tenant secrets
 * and live DB pools (`plugins/hooks.ts` is the dispatch runtime:
 * `api/index.ts` middleware fires onRequest/onResponse on every request;
 * query/tool hooks fire per tool call). That is safe for exactly one
 * reason: every row in `plugin_catalog` originates from an
 * operator-authored write path, so plugin code carries the same trust
 * level as Atlas's own code.
 *
 * The moment a third-party (community) submission path can create — or
 * repoint (`npm_package`, `config_schema`) — catalog rows, that
 * assumption breaks: untrusted code in the trusted process. #4099 is the
 * design issue for the isolation model (capability-brokered plugin
 * execution) that MUST land before any such path ships.
 *
 * Adding a new catalog write path?
 *
 * - **Operator-authored** (Atlas's own seed code, or a surface role-gated
 *   to the operator's platform admins): add a token to
 *   {@link OPERATOR_CATALOG_WRITE_SOURCES}, call
 *   {@link assertOperatorCatalogWrite} next to the statement, and bind
 *   the file to its token in `KNOWN_CATALOG_WRITE_SITES` in
 *   `__tests__/catalog-provenance.test.ts` — the drift test pins the
 *   exact set of files that create or mutate `plugin_catalog` rows and
 *   fails until you do.
 * - **Third-party / community submission**: STOP — do not widen this
 *   union. That work is gated on #4099; plugin execution must be
 *   isolated first.
 *
 * Scope: the gate covers runtime INSERT/UPDATE sites in raw SQL — keep
 * catalog writes in that form (a query-builder write would evade the
 * drift scan; extend the test's pattern if that ever changes). DELETEs
 * are out of scope (removing a row cannot introduce untrusted code), as
 * are SQL migrations (they ship inside Atlas and are operator-authored by
 * construction). When #4099 lands, the natural hardening step is a
 * `source` column on `plugin_catalog` CHECK-constrained to these tokens —
 * a data-level invariant covering writers this code-level gate can't see
 * (manual psql, out-of-tree scripts); not worth the migration cost before
 * the isolation design exists.
 */

/**
 * Every write path allowed to create or mutate `plugin_catalog` rows.
 * All are operator-authored by construction: the platform-admin CRUD
 * routes are role-gated to the operator's own admins, the built-in and
 * OpenAPI seed modules ship their rows inside Atlas itself, and the two
 * config-driven paths write only what the operator declared in
 * `atlas.config.ts`.
 */
export const OPERATOR_CATALOG_WRITE_SOURCES = [
  /** `POST`/`PUT /api/v1/platform/plugins/catalog` — `platform_admin` role. */
  "platform-admin-crud",
  /** Boot seed from `atlas.config.ts:catalog` (`integrations/catalog-seeder.ts`). */
  "config-catalog-seed",
  /** Boot UPDATE from `atlas.config.ts:overrideImplementationStatus` (`integrations/implementation-status-override.ts`). */
  "implementation-status-override",
  /** Built-in SQL datasource rows (`db/seed-builtin-datasource-catalog.ts`). */
  "builtin-datasource-seed",
  /** The `openapi-generic` datasource row (`openapi/catalog-seed.ts`). */
  "openapi-generic-seed",
  /** OpenAPI data-candidate rows (`openapi/data-candidate-seed.ts`). */
  "openapi-data-candidate-seed",
  /** The built-in Knowledge Base rows — `okf-upload` #4206, `bundle-sync` #4211 (`db/seed-builtin-knowledge-catalog.ts`). */
  "builtin-knowledge-seed",
] as const;

export type OperatorCatalogWriteSource =
  (typeof OPERATOR_CATALOG_WRITE_SOURCES)[number];

/**
 * Runtime witness called next to every `plugin_catalog` INSERT/UPDATE.
 * The parameter type restricts callers to the enumerated operator sources
 * at compile time; the runtime check fails closed on anything that slips
 * past the compiler (an `as` cast, a plain-JS caller). Throws rather than
 * warns: an unrecognized catalog write is a trust-boundary violation
 * (#4099), not a recoverable input error.
 */
export function assertOperatorCatalogWrite(
  source: OperatorCatalogWriteSource,
): void {
  if (!OPERATOR_CATALOG_WRITE_SOURCES.includes(source)) {
    throw new Error(
      `plugin_catalog write from unrecognized source "${String(source)}" — ` +
        "the catalog is operator-curated only. Third-party plugin submission " +
        "is gated on #4099 (plugin-execution isolation); see " +
        "lib/plugins/catalog-provenance.ts.",
    );
  }
}
