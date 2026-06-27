# `atlas login` device flow: a workspace-scoped CLI credential that key-scopes to `{orgId, role}` live

ADR-0025 establishes the **credential spine** for workspace self-service: a default human credential minted by `atlas login` via the OAuth 2.0 **device authorization grant** (RFC 8628, the `gh auth login` / `railway login` model), which resolves **live** to `{orgId, role}` through the same actor-resolution and governance rails the MCP uses, and is audited as `origin=cli`. This is the HITL **key-scoping** grill point: how a portable, file-stored credential maps to exactly one workspace at exactly the caller's role, and how role/membership changes clear immediately. Decided in the grill of issue #4043; this slice is the tracer the rest of the ADR-0025 surface depends on.

## Foundation

Atlas already runs Better Auth's `@better-auth/oauth-provider` (auth-code + PKCE + DCR) but has **no device grant**. This slice adds Better Auth's `deviceAuthorization` plugin + the `/device_authorization` endpoint and the matching `.well-known` metadata. The CLI prints a user code + verification URL, the human approves in a browser, the CLI polls the token endpoint, and stores the bearer in `~/.atlas/credentials`. Storing it in a standard location is deliberate: it lets in-session agents inherit the grant (ambient reuse), the same way `gh`/`railway` tokens are picked up.

## The decisive credential-class fact

Better Auth's `deviceAuthorization` `/device/token` returns a **session-class access token** — one accepted by `auth.api.getSession({ headers })` via the `bearer()` plugin, **not** an `oauthProvider` JWT verified by `verifyAccessToken`. Two consequences shaped every decision below:

1. **The tracer rides existing rails.** The bearer authenticates to the workspace-safe read endpoint (`GET /api/v1/semantic/entities`, `standardAuth` → `validateManaged` → `getSession`) with **zero new bearer-verification code**. `getSession` already resolves `{userId, role, activeOrganizationId}` live per request.
2. **Vanilla `getSession` resolves the *user-level* role.** `managed.ts` reads `effectiveRole` (stamped by `customSession` via `resolveEffectiveRole(user.role, member.role)`), so a `platform_admin` user's session-class bearer would resolve to `platform_admin`. Left unchecked, a portable CLI bearer would carry cross-tenant god-mode. The key-scoping decisions exist to close exactly this gap.

## Decisions

### 1. Trust boundary — `cli` is org-role-only, withholding `platform_admin`, **always**

`cli` becomes a third `McpTransportTrust` member alongside `stdio` and `hosted`. It resolves the **org (member) role only** for its bound workspace and passes `undefined` for the user-level role to `resolveEffectiveRole` — mirroring the `hosted` arm (ADR-0016 §`platform_admin`) — **regardless of deploy mode**. A `cli` credential is a portable file on disk: an exfiltration surface. Auto-applying `platform_admin` to it would be a privilege-escalation vector even on self-hosted, where the local stdio binary is trusted but a copied-off credential file is not. The credential's authority is exactly the caller's org role for exactly one workspace — never more.

### 2. Enforcement point — stamp `origin=cli`, downgrade the role in managed-auth, **now**

The device flow stamps the session as `origin=cli`. The managed-auth role-resolution path gains **one** branch: when the session is `origin=cli`, resolve the effective role org-role-only (`resolveEffectiveRole(undefined, userId, orgId)`), withholding `platform_admin`, and stamp `origin=cli` for audit. This is implemented in **this** spine slice (not deferred), pinned by a unit test proving a `platform_admin` user's cli token resolves to its org role. `/semantic/entities` is read-only and non-admin-gated, so the downgrade is invisible to the tracer command itself — but baking it in from day one means no interim slice inherits the escalation surface decision 1 rejects.

### 3. OAuth client model — one shared public `client_id`

`atlas login` ships **one** well-known public `client_id` for the Atlas CLI (the `gh`/`railway` model), not per-login Dynamic Client Registration. The consequence for revocation is explicit: the `oauth_client_workspace_grants` row is keyed `(clientId, orgId)` and is therefore **shared** across all CLI logins to a workspace — so it is **not** the per-user revocation lever (deleting it would revoke every user's CLI access at once).

### 4. Revocation — role/membership is immediate; per-credential revocation is TTL-bounded

The honest decomposition of "revocation-immediate":

- **Role change / membership removal → genuinely immediate.** The live `member`-table lookup on each request reflects it on the next call. This is the real, shippable immediacy guarantee.
- **Revoking one specific credential without touching membership → bounded by the access-token TTL.** `cli` tokens reuse the existing 1h `oauthProvider` access TTL (`ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS`, default 3600s); the refresh token (7d) is what `atlas login` persists and is revocable to stop renewal. The JWT stays signature-valid until expiry, so true *instant* per-credential revocation is **deferred to a token-denylist slice**; until it lands, the window is ≤1h.

This is why the acceptance criterion is reworded to claim immediacy only for role/membership and an explicit ≤1h bound for token-level revocation — the spine must not over-claim.

### 5. Gate-chain admission + origin ceiling — proven by tests, not by the read tracer

The MCP dispatch gate chain (billing → action-policy → RBAC → approval) fires only on MCP **tool dispatch**; a read of `/semantic/entities` never invokes it. So:

- The **read tracer** proves live `{orgId, role}` resolution + **workspace isolation** (login A returns data for only its workspace; a second login B sees only its own).
- **Gate-chain admission + the origin ceiling for `origin=cli`** are proven by focused tests: the new `cli` arm of `resolveMcpActorRole`; the `origin=cli` enum value plus both `origin IN (...)` CHECK constraints; and a dispatch-gate unit test that a `cli` actor clears RBAC at its org role and is subject to approval exactly like `origin=mcp`. The **origin ceiling holds**: `origin=cli` can *tighten* (governance scoped to `cli` or `any` applies) but never *lower* governance, and it carries no authority the bound org role doesn't grant.

### 6. Workspace binding — single-workspace auto-binds; multi-workspace is a clear handoff

Better Auth's `/device/token` issues a **fresh session** (`internalAdapter.createSession(userId)`) with no `activeOrganizationId`. Atlas's existing `session.create.before` hook already auto-binds the active org **when the user belongs to exactly one org** — so a single-workspace user's device session is correctly scoped to their only workspace with zero new code. Multi-workspace users get a device session with **no** active org; the minimal `atlas` command returns a clear error (*"multiple workspaces — workspace selection ships in the picker slice"*), the named handoff. This deliberately **narrows** the original "bind current active workspace" intent: threading the approving web session's active org onto a *fresh* device session is not natively supported by the plugin (the device-code record stores only `userId`), so multi-workspace binding belongs with the picker slice rather than being half-built into the spine. Binding to many workspaces at once (the plural `workspace_ids` claim) is rejected outright: a credential reaching every workspace the user belongs to weakens key-scoping — one stolen bearer would reach them all.

## Mechanism — how `origin=cli` and the workspace get stamped

Better Auth's device plugin issues a plain session, so the spine stamps the two key-scoping properties at session-creation:

- **`origin=cli`**: an `origin` **session `additionalField`** (default `null`) carries the marker. Atlas's existing `session.create.before` hook is extended to take `(session, ctx)`; when `ctx.request?.url` is the `/device/token` endpoint, it stamps `origin: "cli"` onto the new session row. The marker lives on the session row, so managed-auth role-resolution (decision 2), audit, and revocation all read **one** field. Rejected alternatives: a custom `/device/token` proxy (more surface, couples to plugin internals) and a token *scope* marker (device tokens are session tokens, not scoped JWTs — there is no scope to read).
- **workspace**: the existing single-org auto-bind hook (decision 6) — no new mechanism.

## Two hard invariants (inherited from ADR-0016, extended to `cli`)

- **The credential's authority is its org role for its bound workspace — never the transport, never the user-level role.** A `cli` bearer is permanently `platform_admin`-incapable by construction (decisions 1–2), the same way the stdio trusted actor is admin-incapable.
- **Origin ceiling.** `origin=cli` may act only within its org role and may never lower governance; admin-configured governance can tighten `cli` but `cli` can never loosen it.

## Storage

`~/.atlas/credentials` is a JSON file written `0600` holding the access token, refresh token, bound `workspace_id`, and expiry. The CLI refreshes silently via the refresh token; a `cli` access token never appears in agent/LLM context.

## Consequences

- `origin=cli` is added to the agent-origin enum (ADR-0015); the two `origin IN (...)` CHECK constraints (`schema.ts`) gain `'cli'` with the migration mirrored into `schema.ts` in the same PR (Drizzle discipline). Widening a CHECK with a new allowed value is expand-only, so it is single-release-safe.
- A **token-denylist slice** is now a tracked follow-up — it is the only thing standing between "role/membership-immediate" and "per-credential-instant" revocation.
- A **multi-workspace selection slice** (in-flow workspace picker) is the named handoff from decision 6.

## Status

accepted — tracer slice (#4043). Subsequent ADR-0025 surface (denylist, workspace picker, additional `atlas` commands) builds on this spine.
