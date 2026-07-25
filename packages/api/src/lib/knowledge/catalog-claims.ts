/**
 * One catalog id, one ingest target (#4770, ADR-0036 §Ingestion & connectors).
 *
 * The sync cycle walk (`lib/knowledge/sync.ts::dispatchInstall`) routes an
 * install by asking each registry whether it owns the catalog id, and it asks
 * the BRAIN registry first. That ordering is only safe if a catalog id can
 * never be in both — otherwise a duplicate would silently take the brain arm
 * and its knowledge connector would stop syncing with no error anywhere, which
 * reads as "the connector just quietly stopped".
 *
 * This module is that guarantee, and it is a SEPARATE module for a concrete
 * reason: both registries must claim through the SAME map, or the check is
 * order-dependent again. Homing the map in either registry makes the other's
 * call a peek into a sibling — which is exactly the first attempt, a one-sided
 * check in `registerBrainSourceConnector` that guarded the wrong direction
 * (brain sources register last today, so the case it caught cannot happen while
 * the case it missed can).
 */

/** Which engine's ingest core a catalog id's installs are routed to. */
export type CatalogIngestTarget = "knowledge-documents" | "brain-episodes";

const claims = new Map<string, CatalogIngestTarget>();

/**
 * Claim a catalog id for one ingest target, or throw if another already holds
 * it. Called by BOTH registries at registration time, so the check is
 * order-independent — which is the whole point, since registration order is a
 * property of one function in `register.ts` and not an invariant anyone
 * maintains deliberately.
 */
export function claimCatalogIngestTarget(catalogId: string, target: CatalogIngestTarget): void {
  const existing = claims.get(catalogId);
  if (existing !== undefined && existing !== target) {
    throw new Error(
      `Catalog id "${catalogId}" is already registered as ${existing} — a catalog row must belong to exactly one ingest target, because the sync cycle routes installs by asking one registry before the other`,
    );
  }
  claims.set(catalogId, target);
}

/** The claimed target for a catalog id, if any. Read by tests. */
export function getCatalogIngestTarget(catalogId: string): CatalogIngestTarget | undefined {
  return claims.get(catalogId);
}

/**
 * Test-only: release the claims held by ONE target.
 *
 * Scoped, not a blanket `clear()`. Each registry's `_reset*` helper calls this,
 * and a blanket clear would have one registry release the OTHER's claims while
 * that registry's own map still held them — after which a colliding id could be
 * registered with no error, and the check would be silently defeated inside CI,
 * which is the only place it is ever exercised.
 */
export function _resetCatalogIngestClaims(target: CatalogIngestTarget): void {
  for (const [catalogId, held] of claims) {
    if (held === target) claims.delete(catalogId);
  }
}
