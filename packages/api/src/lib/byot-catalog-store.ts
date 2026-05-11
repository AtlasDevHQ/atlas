/**
 * Postgres-backed L2 cache for BYOT discovery catalogs (#2274).
 *
 * The per-provider catalog modules each maintain an in-memory L1 cache
 * scoped to a single pod. This module is the L2: cross-pod, survives
 * pod restarts, and centralizes the refresh story.
 *
 * Per-provider modules call `loadFromDB` on cold start and `storeToDB`
 * after every fresh upstream fetch. The wire shape stored matches the
 * `GatewayCatalogModel[]` array each module produces — keeping the JSON
 * schema uniform across providers means the periodic refresh job
 * (and #2275 unknown-model handling later) can iterate every catalog
 * regardless of provider.
 *
 * Operational concerns:
 *   - This is the only DB-backed BYOT-cache surface. Read/write paths
 *     are best-effort: if the DB is unreachable, callers fall through
 *     to in-memory + fresh upstream fetch. The cache is performance,
 *     not correctness — a DB outage must not break a working BYOT
 *     workspace.
 *   - The internal-DB requirement is checked once via `hasInternalDB()`;
 *     deployments without an internal DB simply skip the L2 layer.
 *   - We never store secrets here. The cached `payload` is the wire
 *     shape returned to admins — no API keys or IAM bundles.
 */

import { hasInternalDB, internalQuery } from "./db/internal";
import { createLogger } from "./logger";
import type { GatewayCatalogModel } from "@useatlas/types";

const log = createLogger("byot-catalog-store");

export type ByotProviderKey = "anthropic" | "openai" | "bedrock";

export interface PersistedCatalog {
  models: GatewayCatalogModel[];
  fetchedAt: string;
}

interface CatalogRow {
  payload: { models: GatewayCatalogModel[] };
  fetched_at: string | Date;
  [key: string]: unknown;
}

/**
 * Look up a previously-persisted catalog. Region defaults to the empty
 * string for providers that aren't region-scoped (anthropic, openai) so
 * the unique constraint stays simple.
 */
export async function loadFromDB(
  orgId: string,
  provider: ByotProviderKey,
  region: string = "",
): Promise<PersistedCatalog | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<CatalogRow>(
      `SELECT payload, fetched_at
       FROM workspace_model_catalog
       WHERE org_id = $1 AND provider = $2 AND region = $3
       LIMIT 1`,
      [orgId, provider, region],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row.payload || !Array.isArray(row.payload.models)) {
      log.warn(
        { orgId, provider, region },
        "byot-catalog-store: malformed payload in DB row — ignoring",
      );
      return null;
    }
    const fetchedAt =
      row.fetched_at instanceof Date
        ? row.fetched_at.toISOString()
        : new Date(row.fetched_at).toISOString();
    return { models: row.payload.models, fetchedAt };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, provider },
      "byot-catalog-store: load failed — falling through to upstream fetch",
    );
    return null;
  }
}

/**
 * Persist a freshly-fetched catalog. Best-effort: a DB write failure is
 * logged but never thrown back to the caller — the L1 cache + return
 * value are still good, and the next request will retry the write.
 */
export async function storeToDB(
  orgId: string,
  provider: ByotProviderKey,
  region: string = "",
  catalog: PersistedCatalog,
): Promise<void> {
  if (!hasInternalDB()) return;
  try {
    await internalQuery(
      `INSERT INTO workspace_model_catalog (org_id, provider, region, payload, fetched_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       ON CONFLICT (org_id, provider, region) DO UPDATE SET
         payload = EXCLUDED.payload,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = now()`,
      [
        orgId,
        provider,
        region,
        JSON.stringify({ models: catalog.models }),
        catalog.fetchedAt,
      ],
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, provider, region },
      "byot-catalog-store: persist failed — L1 cache only this round",
    );
  }
}

/**
 * Drop every persisted entry for an org. Called from the per-provider
 * cache invalidators on key rotation so the L2 layer is flushed in
 * lockstep with the L1 layer.
 */
export async function deleteFromDB(
  orgId: string,
  provider: ByotProviderKey,
): Promise<void> {
  if (!hasInternalDB()) return;
  try {
    await internalQuery(
      `DELETE FROM workspace_model_catalog WHERE org_id = $1 AND provider = $2`,
      [orgId, provider],
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, provider },
      "byot-catalog-store: delete failed — stale L2 entry may shadow next refresh",
    );
  }
}

/**
 * Check whether a persisted entry has aged out vs. the supplied TTL.
 * Caller-owned freshness check so each per-provider module can keep its
 * own TTL knob (`ATLAS_BYOT_CATALOG_TTL_MS`).
 */
export function isFresh(persisted: PersistedCatalog, ttlMs: number): boolean {
  const fetched = Date.parse(persisted.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  return Date.now() - fetched < ttlMs;
}
