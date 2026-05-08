/**
 * Surface-scoping helpers for approval rules (#2072).
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
  APPROVAL_RULE_SURFACES,
  APPROVAL_REQUEST_SURFACES,
  type ApprovalRuleSurface,
  type ApprovalRequestSurface,
} from "@useatlas/types";

export {
  APPROVAL_RULE_SURFACES,
  APPROVAL_REQUEST_SURFACES,
  type ApprovalRuleSurface,
  type ApprovalRequestSurface,
};

/**
 * Aliases for in-package consumers (`evaluate.ts`) that prefer the
 * shorter names. Anyone reading `evaluate.ts` is already inside the
 * approval-rules namespace; the prefix is redundant noise there.
 */
export const REQUEST_SURFACES = APPROVAL_REQUEST_SURFACES;
export type RequestSurface = ApprovalRequestSurface;

export function isApprovalRuleSurface(value: string): value is ApprovalRuleSurface {
  return (APPROVAL_RULE_SURFACES as readonly string[]).includes(value);
}

export function isRequestSurface(value: string): value is ApprovalRequestSurface {
  return (APPROVAL_REQUEST_SURFACES as readonly string[]).includes(value);
}
