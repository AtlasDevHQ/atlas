# MCP V2 security model: RBAC-gated, origin-ceilinged, customer-governed config tools

MCP V2 lets an authorized agent *configure* Atlas (provision datasources, connect integrations, raise governance), not just query it. Allowing config mutations over an autonomous, prompt-injectable channel demanded an explicit, layered authorization model rather than extending V1's read-only assumptions. Decided in the grill of PRD #3483.

## Decision — the dispatch gate order

Every MCP tool dispatch passes a fixed gate order; a mutation must clear all of them:

1. **MCP action policy** (per-workspace kill-switch) — a customer admin can disable whole MCP action *categories* for their workspace from the dashboard; blocked categories short-circuit before anything else runs.
2. **`mcp:write` scope** (hosted only) — carried on the OAuth bearer, granted at consent. stdio has no third-party client, so no scope term applies there.
3. **RBAC role** — authority is the bound **MCP actor**'s role, resolved by a **live DB lookup at bearer-verify time** (mirroring the existing `member` / `oauth_client_workspace_grants` pattern), never from a token claim — so demotion/revocation takes effect immediately, not on token refresh.
4. **Approval flow** — destructive actions route through Atlas's existing approval gate, keyed on `origin=mcp`. The approval *policy* is a per-workspace customer-admin decision (default: approval required), never an operator one.
5. **Inline confirm** — the `destructiveHint` annotation (advisory, client-rendered) plus an elicitation confirm.

## Two hard invariants above the configurable layers

- **Origin ceiling (product invariant, configurable by no one):** MCP may *provision* resources and *raise* governance, but may **never lower** it — no tool that disables RLS, the table whitelist, an approval rule, PII masking, audit retention, plan tier, etc. exists for `origin=mcp`. "Lower" = disarming a control; "provision/raise" = adding a resource or tightening a control. Enforced **structurally** (the tool doesn't exist), so there is no hidden approval layer that can act without an RBAC identity.
- **RBAC is the only source of authority.** Authority is never a property of the transport. The stdio **trusted** actor (`system:mcp`, no identity) is therefore permanently admin-incapable; admin tools always register but only a real bound admin identity can clear gate 3.

## Credentials and plugin tools

Credentials are supplied via **masked form-mode elicitation** — elicitation responses travel client→server and never enter the agent/LLM context, which is the actual goal (keep the secret out of context), achieved without a per-credential URL round-trip. **URL-mode elicitation is reserved as a future step-up ("super approval") re-auth** for the highest-risk actions (maps to incremental scope consent, SEP-835). Plugin-contributed MCP tools are **first-class** under this model: a mutating plugin tool obeys the same gate order and carries `origin=mcp`.

## SaaS-first principle

Gate capability through runtime, per-identity / per-action mechanisms (scope, RBAC, DB-backed workspace policy) — never operator-only env vars or `atlas.config.ts`. The `ATLAS_DEPLOY_MODE` flag (SaaS-vs-self-host *infrastructure*) is fine; gating a *capability decision* behind env is the self-host-shape-into-SaaS leak that CONTEXT.md's "The seam" warns against. Design SaaS-first and self-host inherits it (it drops the third-party scope term, keeps RBAC + approval). The destructive-action decision belongs to the **customer admin**, not the operator.

## Foundation

Atlas already runs Better Auth's `@better-auth/oauth-provider` — the path Better Auth now recommends (its standalone `mcp` plugin is deprecated) — and `mcp:write` is already a declared scope, so V2 *flips an existing gate* rather than adding auth infrastructure. Verification stays on JWKS-based `verifyMcpBearer` (topology-independent, revocation-immediate via the grants table), not `withMcpAuth` (same-process only).

## Considered and rejected

- **Authority from the transport** (hosted-can-admin / stdio-cannot) — rejected; authority is RBAC, full stop.
- **Operator env flag to enable admin tools** (`ATLAS_MCP_ADMIN_TOOLS`) — rejected as a SaaS-seam leak; admin tools always register and are gated at dispatch.
- **Role stamped into the JWT** — rejected; goes stale until refresh. Live DB lookup instead.
- **Loopback HTTP proxy to the admin REST API** — rejected; credential-laundering surface + token-audience mismatch. Call the lib layer directly.
- **URL-mode elicitation for every credential** — rejected as a UX anti-pattern; masked form-mode keeps secrets out of the agent context without the round-trip. URL-mode survives only as future step-up.
