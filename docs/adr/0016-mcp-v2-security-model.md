# MCP V2 security model: RBAC-gated, origin-ceilinged, customer-governed config tools

MCP V2 lets an authorized agent *configure* Atlas (provision datasources, connect integrations, raise governance), not just query it. Allowing config mutations over an autonomous, prompt-injectable channel demanded an explicit, layered authorization model rather than extending V1's read-only assumptions. Decided in the grill of PRD #3483.

## Decision — the dispatch gate order

Every MCP tool dispatch passes a fixed gate order; a mutation must clear all of them:

1. **MCP action policy** (per-workspace kill-switch) — a customer admin can disable whole MCP action *categories* for their workspace from the dashboard; blocked categories short-circuit before anything else runs.
2. **`mcp:write` scope** (hosted only) — carried on the OAuth bearer, granted at consent. stdio has no third-party client, so no scope term applies there.
3. **RBAC role** — authority is the bound **MCP actor**'s role, resolved by a **live DB lookup at bearer-verify time** (mirroring the existing `member` / `oauth_client_workspace_grants` pattern), never from a token claim — so demotion/revocation takes effect immediately, not on token refresh.
4. **Approval flow** — destructive actions route through Atlas's existing approval gate, keyed on `origin=mcp`. The approval *policy* is a per-workspace customer-admin decision (default: approval required), never an operator one.
5. **Inline confirm** — the `destructiveHint` annotation (advisory, client-rendered) plus an elicitation confirm.

A workspace-solvency **gate 0** (billing, #3437/#3570) sits *above* this security order: a suspended / trial-expired / plan-exhausted workspace must not reach a datasource regardless of role or scope, so it short-circuits before gate 1. It is not part of the security model proper (it answers "can this workspace transact at all?", not "is this caller authorized?"), but #3601 folds it into the **same** composer (`runMcpDispatchGate`) as an optional `checksBilling` requirement so there is ONE ordered chain — `0 billing → 1 action-policy → 2 scope → 3 RBAC → 4 approval → 5 confirm` — and a reader can answer "what is the full gate order for tool X" from X's single declarative requirement set, not from which file registered it. Metadata-only tools (`explore`, `listEntities`, …) omit `checksBilling`; query/mutation tools declare it. The security invariants 1–5 above are unchanged.

## Two hard invariants above the configurable layers

- **Origin ceiling (product invariant, configurable by no one):** MCP may *provision* resources and *raise* governance, but may **never lower** it — no tool that disables RLS, the table whitelist, an approval rule, PII masking, audit retention, plan tier, etc. exists for `origin=mcp`. "Lower" = disarming a control; "provision/raise" = adding a resource or tightening a control. Enforced **structurally** (the tool doesn't exist), so there is no hidden approval layer that can act without an RBAC identity.
- **RBAC is the only source of authority.** Authority is never a property of the transport. The stdio **trusted** actor (`system:mcp`, no identity) is therefore permanently admin-incapable; admin tools always register but only a real bound admin identity can clear gate 3.

## Credentials and plugin tools

Credentials are supplied via **masked form-mode elicitation** — elicitation responses travel client→server and never enter the agent/LLM context, which is the actual goal (keep the secret out of context), achieved without a per-credential URL round-trip. **URL-mode elicitation is reserved as a future step-up ("super approval") re-auth** for the highest-risk actions (maps to incremental scope consent, SEP-835). Plugin-contributed MCP tools are **first-class** under this model: a mutating plugin tool obeys the same gate order and carries `origin=mcp`.

## SaaS-first principle

Gate capability through runtime, per-identity / per-action mechanisms (scope, RBAC, DB-backed workspace policy) — never operator-only env vars or `atlas.config.ts`. The `ATLAS_DEPLOY_MODE` flag (SaaS-vs-self-host *infrastructure*) is fine; gating a *capability decision* behind env is the self-host-shape-into-SaaS leak that [Operator vs Customer](../contexts/operator-vs-customer/CONTEXT.md)'s "The seam" warns against. Design SaaS-first and self-host inherits it (it drops the third-party scope term, keeps RBAC + approval). The destructive-action decision belongs to the **customer admin**, not the operator.

## Foundation

Atlas already runs Better Auth's `@better-auth/oauth-provider` — the path Better Auth now recommends (its standalone `mcp` plugin is deprecated) — and `mcp:write` is already a declared scope, so V2 *flips an existing gate* rather than adding auth infrastructure. Verification stays on JWKS-based `verifyMcpBearer` (topology-independent, revocation-immediate via the grants table), not `withMcpAuth` (same-process only).

## `platform_admin` (user-level role) over hosted MCP — member/org-only by design

**Decision (#3522, follow-up from #3505): the hosted MCP edge resolves the *org* role only; a cross-tenant `platform_admin` is NOT auto-applied over a hosted OAuth MCP session.**

`#3505` resolves the hosted actor's effective **org** role LIVE from the `member` table at `bindFactoryContext` (`packages/mcp/src/hosted.ts`) and deliberately passes `undefined` for the user-level role to `resolveEffectiveRole`. So a hosted OAuth session acts with the caller's `member` role for the *admitted* workspace — never cross-tenant god-mode — even if the bound user is a `platform_admin`.

This diverges from **stdio**, where `loadActorUser` resolves the user-level role too (a `platform_admin` over stdio MCP gets `platform_admin`). The divergence is intentional and is the right boundary:

- **stdio** is the operator's own trusted local process, bound by env vars (`ATLAS_MCP_USER_ID`/`ATLAS_MCP_ORG_ID`) — the operator already controls the host.
- **hosted** is customer-facing OAuth. Auto-escalating a `platform_admin` to god-mode over a *customer's* workspace through an OAuth client would be a privilege-escalation surface: a third-party client granted `mcp:*` scopes by one workspace could act cross-tenant if the bound human happened to be Atlas staff. The transport must not widen authority beyond the admitted workspace.

This is a specialization of the **"RBAC is the only source of authority"** invariant: the *org* membership is the authority for a hosted session, resolved live (revocation-immediate). Should a future requirement genuinely need `platform_admin` to operate over hosted MCP, it must resolve the user-level role **LIVE from the `user` table** (never a token claim, per #3505) and pass it to `resolveEffectiveRole` with explicit fail-closed handling — not stamp it onto the bearer. **No code change ships with this decision** — it records the current (safer) boundary so it isn't re-litigated.

## Considered and rejected

- **Authority from the transport** (hosted-can-admin / stdio-cannot) — rejected; authority is RBAC, full stop.
- **Auto-applying `platform_admin` cross-tenant over hosted MCP** (#3522) — rejected; a hosted OAuth session acts with the caller's `member`/org role for the admitted workspace only. Auto-escalation to god-mode over a customer workspace via an OAuth client is a privilege-escalation surface. stdio (operator's own env-bound process) keeps the user-level role; hosted does not. See the section above.
- **Operator env flag to enable admin tools** (`ATLAS_MCP_ADMIN_TOOLS`) — rejected as a SaaS-seam leak; admin tools always register and are gated at dispatch.
- **Role stamped into the JWT** — rejected; goes stale until refresh. Live DB lookup instead.
- **Loopback HTTP proxy to the admin REST API** — rejected; credential-laundering surface + token-audience mismatch. Call the lib layer directly.
- **URL-mode elicitation for every credential** — rejected as a UX anti-pattern; masked form-mode keeps secrets out of the agent context without the round-trip. URL-mode survives only as future step-up.

## Note (2026-09-02, #5604): the anonymous demo principal is a hosted actor with a demo bearer, not a bypass

The MCP front door for the launch cycle answers before it asks for an email. That needed a demo principal that is not an email, and the question this note records is *where it sits in this ADR's model*. The answer: **inside it**. `/mcp/demo` (`packages/mcp/src/demo.ts`) verifies a signed anonymous demo token (minted by `POST /api/v1/demo/anonymous`, one row in `demo_anonymous_sessions` per minted identity), binds a `member`-role `AtlasUser` whose `activeOrganizationId` is the demo workspace — resolved by **slug** from the settings registry (`ATLAS_DEMO_WORKSPACE_SLUG`), never from the path or a header — and registers `searchAtlas` and `executeSQL` through the SAME `createMcpDispatch` every hosted tool uses, so gates 0–4 run unchanged. The token carries `mcp:read` only and a non-empty client id, so gate 2 denies every write exactly as it would for a mis-scoped OAuth client.

What is *added* around the gate, not instead of it: a per-IP and a per-minted-identity sliding window (both settings-registry budgets, `ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM` / `ATLAS_DEMO_ANON_RATE_LIMIT_RPM`) evaluated before every tool body; an answer counter that moves the optional, after-first-answer `shareEmail` hand-off; and three fail-closed refusals with a request id — unresolvable demo workspace (503), a token or session row pinned to a different workspace than the current resolution (403), and an MCP session driven by a bearer that did not create it (403). "Anonymous means less reach than the email demo, never more" holds structurally: the email demo runs the agent loop with its full default tool set; this door registers three tools.

**Considered and rejected:** widening the ADR-0018 *anonymous onboarding caller* to also serve reads — rejected, because that carve-out's whole safety is that it binds no actor and reaches no gate, and a read tool on it would be exactly the unauthenticated data path this ADR exists to forbid. A `system:mcp`-style *trusted* fallback — rejected; that is the operator's own process. Minting the token from an email after all — rejected; it is the gate the issue set out to remove.
