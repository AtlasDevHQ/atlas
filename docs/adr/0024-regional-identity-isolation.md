# ADR-0024: Residency isolates the whole workspace, identity included — each region is an independent stack, the process *is* the region

**Status:** Accepted
**Date:** 2026-06-25
**Milestone:** [v0.1.0 — Public Launch](https://github.com/AtlasDevHQ/atlas/milestone/74)
**Issues:** [#3967](https://github.com/AtlasDevHQ/atlas/issues/3967) (residency-routing defect, v0.1.0 blocker), found by [#3943](https://github.com/AtlasDevHQ/atlas/issues/3943) (`/verify-prod-signup`)
**See also:** [CONTEXT.md](../../CONTEXT.md) › "region" (Flagged ambiguities)

## Context

`/verify-prod-signup` on prod `v0.0.29` caught a data-residency violation (#3967): a signup that selects **Europe** or **Asia Pacific** is provisioned in — and served entirely from — the **US** region. The selected region's API (`api-eu` / `api-apac`) `401`s the user; `api.useatlas.dev` (US) serves all their traffic. For a product whose differentiator is regional residency, "Europe" in the picker that silently serves from the US is a launch-day compliance incident, not a cosmetic bug.

A static trace plus a grilling session (2026-06-25) found the root cause is **one architectural decision that was never actually made** — the codebase simultaneously encoded three mutually-inconsistent models:

1. **Infra is per-region-independent DBs.** Each regional API process (`api`, `api-eu`, `api-apac`) reads its *own* `DATABASE_URL` (`db/internal.ts`); `deploy/api/atlas.config.ts` gives each region its own `databaseUrl` (`ATLAS_REGION_EU_DB_URL`, …). There is no shared identity Postgres.
2. **But the identity plane was hard-wired to "global = US"** by a deliberate-but-undocumented convenience: the auth client is a module singleton pinned to `api.useatlas.dev` (`web/src/lib/auth/client.ts:56`, *"Auth always authenticates against the global API"*). So Better Auth writes `user`/`organization`/`member`/`session` to **US** regardless of the chosen region; `assign-region` then stamps `region='eu'` onto that US-resident `organization` row — a label on a row in the wrong country.
3. **And the cross-region migration moves the data plane only.** `exportWorkspaceBundle` (`lib/residency/export.ts`) exports conversations, messages, semantic entities, learned patterns, settings — **not** `user`/`organization`/`member`/`account`. The import endpoint (`api/routes/admin-migrate.ts`) takes an `orgId` that must *already exist* in the target region. The machinery quietly assumes identity is not region-bound.

The frontend compounded it with a **circular discovery** mechanism: the browser learns its regional host only by calling the **US** admin-settings endpoint (`use-deploy-mode.ts` → `setRegionalApiUrl`), which only works *because* the data is wrongly readable from US. Fix the backend (data in EU, US `401`s) and the discovery breaks — proving the two layers are coupled, not independent.

The decision had to be made deliberately, and the issue's acceptance criteria already demanded one reading: *"user rows physically reside in EU"* and *"`api.useatlas.dev` `401`s a non-US workspace."*

## Decision

**Residency isolates the entire workspace — its identity included.** Each region is a fully independent stack (its own internal DB + its own Better Auth instance); an EU workspace has **no row in the US DB**, and `api.useatlas.dev` genuinely `401`s it. Six sub-decisions, all confirmed in the 2026-06-25 grill:

### 1. Identity is regional, not a global control plane

The Better Auth tables (`user` / `organization` / `member` / `session` / `account`) for an EU workspace live in **EU**. This is "everything residency," not "data residency with a global account" — because Better Auth's tables *are* PII (name, email, credential hashes, the membership graph), so a global identity plane is a global PII store. The legal floor (GDPR permits US storage under the DPF/SCCs) is below the **product promise**; a DPO review post-Schrems II asks "where is the user table?" and "US" fails for a residency product.

### 2. The process *is* the region — delete the per-request routing layer

Region is a **deploy-time constant** (`ATLAS_API_REGION` + the process's own `DATABASE_URL`), never a per-request routing decision. `api-eu` boots against EU's DB and *every* row it touches is EU because there is no other DB in the process. This **deletes** `getRegionAwareConnection`, the `datasourceUrl`/`databaseUrl` routing in `resolveRegionDatabaseUrl`, the `region:${region}` connection registration, and the `connection.ts:2131` "internal DB routing not yet implemented" TODO. `ResidencyResolver` shrinks to "what region am I + the region→apiUrl map." (The deleted `datasourceUrl` branch was already dead in prod — no region sets it.)

### 3. Returning-user login = a stateless fan-out router, with a cookie fast-path

A returning user must resolve email→region *before* any session exists. A **region-agnostic edge front-door** (on `app.useatlas.dev`, so no regional API carries a dual global role) hashes the typed email and fans out an existence check (`sha256(lower(email))`) to every region's probe endpoint in parallel, routes to the hit (or presents a chooser if multiple), and the regional API sends the OTP. **Zero global storage** — the hash is transient per request; the only global thing is a stateless router. An `atlas_region` cookie short-circuits the fan-out on the common same-browser path.

### 4. Signup picks region before the first identity write

Order is **email → region → create-account-on-the-regional-API**. Email entry is not a write, so picking region before the first Better Auth write is satisfied; collecting email first also lets the front-door detect an existing account and divert to login. Selecting a region points the browser's API base at that region's `apiUrl` (persisted via the `atlas_region` cookie) so account, OTP, workspace, and connect all hit the regional API. `assign-region` collapses into stamping the ambient `ATLAS_API_REGION` at org creation.

### 5. Session cookies are host-only per region; no global SSO

Better Auth on `api-eu` sets a **host-only** `SameSite=Lax; Secure` cookie. `app.useatlas.dev` and `api-eu.useatlas.dev` share the registrable domain `useatlas.dev`, so the request is **same-site** (cross-origin) and the cookie is sent on credentialed fetches with `credentials: 'include'` + a CORS allowlist — no `SameSite=None`. Host-only means an EU session token is sent *only* to `api-eu` and never transits US/APAC infra. **Non-portability is the feature**: a parent-domain `.useatlas.dev` cookie would leak EU session tokens to US endpoints and is rejected.

### 6. A human's identity does not span regions — same email = two accounts

Under full isolation, `alice@corp.com` in EU and US are **two independent accounts** (separate `user.id`, separate credentials) tied only by the email string. The in-session workspace dropdown is region-scoped (it reads one region's `member` table); cross-region discovery is a **login-time** concern handled by the front-door chooser (§3). Switching regions re-authenticates against the other region. A smooth in-session switch (email-OTP step-up that mints a second host-only session) is a **later upgrade, not launch**.

## Considered options

- **Global identity plane (US) + regional data plane** — the model the code half-built by accident. Rejected: it stores regulated PII (name/email/credentials) in the US, breaking the residency promise the signup UI makes; it only "works" today because the data is mislocated.
- **Lift Better Auth up a level: one auth Postgres replicated across regions.** Rejected: Better Auth's tables *are* the PII, so "one auth DB" is "one PII store" — and replication *multiplies* the residency surface (EU PII now in US primary + EU + APAC replicas), the opposite of the goal. Single-primary replication also centralizes every login's `session` write into one region and races auth correctness against replica lag. "One Postgres" and "EU rows stay in EU" are mutually exclusive unless you adopt a geo-partitioned distributed-SQL engine (Cockroach/Yugabyte) — which is just this ADR's per-region homing in heavier packaging, not worth it at 3 regions pre-customer.
- **Externalize identity to a central IdP (OIDC/SAML).** The only clean path to a true single cross-region login. Deferred: reintroduces a central identity store and makes Atlas an OIDC RP — overkill for launch. Named as the future path *if* "one login across all regions" ever becomes a hard customer requirement.
- **Dark-launch US-only (flip EU/APAC `selectable: false`), ship regional identity post-launch.** Rejected by the maintainer: build it right while pre-customer — retrofitting identity-regionalization after real EU customers exist is the migration that actually hurts; the clean-break window (CONTEXT.md "Deployment posture") is the cheap time.

## Consequences

- **The backend fix is mostly subtractive; the frontend grows the real new surface.** Deleting the routing layer (§2) is small. The pre-auth routing + the fan-out login front-door (§3, §4) is the bounded-but-real work, and the meat of the release-checklist item.
- **"Same email = two accounts" is a deliberate, surfaced surprise.** A future reader (or a confused multi-region user) will trip on it; it is the direct consequence of "no global membership store" and is recorded here so nobody "fixes" it by centralizing identity. Per-region billing/trial state follows the same grain (each regional account bills independently — already per-org).
- **The circular frontend discovery dies.** `setRegionalApiUrl`-from-US-admin-settings (`use-deploy-mode.ts`) is replaced by region-known-at-signup (cookie) + the login front-door. The admin-settings `regionApiUrl` field becomes vestigial for routing.
- **Existing mislocated workspaces are throwaway only.** The sole EU/APAC rows in US today are `/verify-prod-signup` test accounts — torn down, not migrated. No production migration burden (clean-break window).
- **`@useatlas/types` / config stay the source of truth for the region map.** `deploy/api/atlas.config.ts` `residency.regions[region].apiUrl` is what the picker, the front-door, and the cookie fast-path consume; `DEPLOY_REGION_ROUTING` and `isRegionSelectable` are unaffected (staging stays `selectable: false`, `"local"`).
- **The login front-door is an account-existence oracle** (hashed, but it reveals "this email is registered, in region X"). Equivalent to any forgot-password flow; mitigate with rate-limiting, not by pretending the oracle isn't there.
