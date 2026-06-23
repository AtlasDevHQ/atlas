/**
 * Single source of truth for "which tables is this connection allowed to
 * query?" — the mode-aware, group-scoped whitelist set that the SQL validation
 * pipeline (`validateSQL` / `executeSQL`) enforces.
 *
 * Every read surface that wants to *show* the queryable table set — the schema
 * diff (`diff.ts`), the public `/api/v1/tables` endpoint (#3898) — resolves it
 * through here so the advertised set can never drift from the enforced set on
 * the org / mode / internal-DB axes. Keeping one definition (rather than two
 * hand-synced copies) is what makes "advertised == enforced" structural.
 */

import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getOrgWhitelistedTables, getWhitelistedTables, loadOrgWhitelist } from "./whitelist";

const log = createLogger("semantic-allowed-tables");

export interface AllowedTablesScope {
  /** Active workspace/org, when present (SaaS). Absent for self-hosted CLI / single-tenant. */
  orgId?: string;
  /**
   * Atlas mode. Passed **raw** to the org resolvers — `undefined` deliberately
   * selects the legacy cache key, matching `validateSQL` exactly; never default
   * it to a concrete mode here or the advertised set diverges from the enforced
   * one when a caller has no mode in context.
   */
  atlasMode?: AtlasMode;
}

/**
 * Resolve the mode-aware allowed-tables whitelist for an org + connection,
 * falling back to the file-based whitelist when no org context is available
 * (self-hosted CLI / single-tenant). Fails closed to an empty set on whitelist
 * load errors to avoid leaking the whole DB schema across tenants.
 *
 * Mirrors the resolution `validateSQL` performs (org-scoped vs file-scoped,
 * raw `atlasMode`) so consumers advertise exactly what the enforcement layer
 * permits.
 */
export async function resolveAllowedTables(
  connectionId: string,
  scope: AllowedTablesScope,
): Promise<Set<string>> {
  const { orgId, atlasMode } = scope;
  if (orgId && hasInternalDB()) {
    try {
      await loadOrgWhitelist(orgId, atlasMode);
      return getOrgWhitelistedTables(orgId, connectionId, atlasMode);
    } catch (err) {
      log.error(
        { orgId, connectionId, atlasMode, err: err instanceof Error ? err.message : String(err) },
        "Failed to load org whitelist — scoping allowed tables to empty set (fail closed)",
      );
      return new Set();
    }
  }
  return getWhitelistedTables(connectionId);
}

/**
 * True when a read surface should source columns/snapshots from the per-org
 * DB-backed mirror rather than the on-disk base root — i.e. exactly the
 * condition under which {@link resolveAllowedTables} reads the org whitelist
 * (`orgId` present AND an internal DB exists). Exposed so callers gate their
 * column source on the SAME predicate the whitelist resolution uses, keeping
 * the advertised tables and their columns on one consistent source.
 */
export function shouldUseOrgSemanticMirror(orgId: string | undefined): boolean {
  return !!orgId && hasInternalDB();
}
