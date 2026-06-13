/**
 * Origin-scoping helpers for approval rules (#2072; "surface" renamed to
 * "origin" in ADR-0015).
 *
 * The canonical enums live in `@useatlas/types/approval` so the SQL
 * route layer, the wire schemas, the web admin types, and this module
 * all share a single source of truth — eliminating the four-copies
 * drift surface that PR #2191 review caught.
 *
 * The runtime guards live here (in @atlas/api) rather than in
 * @useatlas/types because they're consumers of the enum tuples and
 * @useatlas/types stays declaration-only.
 */

import {
  APPROVAL_RULE_ORIGINS,
  APPROVAL_REQUEST_ORIGINS,
  type ApprovalRuleOrigin,
  type ApprovalRequestOrigin,
} from "@useatlas/types";

export {
  APPROVAL_RULE_ORIGINS,
  APPROVAL_REQUEST_ORIGINS,
  type ApprovalRuleOrigin,
  type ApprovalRequestOrigin,
};

/**
 * Aliases for in-package consumers (`evaluate.ts`) that prefer the
 * shorter names. Anyone reading `evaluate.ts` is already inside the
 * approval-rules namespace; the prefix is redundant noise there.
 */
export const REQUEST_ORIGINS = APPROVAL_REQUEST_ORIGINS;
export type RequestOrigin = ApprovalRequestOrigin;

export function isApprovalRuleOrigin(value: string): value is ApprovalRuleOrigin {
  return (APPROVAL_RULE_ORIGINS as readonly string[]).includes(value);
}

export function isRequestOrigin(value: string): value is ApprovalRequestOrigin {
  return (APPROVAL_REQUEST_ORIGINS as readonly string[]).includes(value);
}
