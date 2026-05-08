/**
 * Surface-scoping match predicate for approval rules (#2072).
 *
 * The DB-side filter in `ee/governance/approval.ts` uses
 *   WHERE org_id = $1 AND enabled = true AND (surface = 'any' OR surface = $2)
 * with `$2` set to the request's surface (or NULL when unknown). This file
 * exists so the same matching contract lives in code we can unit-test
 * directly without a DB mock — and so post-fetch filtering (defense in
 * depth) shares one source of truth with the SQL filter.
 *
 * Semantics:
 *   - `surface = 'any'` rule  →  fires for every request (preserves
 *     pre-2072 behavior; this is the migration default).
 *   - `surface = '<value>'` rule  →  fires only when the request stamped
 *     that exact surface on its RequestContext.
 *   - Unknown request surface  →  only `'any'` rules match. A rule pinned
 *     to a surface (e.g. `'mcp'`) does NOT match an unknown-surface
 *     request — fail-closed so a route that forgets to stamp surface
 *     can't accidentally trip surface-scoped rules.
 */

import {
  APPROVAL_RULE_SURFACES,
  REQUEST_SURFACES,
  type ApprovalRuleSurface,
  type RequestSurface,
} from "./types";

export { APPROVAL_RULE_SURFACES, REQUEST_SURFACES };
export type { ApprovalRuleSurface, RequestSurface };

/**
 * True when a rule with `ruleSurface` matches a request originating from
 * `requestSurface`. See module-level comment for the matching contract.
 */
export function surfaceMatchesRule(
  ruleSurface: ApprovalRuleSurface,
  requestSurface: RequestSurface | undefined,
): boolean {
  if (ruleSurface === "any") return true;
  return ruleSurface === requestSurface;
}

/**
 * Filter an in-memory rule array by surface. Mirrors the SQL-side filter
 * exactly so callers can post-verify or test the matching without
 * round-tripping the DB.
 */
export function selectMatchingRulesBySurface<T extends { surface: ApprovalRuleSurface }>(
  rules: readonly T[],
  requestSurface: RequestSurface | undefined,
): T[] {
  return rules.filter((rule) => surfaceMatchesRule(rule.surface, requestSurface));
}
