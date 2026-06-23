/**
 * Single source of truth for "which tables is this connection allowed to
 * query?" — the mode-aware, group-scoped whitelist set that the SQL validation
 * pipeline (`validateSQL` / `executeSQL`) enforces.
 *
 * Every read surface that wants to *show* the queryable table set — the public
 * `/api/v1/tables` endpoint (#3898) and the schema diff (`diff.ts`) — resolves
 * it through here so the advertised set can never drift from the enforced set
 * on the org / mode axes. Keeping one definition (rather than two hand-synced
 * copies) is what makes "advertised == enforced" structural.
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
  /**
   * What to do when an org is present but no internal DB is configured —
   * the one axis where the two consumers legitimately differ:
   *
   * - `"empty"` (default) — take the org branch and return whatever the org
   *   whitelist yields (empty when there's no DB). This is what `validateSQL`
   *   does (it branches on `orgId` alone), so the **enforcement-parity**
   *   consumers (`/api/v1/tables`) must use it or they advertise on-disk tables
   *   that `executeSQL` rejects (#3898).
   * - `"file"` — fall back to the file-based whitelist. The schema diff opts in:
   *   a self-hosted admin who set an org but runs without an internal DB and
   *   hand-edits YAML still gets a meaningful diff against the on-disk files.
   */
  onMissingOrgDB?: "empty" | "file";
}

/**
 * Resolve the mode-aware allowed-tables whitelist for an org + connection.
 *
 * Mirrors the resolution `validateSQL` performs (org-scoped vs file-scoped, raw
 * `atlasMode`, org branch keyed on `orgId` presence) so consumers advertise
 * exactly what the enforcement layer permits. Fails closed to an empty set on
 * an org-whitelist load error — never widening to the file whitelist — to avoid
 * leaking the whole DB schema across tenants.
 *
 * The `onMissingOrgDB` option governs the single corner where consumers diverge
 * (org set, no internal DB); see {@link AllowedTablesScope.onMissingOrgDB}.
 */
export async function resolveAllowedTables(
  connectionId: string,
  scope: AllowedTablesScope,
): Promise<Set<string>> {
  const { orgId, atlasMode, onMissingOrgDB = "empty" } = scope;
  if (orgId && (hasInternalDB() || onMissingOrgDB === "empty")) {
    try {
      // Matches validateSQL: loadOrgWhitelist is a no-op (returns empty) when no
      // internal DB exists, so the org branch fails closed rather than widening.
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
 * DB-backed mirror rather than the on-disk base root — i.e. when there is an
 * org AND an internal DB to mirror from. The COLUMN source (unlike whitelist
 * membership) has no enforcement-parity obligation, so it stays gated on the
 * DB's existence: with no internal DB the org mirror can't be built, so columns
 * come from the base root. Exposed so callers keep their column read on one
 * consistent predicate.
 */
export function shouldUseOrgSemanticMirror(orgId: string | undefined): boolean {
  return !!orgId && hasInternalDB();
}
