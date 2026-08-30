# MCP & agent governance

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## MCP & agent governance` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


The MCP server runs the same agent tools as the chat app, so the same governance (RBAC, approval rules, audit) must apply. These terms pin *who* is acting and *through what channel*.

- **MCP actor** — the identity an MCP request is attributed to and authorized as. Three kinds: *governed* (bound to a real user + org via `ATLAS_MCP_USER_ID` / `ATLAS_MCP_ORG_ID`), *trusted* (synthetic `system:mcp`, carrying no real identity), and *hosted* (resolved per OAuth bearer).
  _Avoid_: "MCP user" (the trusted actor is not a user).

- **Anonymous onboarding caller** — the identity-less entry point for self-serve signup over MCP. It is **not** an MCP actor (it carries no identity, governed/trusted/hosted) and is structurally incapable of reaching the dispatch gate pipeline. It can invoke exactly one tool (`start_trial`) on a separate, pre-auth registration path; that call *produces* a real user + Workspace, after which a normal *hosted* actor takes over via the OAuth/DCR connect. The single, audited pre-actor carve-out — never a fourth actor kind, never a `system:mcp` (*trusted*) fallback.
  _Avoid_: modeling it as a degenerate *trusted* actor (`system:mcp` is the operator's own process, a different boundary); "anonymous actor" (it is precisely *not* an actor).

- **Claim (an unclaimed Workspace)** — a Workspace provisioned over MCP by the *anonymous onboarding caller* exists **unclaimed** until a human comes to the web and completes the OTP interstitial (verify email via emailOTP — Atlas never uses magic links — set a credential/passkey, accept ToS). Claiming flips the trial from **metered** (token spend withheld so the agent won't answer data questions on Atlas's tokens; setup — datasource connect, semantic layer — is fully allowed) to **full** (normal `trial` token budget). The meter is a clamp on the token budget keyed on `emailVerified`, not a plan tier. Distinct from **solvency** (Gate 0): an *expired* trial is blocked on every surface including MCP by Gate 0, regardless of claim state or token budget. Both axes have one code home — `packages/api/src/lib/billing/trial-state.ts` (#4127: composite `deriveTrialState`; Gate 0 and the reaper's SQL consume its primitives/fragments) — and the Gate-0-before-claim ordering on the headless Atlas-token path is encoded in `checkAgentQueryGates` (`billing/agent-query-gates.ts`, #4128).
  _Avoid_: conflating *metered/full* (pre/post-claim token clamp) with *trial-expired/solvent* (Gate 0); calling an unclaimed Workspace a "draft" (that term is the content-mode status enum).

- **Agent origin** — the invocation channel a query or mutation reached the agent through: `chat` / `mcp` / `scheduler` / `slack`. Approval rules match on it and the audit log records it. See [ADR-0015](../../adr/0015-agent-origin-not-surface.md).
  _Avoid_: "approval surface" and bare "surface" (reserved for the pillar admin page); "source" (a deprecated alias for Connection group); conflating with **[Lead source](../lead-source/CONTEXT.md)** — agent origin is about *agent traffic* (approval/audit), lead source is about *CRM acquisition* (marketing attribution). Both can say "mcp"; they are different concepts.
