/**
 * Operator-curated-only provenance gate for `plugin_catalog` writes —
 * #4174, the tracked precondition of #4099 (plugin-execution isolation).
 *
 * Plugin hooks and validators run FULLY IN-PROCESS in the API
 * (`plugins/hooks.ts` dispatches them on every request, holding tenant
 * secrets and live DB pools). That is safe for exactly one reason: every
 * row in `plugin_catalog` originates from an operator-authored write path,
 * so plugin code carries the same trust level as Atlas's own code.
 *
 * The moment a third-party (community) submission path can create catalog
 * rows, that assumption breaks — untrusted code in the trusted process.
 * #4099 is the design issue for the isolation model (capability-brokered
 * plugin execution) that MUST land before any such path ships.
 *
 * Adding a new catalog write path?
 *
 * - **Operator-authored** (Atlas's own seed code, or a surface role-gated
 *   to the operator's platform admins): add a token to
 *   {@link OPERATOR_CATALOG_WRITE_SOURCES}, call
 *   {@link assertOperatorCatalogWrite} next to the INSERT, and add the
 *   file to `KNOWN_CATALOG_WRITE_SITES` in
 *   `__tests__/catalog-provenance.test.ts` — the drift test pins the
 *   exact set of files that write `plugin_catalog` rows and fails until
 *   you do.
 * - **Third-party / community submission**: STOP — do not widen this
 *   union. That work is gated on #4099; plugin execution must be
 *   isolated first.
 */

/**
 * Every write path allowed to create `plugin_catalog` rows. All are
 * operator-authored by construction: the platform-admin CRUD route is
 * role-gated to the operator's own admins, and the four seed modules ship
 * inside Atlas itself.
 */
export const OPERATOR_CATALOG_WRITE_SOURCES = [
  /** `POST /api/v1/platform/plugins/catalog` — `platform_admin` role. */
  "platform-admin-crud",
  /** Boot seed from `atlas.config.ts:catalog` (`integrations/catalog-seeder.ts`). */
  "config-catalog-seed",
  /** Built-in SQL datasource rows (`db/seed-builtin-datasource-catalog.ts`). */
  "builtin-datasource-seed",
  /** The `openapi-generic` datasource row (`openapi/catalog-seed.ts`). */
  "openapi-generic-seed",
  /** OpenAPI data-candidate rows (`openapi/data-candidate-seed.ts`). */
  "openapi-data-candidate-seed",
] as const;

export type OperatorCatalogWriteSource =
  (typeof OPERATOR_CATALOG_WRITE_SOURCES)[number];

/**
 * Runtime witness called next to every `plugin_catalog` INSERT. The
 * parameter type restricts callers to the enumerated operator sources at
 * compile time; the runtime check fails closed on anything that slips
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
