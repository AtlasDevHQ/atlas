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
}

/**
 * Resolve the mode-aware allowed-tables whitelist for an org + connection.
 *
 * Mirrors the resolution `validateSQL` performs (org-scoped vs file-scoped, raw
 * `atlasMode`, org branch keyed on `orgId` **and an internal DB**) so consumers
 * advertise exactly what the enforcement layer permits. Fails closed to an empty
 * set on an org-whitelist load *error* — never widening to the file whitelist —
 * to avoid leaking the whole DB schema across tenants.
 *
 * ⚠️ ORG **AND** INTERNAL DB, not org alone (#5122). The org whitelist is read
 * from `semantic_entities`; with no internal DB there is no such table, so
 * `loadOrgWhitelist` can only ever yield the empty set and the org branch
 * degrades to deny-all rather than failing closed on anything. That is not a
 * safety property — nothing is being withheld, because with no internal DB
 * there are no other tenants to withhold it from (orgs live in that same DB) —
 * it is simply the wrong source. The authored layer in that configuration is on
 * disk, which is exactly where `listEntities` and `describeEntity` already read
 * from under the identical `orgId && hasInternalDB()` gate
 * (`semantic-tools.ts:resolveEntity`). Keying this branch on `orgId` alone left
 * `executeSQL` refusing every table that its own sibling tools were advertising.
 *
 * This also removes the `onMissingOrgDB` knob that used to encode the
 * divergence: with all three surfaces on one gate, the schema diff's opt-in
 * "file" behaviour IS the shared behaviour, so there is nothing left to opt into.
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
