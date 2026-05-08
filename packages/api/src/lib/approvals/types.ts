/**
 * Surface-scoping type definitions for approval rules (#2072).
 *
 * Two related but distinct surface enums:
 *
 *   - `APPROVAL_RULE_SURFACES` — values an admin can pin a rule to. Includes
 *     `'any'` so an admin can author "fires regardless of origin" (the
 *     pre-2072 default behavior).
 *   - `REQUEST_SURFACES` — what the agent's call site stamps on the
 *     `RequestContext` to identify where a query came from. No `'any'` —
 *     an actual request always originated from a single surface.
 *
 * The two enums are linked by an exhaustiveness test in
 * `__tests__/evaluate.test.ts`: every `REQUEST_SURFACES` value must
 * appear in `APPROVAL_RULE_SURFACES`. If a new request surface lands
 * (e.g. a new chat-platform receiver) without a matching rule-side entry,
 * surface-scoped rules for it cannot be authored — the test fails so the
 * schema / migration / type drift is caught at the test layer instead of
 * silently regressing governance UX.
 */

export const APPROVAL_RULE_SURFACES = [
  "any",
  "chat",
  "mcp",
  "scheduler",
  "slack",
  "teams",
  "webhook",
] as const;
export type ApprovalRuleSurface = (typeof APPROVAL_RULE_SURFACES)[number];

export const REQUEST_SURFACES = [
  "chat",
  "mcp",
  "scheduler",
  "slack",
  "teams",
  "webhook",
] as const;
export type RequestSurface = (typeof REQUEST_SURFACES)[number];

export function isApprovalRuleSurface(value: string): value is ApprovalRuleSurface {
  return (APPROVAL_RULE_SURFACES as readonly string[]).includes(value);
}

export function isRequestSurface(value: string): value is RequestSurface {
  return (REQUEST_SURFACES as readonly string[]).includes(value);
}
