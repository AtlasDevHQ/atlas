# Atlas 1.2.3 — Security Audit

Milestone: **1.2.3 — Security Sweep** (#37)
Tracker: #1718
Branch: `security/1.2.3-phase-1-auth-audit`

This document is the rolling findings report for the 1.2.3 security sweep.
Each phase appends a section. P0/P1/P2 findings file their own GH issues;
P3s stay here for the cleanup tail.

---

## Phase 1 — Auth config + middleware coverage

**Status:** complete (2026-04-20)
**Scope:** Better Auth config (`packages/api/src/lib/auth/server.ts`) and
guard coverage on every route in `packages/api/src/api/routes/`.
**Issue:** #1720

### Better Auth config review

Source: `packages/api/src/lib/auth/server.ts`.

| Setting | Value | Status | Finding |
|---|---|---|---|
| `secret` required, min length 32 | enforced at `getAuthInstance()` | ok | — |
| `emailAndPassword.enabled` | `true` | ok | — |
| `emailAndPassword.requireEmailVerification` | `false` | finding | See F-05 — pairs with bootstrap-admin race |
| `emailAndPassword.autoSignIn` | `true` | finding | Bootstrap race accelerator (F-02) |
| `session.expiresIn` | `7 days` | finding | See F-10 — no absolute admin cap |
| `session.updateAge` | `1 day` rolling | ok | Standard rolling window |
| `session.cookieCache.enabled` | `true` | finding | See F-07 — delays revocation 5 min |
| `session.cookieCache.maxAge` | `5 minutes` | finding | Same as above |
| `advanced.defaultCookieAttributes.domain` | parent domain when `ATLAS_CORS_ORIGIN` set | ok | — |
| `advanced.defaultCookieAttributes.secure` | Better Auth default (prod = true) | ok, verify | Relies on NODE_ENV + baseURL scheme |
| `advanced.defaultCookieAttributes.httpOnly` | Better Auth default (true) | ok | — |
| `advanced.defaultCookieAttributes.sameSite` | Better Auth default (`lax`) | ok | — |
| `trustedOrigins` | from `BETTER_AUTH_TRUSTED_ORIGINS` env | ok | Empty default is safe-by-default |
| `plugins: bearer()` | enabled | ok | Session token bearer — relies on cookie cache for perf |
| `plugins: apiKey()` | enabled | ok | @better-auth/api-key |
| `plugins: admin(...)` | adminAccessControl + admin/platform_admin roles | ok | — |
| `plugins: organization(...)` | owner/admin/member roles | ok | — |
| `plugins: scim(...)` | enterprise-only, admin role gate in `beforeSCIMTokenGenerated` | ok | — |
| `plugins: stripe(...)` | gated behind `STRIPE_SECRET_KEY` | ok | Webhook secret required |
| `socialProviders` | google/github/microsoft when env present | ok | — |
| `databaseHooks.user.create.before` | promotes first signup / `ATLAS_ADMIN_EMAIL` to `platform_admin` | finding | F-02 — bootstrap race |
| `databaseHooks.user.create.after` | welcome email + SSO auto-provision | ok | — |
| `databaseHooks.member.create.after` | auto-promote org owner to user-level `admin` | ok | No audit row but not a direct exploit |
| `databaseHooks.session.create.before` | auto-set active org when single-membership | ok | — |
| `databaseHooks.session.create.after` | emit login metering event | ok | — |
| Rate limiting | Better Auth built-in defaults; not explicitly configured | finding | See F-06 — no visible Hono-layer override, audit defaults |

### Middleware + guard coverage

Routes live under `packages/api/src/api/routes/`. Mount points in
`packages/api/src/api/index.ts`. Each router applies middleware at the
app level via `.use()` before route handlers.

Guards:
- `adminAuth` / `adminAuthAndContext` / `adminAuthPreamble` — authenticated + role ∈ {admin, owner, platform_admin}
- `platformAdminAuth` — authenticated + role = platform_admin
- `standardAuth` / `authPreamble` — authenticated, any role
- `withRequestId` — no auth; only request context (explicitly public handlers own their auth inline)

| File | Mount | Guard | Notes | Status |
|---|---|---|---|---|
| `actions.ts` | `/api/v1/actions` | `standardAuth` | lines 370-371 | ok |
| `admin.ts` | `/api/v1/admin` | `withRequestId` + per-handler `adminAuthAndContext` | Hybrid pattern (inline auth per handler because of sub-router middleware constraints) | ok, see note |
| `admin-abuse.ts` | `/api/v1/admin/abuse` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-actions.ts` | `/api/v1/admin/admin-actions` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-approval.ts` | `/api/v1/admin/approval` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-archive.ts` | `/api/v1/admin/archive-connection` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-audit.ts` | `/api/v1/admin/audit` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-audit-retention.ts` | `/api/v1/admin/audit/retention` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-branding.ts` | `/api/v1/admin/branding` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-cache.ts` | `/api/v1/admin/cache` | `createPlatformRouter` | Platform-admin gated | ok |
| `admin-compliance.ts` | `/api/v1/admin/compliance` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-connections.ts` | `/api/v1/admin/connections` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-domains.ts` | `/api/v1/admin/domain` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-email-provider.ts` | `/api/v1/admin/email-provider` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-integrations.ts` | `/api/v1/admin/integrations` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-invitations.ts` | `/api/v1/admin/*` invitation subset | `adminAuthAndContext` callback | registered directly on admin router | ok |
| `admin-ip-allowlist.ts` | `/api/v1/admin/ip-allowlist` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-learned-patterns.ts` | `/api/v1/admin/learned-patterns` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-marketplace.ts` | `/api/v1/admin/plugins/marketplace` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-marketplace.ts` | `/api/v1/platform/plugins/catalog` | `createPlatformRouter` | | ok |
| `admin-migrate.ts` | `/api/v1/admin/migrate` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-migrate.ts` | `/api/v1/internal/migrate/import` | `ATLAS_INTERNAL_SECRET` timing-safe header | Service-to-service | ok |
| `admin-model-config.ts` | `/api/v1/admin/model-config` | `createAdminRouter` | | ok |
| `admin-onboarding-emails.ts` | `/api/v1/admin/onboarding-emails` | `createAdminRouter` | | ok |
| `admin-orgs.ts` | `/api/v1/admin/organizations` | `createAdminRouter` | | ok |
| `admin-plugins.ts` | `/api/v1/admin/plugins` | `createPlatformRouter` | | ok |
| `admin-prompts.ts` | `/api/v1/admin/prompts` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-publish.ts` | `/api/v1/admin/publish` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-residency.ts` | `/api/v1/admin/residency` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-roles.ts` | `/api/v1/admin/roles` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-sandbox.ts` | `/api/v1/admin/sandbox` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-scim.ts` | `/api/v1/admin/scim` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-semantic.ts` | `/api/v1/admin/semantic/*` | `adminAuthAndContext` callback | Registered directly on admin router | ok |
| `admin-semantic-improve.ts` | `/api/v1/admin/semantic-improve` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-sessions.ts` | `/api/v1/admin/sessions` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-sso.ts` | `/api/v1/admin/sso` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-starter-prompts.ts` | `/api/v1/admin/starter-prompts` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-suggestions.ts` | `/api/v1/admin/suggestions` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-tokens.ts` | `/api/v1/admin/tokens` | `createAdminRouter` + `requireOrgContext` | | ok |
| `admin-usage.ts` | `/api/v1/admin/usage` | `createAdminRouter` + `requireOrgContext` | | ok |
| `auth.ts` | `/api/auth/*` | Better Auth catch-all | delegate to Better Auth handler | ok |
| `billing.ts` | `/api/v1/billing` | `adminAuth` | | ok |
| `chat.ts` | `/api/v1/chat` | `withRequestId` + inline `authenticateRequest` | Effect-based handler | ok |
| `conversations.ts` (private) | `/api/v1/conversations` | `standardAuth` | | ok |
| `conversations.ts` (public) | `/api/public/conversations/:token` | `withRequestId` + rate limit + inline auth when `shareMode === "org"` | **F-01 — missing org-membership check** | finding |
| `dashboards.ts` (private) | `/api/v1/dashboards` | `createAdminRouter` + `requireOrgContext` | Uses `authed` sub-router | ok |
| `dashboards.ts` (public) | `/api/public/dashboards/:token` | `withRequestId` + rate limit + inline org-membership check | | ok |
| `demo.ts` | `/api/v1/demo` | `withRequestId` + per-handler signed demo token | public, IP-rate-limited, email gate | ok, gated by ATLAS_DEMO_ENABLED |
| `discord.ts` | `/api/v1/discord/install` + `/callback` | none (public) | **F-04 — no auth gate on install** | finding |
| `health.ts` | `/api/health` | none (public) | Intentionally public, no secrets in response | ok |
| `mode.ts` | `/api/v1/mode` | `standardAuth` | | ok |
| `onboarding.ts` | `/api/v1/onboarding/test-connection`, `/complete`, `/use-demo`, `/tour-status`, `/tour-complete`, `/tour-reset`, `/regions`, `/assign-region` | `standardAuth` | All sub-routes explicitly guarded | ok |
| `onboarding-emails.ts` | `/api/v1/onboarding-emails/unsubscribe`, `/resubscribe` | none (public) | **F-03 — userId param is an unsigned bearer** | finding |
| `openapi.ts` | none (static export) | n/a | Schema merged into `/api/v1/openapi.json` | ok |
| `platform-actions.ts` | `/api/v1/platform/actions` | `createPlatformRouter` | platform_admin | ok |
| `platform-admin.ts` | `/api/v1/platform` | `createPlatformRouter` | | ok |
| `platform-backups.ts` | `/api/v1/platform/backups` | `createPlatformRouter` | | ok |
| `platform-domains.ts` | `/api/v1/platform/domains` | `createPlatformRouter` | | ok |
| `platform-residency.ts` | `/api/v1/platform/residency` | `createPlatformRouter` | | ok |
| `platform-sla.ts` | `/api/v1/platform/sla` | `createPlatformRouter` | | ok |
| `prompts.ts` | `/api/v1/prompts` | `standardAuth` | | ok |
| `public-branding.ts` | `/api/v1/branding` | `withRequestId` + optional session resolution | Only exposes public-safe fields | ok |
| `query.ts` | `/api/v1/query` | `withRequestId` + per-handler `authPreamble` | | ok |
| `scheduled-tasks.ts` | `/api/v1/scheduled-tasks` | `createAdminRouter` + `requireOrgContext` | Gated by ATLAS_SCHEDULER_ENABLED | ok |
| `semantic.ts` | `/api/v1/semantic` | `standardAuth` | | ok |
| `sessions.ts` | `/api/v1/sessions` | `standardAuth` | | ok |
| `slack.ts` | `/api/v1/slack/commands`, `/events`, `/interactions` | `verifySlackSignature` | HMAC | ok |
| `slack.ts` | `/api/v1/slack/install`, `/callback` | none (public) | **F-04 — no auth gate on install** | finding |
| `starter-prompts.ts` | `/api/v1/starter-prompts` | `standardAuth` | | ok |
| `suggestions.ts` | `/api/v1/suggestions` | `standardAuth` | | ok |
| `tables.ts` | `/api/v1/tables` | `standardAuth` | | ok |
| `teams.ts` | `/api/v1/teams/install`, `/callback` | none (public) | **F-04 — no auth gate on install** | finding |
| `validate-sql.ts` | `/api/v1/validate-sql` | `standardAuth` | | ok |
| `widget.ts` | `/widget`, `/widget/*.js`, `/widget/*.css` | none (public) | Intentionally public — embeddable; input sanitizers enforced | ok |
| `widget-loader.ts` | `/widget.js`, `/widget.d.ts` | none (public) | Intentionally public — loader script | ok |
| `wizard.ts` | `/api/v1/wizard` | `adminAuth` | | ok |

### OAuth state handling

`packages/api/src/lib/auth/oauth-state.ts` implements DB-backed CSRF
nonce with 10-minute TTL (`DEFAULT_TTL_MS = 600_000`). In-memory
fallback used when no internal DB. All three integrations
(Slack/Teams/Discord) generate a UUID nonce, save it before redirect,
and consume it in the callback. The consume is a single-use
`DELETE ... RETURNING` in Postgres (or `Map.get + delete` in memory).
State contains `{ orgId, provider }`. Provider mismatch is checked in
Teams + Discord callbacks.

**Gap:** The `orgId` inside the OAuth state is only present if the
caller is already authenticated. Install routes themselves are public
(F-04), so an unauthenticated visitor creates state with `orgId =
undefined` and the callback saves an installation bound to no org.

### Findings summary

| ID | P | Summary | GH issue | Status |
|---|---|---|---|---|
| F-01 | P1 | `publicConversations` org-scoped share missing org-membership check (cross-tenant leak) | #1727 | open |
| F-02 | P1 | First-signup bootstrap platform_admin race (email unverified, auto-signin) | #1728 | open |
| F-03 | P2 | Onboarding-email `/unsubscribe` + `/resubscribe` accept arbitrary `userId` without signature | #1729 | open |
| F-04 | P2 | Slack/Teams/Discord `/install` + `/callback` are unauthenticated — org binding + admin role not enforced | #1730 | open |
| F-05 | P2 | `emailAndPassword.requireEmailVerification: false` — compounds F-02 and allows unverified signups to trigger workflows | #1731 | open |
| F-06 | P2 | Better Auth signin/signup rate limiting not explicitly configured — verify built-in defaults vs. Atlas threat model | #1732 | open |
| F-07 | P2 | `session.cookieCache.maxAge = 5 min` delays session revocation (ban / revokeSessions) | #1733 | open |
| F-08 | P3 | `ATLAS_API_KEY_ROLE` defaults to `admin` — surprising default for simple-key deployments | — | p3-pending |
| F-09 | P3 | BYOT `ATLAS_AUTH_AUDIENCE=""` silently disables audience check (should reject empty string) | — | p3-pending |
| F-10 | P3 | `session.expiresIn` is 7 days rolling; no default absolute timeout for admin-capable sessions | — | p3-pending |
| F-11 | P3 | `bearer()` plugin active alongside `apiKey()` — revocation + rotation flow not documented | — | p3-pending |

P0: none.
P1: 2 (F-01, F-02).
P2: 5 (F-03..F-07).
P3: 4 (F-08..F-11) — held here for the cleanup tail.
