# MCP & agent governance

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## MCP & agent governance` section, moved with two mechanical edits:
> relative links repathed for the new depth, and same-file "see below" pointers whose
> targets left rewritten as links to the context that now holds them. It is no longer
> in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


The MCP server runs the same agent tools as the chat app, so the same governance (RBAC, approval rules, audit) must apply. These terms pin *who* is acting and *through what channel*.

- **MCP actor** — the identity an MCP request is attributed to and authorized as. Three kinds: *governed* (bound to a real user + org via `ATLAS_MCP_USER_ID` / `ATLAS_MCP_ORG_ID`), *trusted* (synthetic `system:mcp`, carrying no real identity), and *hosted* (resolved per OAuth bearer).
  _Avoid_: "MCP user" (the trusted actor is not a user).

- **Anonymous onboarding caller** — the identity-less entry point for self-serve signup over MCP. It is **not** an MCP actor (it carries no identity, governed/trusted/hosted) and is structurally incapable of reaching the dispatch gate pipeline. It can invoke exactly one tool (`start_trial`) on a separate, pre-auth registration path; that call *produces* a real user + Workspace, after which a normal *hosted* actor takes over via the OAuth/DCR connect. The single, audited pre-actor carve-out — never a fourth actor kind, never a `system:mcp` (*trusted*) fallback.
  _Avoid_: modeling it as a degenerate *trusted* actor (`system:mcp` is the operator's own process, a different boundary); "anonymous actor" (it is precisely *not* an actor).

- **Anonymous demo principal** — the identity the hosted MCP demo door (`/mcp/demo`, #5604) binds: a *minted* principal — one row in `demo_anonymous_sessions`, its id carried in a signed demo token — rather than an email or an OAuth subject. It **is** an MCP actor, of the *hosted* kind: it is identity-bearing, it is bound to exactly one Workspace (the demo workspace, resolved by slug from the settings registry, never from the request), and every tool it calls runs the full dispatch gate as a `member` carrying `mcp:read`. What makes it *anonymous* is only that nothing about the human is known — not that it escapes the actor model. Its reach is a strict subset of the email demo's: `searchAtlas`, `executeSQL`, and the optional `shareEmail` hand-off, which is refused until the session has received its first answer. It is the *second* pre-OAuth mount after the anonymous onboarding caller, and the two are opposites: the onboarding caller has no identity and reaches one provisioning tool outside the gate; the demo principal has a minted identity and reaches two read tools inside it.
  _Avoid_: "anonymous actor" for the *onboarding caller* (that one is precisely not an actor; this one is); "demo user" (there is no user — the email demo's `demo:<hash>` is a user id, this is a session id); a fourth actor kind (it is a hosted actor with a demo bearer instead of an OAuth one); treating it as *trusted* (`system:mcp` is the operator's own process).

- **Claim (an unclaimed Workspace)** — a Workspace provisioned over MCP by the *anonymous onboarding caller* exists **unclaimed** until a human comes to the web and completes the OTP interstitial (verify email via emailOTP — Atlas never uses magic links — set a credential/passkey, accept ToS). Claiming flips the trial from **metered** (token spend withheld so the agent won't answer data questions on Atlas's tokens; setup — datasource connect, semantic layer — is fully allowed) to **full** (normal `trial` token budget). The meter is a clamp on the token budget keyed on `emailVerified`, not a plan tier. Distinct from **solvency** (Gate 0): an *expired* trial is blocked on every surface including MCP by Gate 0, regardless of claim state or token budget. Both axes have one code home — `packages/api/src/lib/billing/trial-state.ts` (#4127: composite `deriveTrialState`; Gate 0 and the reaper's SQL consume its primitives/fragments) — and the Gate-0-before-claim ordering on the headless Atlas-token path is encoded in `checkAgentQueryGates` (`billing/agent-query-gates.ts`, #4128).
  _Avoid_: conflating *metered/full* (pre/post-claim token clamp) with *trial-expired/solvent* (Gate 0); calling an unclaimed Workspace a "draft" (that term is the content-mode status enum).

- **Agent origin** — the invocation channel a query or mutation reached the agent through: `chat` / `mcp` / `scheduler` / `slack`. Approval rules match on it and the audit log records it. See [ADR-0015](../../adr/0015-agent-origin-not-surface.md).
  _Avoid_: "approval surface" and bare "surface" (reserved for the pillar admin page); "source" (a deprecated alias for Connection group); conflating with **[Lead source](../lead-source/CONTEXT.md)** — agent origin is about *agent traffic* (approval/audit), lead source is about *CRM acquisition* (marketing attribution). Both can say "mcp"; they are different concepts.
