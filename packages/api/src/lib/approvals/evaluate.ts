/**
 * Origin-scoping match predicate for approval rules (#2072; "surface"
 * renamed to "origin" in ADR-0015).
 *
 * The DB-side filter in `ee/governance/approval.ts` uses
 *   WHERE org_id = $1 AND enabled = true AND (origin = 'any' OR origin = $2)
 * with `$2` set to the request's origin (or NULL when unknown). This file
 * exists so the same matching contract lives in code we can unit-test
 * directly without a DB mock — and so post-fetch filtering (defense in
 * depth) shares one source of truth with the SQL filter.
 *
 * Semantics:
 *   - `origin = 'any'` rule  →  fires for every request (preserves
 *     pre-2072 behavior; this is the migration default).
 *   - `origin = '<value>'` rule  →  fires only when the request stamped
 *     that exact origin on its RequestContext.
 *   - Unknown request origin  →  only `'any'` rules match. A rule pinned
 *     to a specific origin (e.g. `'mcp'`) does NOT match an unknown-
 *     origin request. This is *scope isolation*, not the F-54/F-55
 *     governance fail-closed: if a route forgets to stamp an origin, an
 *     `'any'` rule still fires (so governance is preserved); only the
 *     origin-scoped rules become dormant for that caller. The true
 *     governance fail-closed lives in `checkApprovalRequired`'s
 *     `identityMissing` path.
 */

import {
  APPROVAL_RULE_ORIGINS,
  REQUEST_ORIGINS,
  type ApprovalRuleOrigin,
  type RequestOrigin,
} from "./types";

export { APPROVAL_RULE_ORIGINS, REQUEST_ORIGINS };
export type { ApprovalRuleOrigin, RequestOrigin };

/**
 * True when a rule with `ruleOrigin` matches a request originating from
 * `requestOrigin`. See module-level comment for the matching contract.
 */
export function originMatchesRule(
  ruleOrigin: ApprovalRuleOrigin,
  requestOrigin: RequestOrigin | undefined,
): boolean {
  if (ruleOrigin === "any") return true;
  return ruleOrigin === requestOrigin;
}

/**
 * Filter an in-memory rule array by origin. Mirrors the SQL-side filter
 * exactly so callers can post-verify or test the matching without
 * round-tripping the DB.
 */
export function selectMatchingRulesByOrigin<T extends { origin: ApprovalRuleOrigin }>(
  rules: readonly T[],
  requestOrigin: RequestOrigin | undefined,
): T[] {
  return rules.filter((rule) => originMatchesRule(rule.origin, requestOrigin));
}
