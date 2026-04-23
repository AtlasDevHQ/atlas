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
| F-01 | P1 | `publicConversations` org-scoped share missing org-membership check (cross-tenant leak) | #1727 | fixed (PR #1738) |
| F-02 | P1 | First-signup bootstrap platform_admin race (email unverified, auto-signin) | #1728 | open |
| F-03 | P2 | Onboarding-email `/unsubscribe` + `/resubscribe` accept arbitrary `userId` without signature | #1729 | fixed (PR #1744) |
| F-04 | P2 | Slack/Teams/Discord `/install` + `/callback` are unauthenticated — org binding + admin role not enforced | #1730 | fixed (PR #1748) |
| F-05 | P2 | `emailAndPassword.requireEmailVerification: false` — compounds F-02 and allows unverified signups to trigger workflows | #1731 | fixed (bundled into PR for #1732) |
| F-06 | P1 | Better Auth signin/signup rate limiting not explicitly configured; signup enumeration oracle | #1732 | fixed |
| F-07 | P2 | `session.cookieCache.maxAge = 5 min` delays session revocation (ban / revokeSessions) | #1733 | fixed (PR #1747) |
| F-08 | P3 | `ATLAS_API_KEY_ROLE` defaults to `admin` — surprising default for simple-key deployments | — | p3-pending |
| F-09 | P3 | BYOT `ATLAS_AUTH_AUDIENCE=""` silently disables audience check (should reject empty string) | — | p3-pending |
| F-10 | P3 | `session.expiresIn` is 7 days rolling; no default absolute timeout for admin-capable sessions | — | p3-pending |
| F-11 | P3 | `bearer()` plugin active alongside `apiKey()` — revocation + rotation flow not documented | — | p3-pending |

P0: none (initial scoring — see Phase 1.5 for upgrades).
P1: 2 (F-01, F-02).
P2: 5 (F-03..F-07).
P3: 4 (F-08..F-11) — held here for the cleanup tail.

---

## Phase 1.5 — Empirical validation

**Status:** complete (2026-04-20)
**Scope:** Live repro of P1 + select P2 findings against a locally-running Atlas stack (`bun run db:up` + API on :3001). The static audit scored each finding based on code reading alone; this phase attacks the actual endpoints to confirm severity.

### F-01 — cross-tenant conversation leak ✅ confirmed → 🔒 FIXED

Repro (after inserting a conversation into Org A with `share_mode='org'`):

```
== User A (Org A owner) creates shared conversation =>
SHARE_TOKEN=probecb42a262b692eb38dac0eab4b6ec8558

== Unauthenticated GET /api/public/conversations/$TOKEN
HTTP 403 {"error":"auth_required", ...}

== Signup User B (no org memberships)
member count = 0

== User B authenticated GET /api/public/conversations/$TOKEN
HTTP 200
{"title":"F-01 probe","shareMode":"org","messages":[{"role":"user",
"content":"SECRET: Org-A Q2 revenue is 12M USD (do not leak)", ...}]}
```

User B was **not** a member of Org A, had `orgs=0` in the member table, and still received the full conversation body including the sensitive message content. Severity stays **P1**. Dashboard equivalent was not tested at Phase 1.5 time; code-read showed the same truthy-check pattern — see the dashboards extension below.

**Fix:** `publicConversations.openapi(getSharedConversationRoute, ...)` now performs a fail-closed org-membership check after the auth check — `if (!result.data.orgId || authResult.user?.activeOrganizationId !== result.data.orgId) → 403 forbidden`. The lib layer `getSharedConversation` was extended to return `orgId` (SELECT `org_id`) so the route can enforce membership. Fail-closed rather than truthy-check because the schema allows `share_mode='org'` with `org_id IS NULL` and `createShareLink` never stamps `org_id` — see follow-ups #1736 (dashboards had the same truthy-check bug — fixed in PR #1742) and #1737 (add `share_mode='org' → org_id IS NOT NULL` CHECK constraint — fixed in PR #1749, which also revokes `share_token` on drifted rows so coerce-to-public doesn't silently promote dead shares to live-public).

**Dashboards extension (#1736):** `publicDashboards.openapi(getSharedDashboardRoute, ...)` had the structurally identical truthy-check bug at `dashboards.ts:1171` (`if (result.data.orgId && ...)`) and has been ported to the same fail-closed pattern. No lib-layer change was needed — `rowToDashboard` already maps `org_id` through to the `DashboardWithCards` type via the existing `SELECT *`. Regression tests at `packages/api/src/api/__tests__/dashboards.test.ts` pin the four attack cases (unauth, no-active-org, wrong-org, orgId=null) plus the positive control.

Post-fix smoke test on live stack (`/api/public/conversations/<org-scoped-token>`):

| Case | Status |
|---|---|
| Unauthenticated | HTTP 403 `auth_required` |
| User B, no active org | HTTP 403 `forbidden` |
| User B, active org = `org-B-smoke` (different org) | HTTP 403 `forbidden` |
| User B, active org = `org-A-smoke` (conversation's org) | HTTP 200 (positive control) |

Regression tests at `packages/api/src/api/__tests__/conversations.test.ts` pin all four cases plus the `orgId=null` fail-closed branch.

**Log redaction follow-up (#1743):** During the PR #1742 review, `silent-failure-hunter` flagged that both public share routes logged the raw share token in plaintext at the auth-failure `log.error` and cross-org-denial `log.warn` sites. Share tokens are bearer credentials — anyone with log access (SRE / Sentry / log pipeline) effectively held read capability on every share touched. Fixed: `hashShareToken()` helper in `packages/api/src/lib/logger.ts` returns the first 16 hex chars of SHA-256 and throws on non-string input (so future callers don't silently hash the literal `"undefined"` and poison log correlation). Both `conversations.ts` and `dashboards.ts` public share routes now log `tokenHash` instead of `token` at all three log sites (auth-failure `log.error`, cross-org denial `log.warn`, DB-error `log.error`). The dashboards route previously had no DB-error log at all — this pass adds one (parity with conversations, SRE visibility on share fetch failures). Denial logs on both routes additionally carry `actorUserId` + `actorOrgId` for abuse triage. Unit-tested in `packages/api/src/lib/__tests__/logger.test.ts` (including the non-string input throw). Route-level redacted-log-shape assertions in both route test files use a triple-check (tokenHash regex + raw-token absent + global "no log line anywhere contains the raw token") plus coverage for the no-active-org actor branch.

### F-02 — bootstrap platform_admin race ⬆ upgraded to **P0**

Repro against a fresh deployment (DB wiped; `.env` temporarily stripped of `ATLAS_ADMIN_EMAIL`):

```
== Fresh deployment, users=0, ATLAS_ADMIN_EMAIL unset

== Attacker: POST /api/auth/sign-up/email
{"email":"attacker-d262a055@evil.invalid","password":"AttackerPassword123!"}

== Response (200):
{"token":"HNzdrWe0jYp0kugUwflvPQS9dBLbLlmP",
 "user":{"role":"platform_admin","emailVerified":false, ...}}

== DB state:
 email                          | role           | emailVerified
 attacker-d262a055@evil.invalid | platform_admin | f

== Attacker's session on admin route:
GET /api/v1/admin/overview → HTTP 200
{"connections":1,"entities":3,"metrics":2,"glossaryTerms":0,"plugins":0}
```

Single unauthenticated HTTP request → platform_admin role, valid session cookie, full admin console access. Email is unverified (fake `.invalid` TLD). Matches the P0 criterion: "exploitable today with minimal skill (auth bypass, privilege escalation)". Severity upgrades from P1 → **P0**.

### F-03 — onboarding-email unsubscribe bearer 🔒 FIXED

**Fix:** The unsubscribe URL embedded in every onboarding email now carries a
signed token. `packages/api/src/lib/email/unsubscribe-token.ts` signs
`HMAC-SHA256(userId:expiresAtMs)` using a key derived from
`BETTER_AUTH_SECRET` with a `:unsubscribe` suffix (key-isolation from demo
tokens). Token format: `${expiresAtMs}.${base64urlHmac}`. Default TTL 30 days,
configurable via `ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS`.

Route semantics differ by endpoint:

- `/api/v1/onboarding-emails/unsubscribe` returns the same neutral 200 HTML
  on verification failure as on success — but skips the DB write. Rationale:
  if the response differed (400 vs 200), an attacker could enumerate valid
  `userId`s via status-code timing; the fail-closed behavior (flag never
  flips without a valid signature) is what matters.
- `/api/v1/onboarding-emails/resubscribe` returns 403 `forbidden` on
  verification failure. Resubscribe is a consent grant; a missing/invalid
  token must not silently re-enable emails, and a leaked unsubscribe URL
  must not be weaponizable to undo a revocation.

Backwards compat: fail-closed. Emails sent before the fix carry unsigned URLs;
clicking those now shows the neutral "Unsubscribed" page but no DB row is
written. Low user impact — the only effect is "unsubscribe didn't appear to
take; the next email still arrives, use that link instead."

Tests at `packages/api/src/lib/email/__tests__/unsubscribe-token.test.ts`
(18 unit cases: sign/verify roundtrip, cross-user rejection, different-secret
rejection, namespacing pin via raw-secret HMAC, expired/tampered/malformed
rejects, length-mismatch branch, TTL bounds) and
`packages/api/src/api/__tests__/onboarding-emails.test.ts` (14 route cases:
valid/missing/tampered/expired/cross-user tokens on both endpoints, DB
failure paths, Zod validation). The `mockUnsubscribe`/`mockResubscribe`
assertions pin the load-bearing invariant that the flag can never flip
without a valid signature.

### F-04 — install route auth gap ✅ confirmed at P2

Repro against API booted with dummy Slack/Teams/Discord env vars:

```
== Unauthenticated GETs:
/api/v1/slack/install   → HTTP 302  Location: slack.com/oauth/v2/authorize?...&state=<uuid>
/api/v1/teams/install   → HTTP 302  Location: login.microsoftonline.com/.../adminconsent?...&state=<uuid>
/api/v1/discord/install → HTTP 302  Location: discord.com/oauth2/authorize?...&state=<uuid>

== oauth_state table after the three requests:
 provider | org_id | alive
----------+--------+-------
 discord  | (NULL) | t
 teams    | (NULL) | t
 slack    | (NULL) | t
```

All three install routes accept unauthenticated requests and persist CSRF nonces with `org_id = NULL`. Matches the original P2 scoring.

### F-06 — Better Auth signin rate limiting ⬆ upgraded to **P1**

Repro against live API, targeting a real admin email with bad passwords:

```
== 100 sequential POST /api/auth/sign-in/email attempts
   (email: admin@useatlas.dev, password: wrong-pw-1..100)

Total 401: 100   Total 429: 0   Other: 0

== Bonus: signup enumerates existing users
POST /api/auth/sign-up/email {"email":"admin@useatlas.dev", ...}
HTTP 422 {"message":"User already exists. Use another email.",
          "code":"USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}
```

No throttling whatsoever at any point during 100 sequential authentication failures from the same source. The 429 bucket remained empty. A `code: USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` response gives a reliable email-enumeration oracle. This is a live, exploitable gap — not "defense-in-depth". Upgrades from P2 → **P1**.

**Fix:** Explicit `rateLimit` configuration on `betterAuth()` with per-endpoint `customRules` (signin ≤10/min, signup/forget-password/reset-password/send-verification-email ≤5/min, verify-email ≤10/min), DB-backed shared store when the internal DB is available. F-05 (`requireEmailVerification: false`) was bundled into the fix — flipping it to `true` with `autoSignIn: false` activates Better Auth's OWASP-aligned enumeration protection (same 200 response for new and existing emails). Verification emails are delivered via the existing `@atlas/api/lib/email/delivery` chain. A middleware in `packages/api/src/api/routes/auth.ts` injects a trusted `x-atlas-client-ip` header (stripping any inbound value to block spoofing) so Better Auth's rate limiter can resolve the client IP in dev / non-proxied deployments.

Post-fix smoke test on live stack:

| Case | Before fix | After fix |
|---|---|---|
| 100 sequential `/api/auth/sign-in/email` | 100×401, 0×429 | 10×401, 90×429 |
| Signup with existing email | HTTP 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` | HTTP 200 (same shape as new-email signup) |
| 6th `/api/auth/sign-up/email` from same IP | HTTP 200 | HTTP 429 |
| 6th `/api/auth/forget-password` from same IP | HTTP 200/404 | HTTP 429 |
| New-email signup returns session token | `token: "..."` (auto-signin) | `token: null` (verification required) |

Regression tests at `packages/api/src/lib/auth/__tests__/rate-limit.test.ts` pin `resolveAuthRateLimitConfig`, `resolveRequireEmailVerification`, and the `_sendVerificationEmail` failure path (which must never throw — throwing would reintroduce the enumeration oracle through a 500-vs-200 side channel).

### Severity summary after Phase 1.5

| ID | Initial P | Post-repro P | Change |
|---|---|---|---|
| F-01 | P1 | P1 | confirmed |
| F-02 | P1 | **P0** | ⬆ upgraded |
| F-03 | P2 | P2 | not re-tested this pass |
| F-04 | P2 | P2 | confirmed |
| F-05 | P2 | P2 | inherits severity (F-02 already weaponizes the email-unverified path) |
| F-06 | P2 | **P1** | ⬆ upgraded |
| F-07 | P2 | P2 | not re-tested this pass |

**New totals:** P0 = 1 (F-02), P1 = 2 (F-01, F-06), P2 = 4 (F-03, F-04, F-05, F-07), P3 = 4.

---

## Phase 2 — Org-scoping audit

**Status:** complete (2026-04-21)
**Scope:** every route under `packages/api/src/api/routes/` — verify `orgId`
filtering on reads and writes, that the trust anchor is `AuthContext.user.activeOrganizationId`
(session-derived, never request-derived), and that admin vs platform-admin
boundaries are enforced consistently.
**Issue:** #1721
**Branch:** `security/1.2.3-phase-2-org-scoping`

Methodology:
1. Enumerate all routes + mount points in `packages/api/src/api/index.ts`.
2. Categorize each router by auth middleware: `standardAuth`,
   `adminAuth`/`createAdminRouter`, `platformAdminAuth`/`createPlatformRouter`,
   inline preamble, or unauthenticated.
3. For each handler, identify the org-scoping pattern: `requireOrgContext` →
   `orgContext.orgId`, direct `AuthContext.orgId`, or per-handler check.
4. Flag any handler that accepts `orgId`/`workspaceId` from a body / query /
   path parameter without an accompanying trust check.
5. Cross-reference against the user-level vs org-level role model in
   `packages/api/src/lib/auth/managed.ts` (effective role = MAX(user.role,
   member.role)).

### Auth middleware inventory

| Middleware / factory | Role gate | Trust anchor for orgId |
|---|---|---|
| `standardAuth` | authenticated (any role) | `AuthContext.user.activeOrganizationId` |
| `adminAuth` / `createAdminRouter` | `admin` ∨ `owner` ∨ `platform_admin` (effective role) | `AuthContext.user.activeOrganizationId` |
| `platformAdminAuth` / `createPlatformRouter` | `platform_admin` only | cross-org; handler-supplied `orgId` explicit |
| `withRequestId` | none (auth must be handled inline) | handler-supplied |
| `adminAuthPreamble` (inline) | same as `adminAuth` | `authResult.user.activeOrganizationId` |
| Bearer-token `X-Atlas-Internal-Token` (`/api/v1/internal/migrate`) | service-to-service | body `orgId`, trusted via shared secret |

Critical observation: `adminAuth` accepts any user whose **effective role** is
`admin` / `owner` / `platform_admin`. Effective role = MAX(user-table role,
org-member role). A workspace owner/admin has `role = "owner"` / `role = "admin"`
at their active org — but the gate itself does NOT verify that the caller is an
admin *of the workspace being manipulated*. Any sub-route that treats `adminAuth`
as "admin-of-this-resource" without an additional same-org check is a
cross-tenant privilege escalation.

### Route coverage table

Legend: ✅ = org-scoped correctly via `requireOrgContext` / `AuthContext.orgId`,
🟡 = org-scoped with caveats (see notes), ❌ = cross-tenant exposure,
N/A = legitimately cross-org (platform admin or public).

| Path | File | Auth | Org-scope status | Notes |
|---|---|---|---|---|
| POST `/api/v1/chat` | `chat.ts` | inline | ✅ | `authResult.user.activeOrganizationId` used throughout |
| POST `/api/v1/query` | `query.ts` | inline (`authPreamble`) | ✅ | same pattern as chat |
| GET/POST `/api/v1/conversations` | `conversations.ts` | `standardAuth` | 🟡 | List uses userId+orgId; GET/PATCH/DELETE by :id filter by **userId only** — see F-11 |
| GET/POST `/api/public/conversations/:token` | `conversations.ts` | none | ✅ | `getSharedConversation(token)`; org-scoped share check added in F-01 (PR #1738) |
| GET/POST `/api/v1/dashboards` | `dashboards.ts` | `adminAuth`+`requireOrgContext` | ✅ | All queries pass `{ orgId }` |
| GET `/api/public/dashboards/:token` | `dashboards.ts` | none | ✅ | F-01 fix verified org-scoped share (PR #1742) |
| `/api/v1/tables` | `tables.ts` | `standardAuth` | 🟡 | Reads disk-based `semantic/` only; per-org draft entities live in DB and are NOT exposed here — OK but ambiguous in SaaS — see F-16 |
| `/api/v1/validate-sql` | `validate-sql.ts` | `standardAuth` | 🟡 | Accepts body `connectionId`; `connections.getDBType(id)` has no org check — minor info leak if IDs are guessable |
| `/api/v1/semantic` | `semantic.ts` | `standardAuth` | 🟡 | Disk-only reads; same note as /tables |
| `/api/v1/prompts` | `prompts.ts` | `standardAuth` | ✅ | `resolvePromptScope({ orgId, mode })` |
| `/api/v1/suggestions` | `suggestions.ts` | `standardAuth` | ✅ | Lib helpers always include `org_id = $1` clause |
| `/api/v1/sessions` | `sessions.ts` | `standardAuth` | ✅ | Sessions are user-level, correctly scoped by `userId` |
| `/api/v1/actions` | `actions.ts` | `standardAuth` | 🟡 | User-scoped via `requested_by = user.id`; no org filter — users who switched orgs can still approve old-org actions — see F-12 |
| `/api/v1/wizard` | `wizard.ts` | `adminAuth` | ✅ | `resolveConnectionUrl(connectionId, orgId)` trust-anchors to session org |
| `/api/v1/billing` | `billing.ts` | `adminAuth` | ✅ | All queries parameterized on `orgId` |
| `/api/v1/starter-prompts` | `starter-prompts.ts` | `standardAuth` | ✅ | `user.id` + `orgId` from session |
| `/api/v1/mode` | `mode.ts` | `standardAuth` | ✅ | `ContentModeRegistry.countAllDrafts(orgId)` |
| `/api/v1/branding` | `public-branding.ts` | best-effort | ✅ | Null branding if no session; no cross-tenant read |
| `/api/v1/onboarding-emails` | `onboarding-emails.ts` | none, HMAC token | ✅ | Phase-1 fix F-03 (PR #1744) |
| `/api/v1/onboarding` | `onboarding.ts` | `standardAuth` | ✅ | New-org creation; orgId returned from creation |
| `/widget`, `/widget.js` | `widget*.ts` | none | N/A | Static HTML; auth happens client-side via postMessage + API key |
| `/api/v1/internal/migrate` | `admin-migrate.ts` (`internalMigrate`) | `X-Atlas-Internal-Token` (HMAC timingSafeCompare) | ✅ | Service-to-service only; `orgId` from body is trusted via shared secret |
| `/api/v1/admin/**` (workspace admin pool) | 29 sub-routers via `createAdminRouter` + `requireOrgContext` | `adminAuth` + `requireOrgContext` | ✅ (most) | See per-file rows below |
| `/api/v1/admin/organizations/**` | `admin-orgs.ts` | `createAdminRouter` (no `requireOrgContext`) | ❌ **F-08** | Workspace admin can CRUD any org |
| `/api/v1/admin/abuse/**` | `admin-abuse.ts` | `createAdminRouter` (no `requireOrgContext`) | ❌ **F-09** | Workspace admin can reinstate any workspace |
| PATCH `/api/v1/admin/users/:id/role` | `admin.ts` | `adminAuth`+`verifyOrgMembership` | ❌ **F-10** | Accepts `role: "platform_admin"` — workspace admin can escalate any org member to platform admin |
| POST `/api/v1/admin/invitations` | `admin-invitations.ts` | `adminAuth`+`requireOrgContext` | ❌ **F-10** (same class) | Accepts `role: "platform_admin"` in invite body |
| POST `/api/v1/admin/users/:id/ban` | `admin.ts` | `adminAuth`+`verifyOrgMembership` | 🟡 **F-14** | Ban is user-level in Better Auth; workspace admin bans affect all orgs the user belongs to |
| POST `/api/v1/admin/approval/expire` | `admin-approval.ts` | `createAdminRouter` (no `requireOrgContext`) | 🟡 **F-13** | `expireStaleRequests()` likely runs globally; verified as design (TTL sweep) but workspace admin can trigger it across orgs |
| `/api/v1/admin/onboarding-emails` | `admin-onboarding-emails.ts` | `createAdminRouter` (no `requireOrgContext`) | ✅ | Reads `AuthContext.orgId` directly; scoped to caller's org |
| `/api/v1/admin/model-config` | `admin-model-config.ts` | `createAdminRouter` (no `requireOrgContext`) | ✅ | Uses `AuthContext.orgId` with 400 if missing |
| `/api/v1/admin/audit` | `admin-audit.ts` | `adminAuth`+`requireOrgContext` | ✅ | All queries parameterized on `orgId` |
| `/api/v1/admin/publish` | `admin-publish.ts` | `adminAuth`+`requireOrgContext` | ✅ | Transaction-scoped; atomic per-org |
| `/api/v1/admin/connections` | `admin-connections.ts` | `adminAuth`+`requireOrgContext` | ✅ | Platform-admin can query any org via `?orgId=` on specific metric routes; workspace admins locked to own org |
| `/api/v1/admin/sso,scim,ip-allowlist,roles,…` | each sub-router | `adminAuth`+`requireOrgContext` | ✅ | Sampled: consistent pattern |
| `/api/v1/platform/**` | `platform-*.ts` | `platformAdminAuth` / `createPlatformRouter` | ✅ | Cross-org is the point; `platform_admin` gate enforced |

Total routes audited: ~55 top-level paths across 70+ files.

### Findings

**F-08 — Workspace admin can read / suspend / delete / re-plan any workspace via `/api/v1/admin/organizations/**`** — P0

`admin-orgs.ts` uses `createAdminRouter()` *without* `requireOrgContext()`.
Every handler accepts `:id` from the path as `orgId` and operates on that
target org with no check that the caller is an admin of it (or even a member).

Reproduction outline (needs internal DB + two orgs; no other preconditions):
1. Alice is admin in orgA (effective role = `admin`). Bob's orgB exists with
   id `org_bob`.
2. `GET /api/v1/admin/organizations/` → lists *all* orgs platform-wide, including orgB.
3. `GET /api/v1/admin/organizations/org_bob` → Alice reads every member of orgB (ids + names + emails).
4. `PATCH /api/v1/admin/organizations/org_bob/suspend` → orgB immediately blocked from querying.
5. `DELETE /api/v1/admin/organizations/org_bob` → cascade soft-delete of orgB's conversations, settings, schedules, etc.
6. `PATCH /api/v1/admin/organizations/org_bob/plan { planTier: "free" }` → downgrade.

Fix: replace `createAdminRouter` with `createPlatformRouter` for every handler in
`admin-orgs.ts`. These are cross-tenant management operations that belong
strictly to platform admins. The workspace-scoped equivalent (view/manage your
own org's members) is already covered by `adminUsers` + `adminInvitations`
sub-routers.

**Status: fixed (PR #1762).** `admin-orgs.ts` now constructs its router via
`createPlatformRouter()`; the `platformAdminAuth` middleware returns 403
`forbidden_role` for any caller whose effective role is not `platform_admin`.
Regression tests in `packages/api/src/api/__tests__/admin-orgs.test.ts`
parametrise over every route (list, read, stats, status, suspend, activate,
plan, delete) so a future endpoint added to the subtree without a platform
gate fails CI immediately. The pre-existing lifecycle tests in
`admin-workspace.test.ts` were implicitly asserting the bug (role `admin`
succeeded cross-tenant) and are now authed as `platform_admin`.

**F-09 — Workspace admin can reinstate / read detail of any flagged workspace via `/api/v1/admin/abuse/**`** — P0

`admin-abuse.ts` uses `createAdminRouter()` *without* `requireOrgContext()`.

Reproduction outline (any deployment with abuse events recorded — routes
are mounted unconditionally, not EE-gated):
1. Acme (orgA) is a paying customer; BadGuy (orgB) was auto-suspended by the
   abuse module for unusual query patterns.
2. Alice (workspace admin in orgA) calls `GET /api/v1/admin/abuse/` → list
   includes orgB with status `suspended`.
3. `POST /api/v1/admin/abuse/org_badguy/reinstate` → BadGuy is unblocked; all
   abuse counters reset; orgB resumes hitting paid model APIs on Atlas's bill.

Fix: same remedy as F-08 — `createPlatformRouter` for all handlers. Abuse
moderation is platform-level by design; the audit log reference in
`reinstateWorkspace(workspaceId, actorId)` already assumes the actor is a
platform actor.

**Status: fixed (PR #1763).** `admin-abuse.ts` now constructs its router via
`createPlatformRouter()`; the `platformAdminAuth` middleware returns 403
`forbidden_role` for any caller whose effective role is not `platform_admin`.
Regression tests in
`packages/api/src/api/__tests__/admin-abuse-platform-gate.test.ts`
parametrise over every route (list flagged, detail, reinstate, config) so a
future endpoint added to the subtree without a platform gate fails CI
immediately. The pre-existing handler tests in `admin-abuse.test.ts` were
implicitly asserting the bug (role `admin` succeeded cross-tenant) and are
now authed as `platform_admin`.

**F-10 — Workspace admin can escalate any org member to `platform_admin` via PATCH `/api/v1/admin/users/:id/role` and POST `/api/v1/admin/invitations`** — P0

`admin.ts` `changeUserRoleRoute` validates the target user is a member of the
caller's active org (`verifyOrgMembership`) and that the role is a valid
`AtlasRole`. `ATLAS_ROLES` is `["member", "admin", "owner", "platform_admin"]`.
The handler passes the body role straight to Better Auth's
`adminApi.setRole({ userId, role })`, which updates the **user-level** `role`
column.

Combined with `resolveEffectiveRole` = MAX(user-table role, member-table role):
a user whose user-table role is `platform_admin` passes the
`platformAdminAuth` gate on every `/api/v1/platform/**` endpoint regardless of
which org they have active. Workspace admin in orgA can therefore grant
platform-admin to any orgA member, who now has cross-org governance power.

The same class of bug lives in `admin-invitations.ts` create-invite (accepts
`role: "platform_admin"` in body; the invitee becomes platform admin on
accept).

Reproduction outline:
1. Alice is admin in orgA; Chuck is a member of orgA (role=`member`).
2. `PATCH /api/v1/admin/users/chuck/role` body `{ role: "platform_admin" }`
   → Chuck's `user.role` = `platform_admin`.
3. Chuck now has full access to `/api/v1/platform/**` — list all workspaces,
   suspend/delete any workspace, impersonate billing operations, etc.

Fix: restrict the role whitelist at the route layer to the org-level role set
(`member`, `admin`, `owner`). `platform_admin` must only be settable via a
platform-admin-gated endpoint. Two options:
(a) Introduce a dedicated schema (e.g. `OrgRoleSchema`) derived from `ATLAS_ROLES`
    minus `platform_admin` and parse against it in both `changeUserRoleRoute`
    and `admin-invitations.ts`.
(b) Keep `isValidRole` as is but add a guard: `if (newRole === "platform_admin"
    && authResult.user?.role !== "platform_admin") return 403`.
Option (a) is preferred because it also closes the invitation path.

**Status: fixed (PR #1758).** Option (a) implemented: new `ORG_ROLES` tuple in
`@useatlas/types/auth` (`["member", "admin", "owner"]`), an `OrgRoleSchema =
z.enum(ORG_ROLES)` parsed at both `changeUserRoleRoute` and the invitation POST.
The test-fixture `ATLAS_ROLES` mock (which was masking the bug by omitting
`platform_admin`) was realigned with the production tuple and now includes
`ORG_ROLES`. Regression tests cover both routes.

**F-11 — Conversation CRUD by `:id` filters by `user_id` only, not by the caller's active `org_id`** — P2

`packages/api/src/lib/conversations.ts` `getConversation`, `starConversation`,
`updateNotebookState`, `deleteConversation`, `shareConversation`,
`unshareConversation`, and `getShareStatus` all use
`WHERE id = $1 AND user_id = $2`. `listConversations` does filter on both
`user_id` and `org_id`, so the *visible* surface is scoped — but any caller who
knows the conversation UUID can CRUD it regardless of their currently active
organization.

Impact: a user who was a member of orgA, created conversations there, then
switched to orgB (or was removed from orgA and joined orgB), retains
read/modify/share access to their old-org conversations. Old-org conversations
may carry SQL results, row-level data, and semantic references that were
sensitive to orgA's datasource. This is a retention / data-leak-on-membership-
change issue, not a direct cross-user leak — but it's a durable loophole
inconsistent with F-01 which just locked down the *share* read path.

Fix: thread the caller's active `org_id` from `AuthContext` through each CRUD
helper and tack `AND (org_id = $N OR org_id IS NULL)` to every WHERE clause
(the `IS NULL` branch preserves self-hosted compatibility where conversations
pre-date the org column). Same class of fix applies to `chat.ts`'s ownership
verification (`getConversation(conversationId, authResult.user?.id)`) and
`query.ts`'s reuse check.

**F-12 — Actions CRUD by `:id` filters by `requested_by` only, not by the caller's active org** — P2

`actions.ts` `getAction`, `approveAction`, `denyAction` all look up actions by
id and then compare `action.requested_by` against `user.id`. No check that the
caller's current `AuthContext.orgId` matches the org where the action was
created. An action that executes against orgA's datasource (e.g. a bulk update)
could be approved by the same user after they've switched to orgB, triggering
a mutation on orgA's DB from a different workspace session — confusing audit
trails and bypassing the workspace-active-at-approval invariant.

Fix: store `org_id` on the `pending_actions` table and filter on it in every
action-scoped handler; reject approval if action's org_id ≠ current active
org.

**F-13 — `POST /api/v1/admin/approval/expire` is callable by any workspace admin and likely runs a global sweep** — P2 → verify

`admin-approval.ts` registers `expireRoute` **before** `requireOrgContext()`,
meaning any admin-gated caller can hit it without an active org. The handler
calls `expireStaleRequests()` with no arguments; the helper name suggests a
TTL sweep that acts on every approval_request row regardless of org.

If `expireStaleRequests()` deletes/updates pending requests across orgs, a
workspace admin can force-expire another workspace's pending approvals — not
as damaging as F-08/F-09 but still cross-tenant write.

Action: verify the SQL of `expireStaleRequests()`. If global, either
(a) scope it to `orgId` from AuthContext and run per-call only on the caller's
    org, or
(b) convert to a scheduler-only entry point and remove the route, or
(c) move to a platform-admin endpoint.

**F-14 — Workspace-admin user ban is user-level (affects all orgs the target belongs to)** — P2

`banUserRoute` in `admin.ts` calls Better Auth's `adminApi.banUser({ userId })`
which sets `user.banned = true` globally. `verifyOrgMembership` ensures the
target is a member of the caller's org, but doesn't restrict the *scope* of
the ban. A user who is a member of orgA + orgB — e.g. a consultant — can be
banned by orgA's admin and lose orgB access too.

Fix: workspace admins should "remove-from-org" (delete member row), not "ban
user". Reserve `adminApi.banUser` for platform-admin calls. Adding a
platform-gated variant at `/api/v1/platform/users/:id/ban` and replacing the
workspace-admin endpoint with a membership-removal flow fixes both concerns.

**F-15 — `validateSqlRoute` accepts body `connectionId` with no org check** — P3

`POST /api/v1/validate-sql` reads `connectionId` from body and passes it to
`connections.getDBType(connectionId)` which resolves against the global
connection registry. A member of orgA could probe `connectionId = "<orgB-conn-id>"`
and learn the DB type and whether the id exists. Low severity because (a)
connection IDs are org-scoped strings that are not normally discoverable, (b)
the validator does not execute anything, (c) output is just a boolean + DB
type. Still worth adding a
`if (connectionId && !visibleToOrg(connectionId, orgId)) return 404` check for
consistency.

**F-16 — `GET /api/v1/tables` and `/api/v1/semantic/entities` read disk-only, bypassing per-org DB semantic layer** — P3 / design

In SaaS, semantic entities can live in the `semantic_entities` table and be
scoped to an org (draft/published via ContentModeRegistry). The user-facing
`tables.ts` and `semantic.ts` only read the disk-based semantic layer, which
is platform-global. Effects:
- Each workspace sees the platform's global schema, not its org's custom
  entities.
- A workspace that drafted custom entities via the admin editor won't see
  them exposed through the user-facing `/api/v1/tables` endpoint.
Not a cross-tenant leak (disk content is platform-global; every workspace
sees the same subset), but it may be an intentional design (the SaaS product
relies on a common schema) or a latent gap (the admin editor's drafts never
reach the user-facing tables API). Flag for product/architecture review.

### Direct `internal.ts` consumers — sample review

`lib/db/internal.ts` exposes `internalQuery`, `internalExecute`, `queryEffect`,
plus typed helpers (`getSuggestionsByTables`, `incrementSuggestionClick`,
`getPopularSuggestions`, `getWorkspaceDetails`, …). 106 files import it. The
helpers themselves were sampled:

- `getSuggestionsByTables(orgId, …)` — builds `orgId IS NULL` OR `org_id = $1`
  clause. OK.
- `incrementSuggestionClick(id, orgId, userId)` — scopes UPDATE by
  `org_id = $1 AND id = $2`. OK.
- `getWorkspaceDetails(orgId)` / `updateWorkspaceStatus(orgId, …)` — scoped
  to the orgId arg. Callers must pass the correct orgId; admin-orgs.ts passes
  the path param (see F-08).
- `cascadeWorkspaceDelete(orgId)` — scoped to the arg; relies on callers to
  pass the correct orgId.

The common thread: the helpers themselves do what they're told. Enforcement
lives in the route handler. F-08 / F-09 / F-10 are the concrete consequences
of handlers passing a user-controlled orgId to these helpers without a
cross-tenant authorization check.

### ContentModeRegistry consumers — verified

All 4 documented consumers pass `AuthContext.orgId` only — no request-derived
orgId:

- `mode.ts` — `ContentModeRegistry.countAllDrafts(orgId)` where `orgId` comes
  from `AuthContext`. ✅
- `prompts/scoping.ts` — `resolvePromptScope({ orgId, mode })` called from
  `prompts.ts` with `AuthContext.orgId`. ✅
- `admin-connections.ts` — filter mode via `ContentModeRegistry.readFilter`
  with `AuthContext.orgId`. ✅
- `admin-publish.ts` — `runPublishPhases(client, orgId)` inside the admin-
  publish transaction, `orgId` from `requireOrgContext`. ✅

No new consumers since 1.2.2.

### Severity summary

| ID | Severity | Type | Path | Issue |
|---|---|---|---|---|
| F-08 | P0 | Cross-tenant admin | `/api/v1/admin/organizations/**` | #1750 — fixed (PR #1762) |
| F-09 | P0 | Cross-tenant admin | `/api/v1/admin/abuse/**` | #1751 — fixed (PR #1763) |
| F-10 | P0 | Privilege escalation | `/api/v1/admin/users/:id/role`, `/api/v1/admin/invitations` | #1752 — fixed (PR #1758) |
| F-11 | P2 | Retention / scope | Conversation CRUD | #1753 — fixed (PR #1769) |
| F-12 | P2 | Retention / scope | Pending-action CRUD | #1754 — fixed (PR #1769) |
| F-13 | P2 | Cross-tenant write | `/api/v1/admin/approval/expire` | #1755 — fixed (this PR) |
| F-14 | P2 | Scope overreach | User ban | #1756 — fixed (this PR) |
| F-15 | P3 | Info leak | `/api/v1/validate-sql` connectionId | — (P3, stays in doc) |
| F-16 | P3 | Design gap | Disk-only semantic reads | — (P3, stays in doc) |

**Totals:** P0 = 3, P1 = 0, P2 = 4, P3 = 2.

All P0/P1/P2 findings filed as separate issues (#1750–#1756) and shipped. Phase 2 complete.

---

## Phase 3 — SQL validator audit + fuzz

**Status:** audit complete (2026-04-23); fixes tracked per-finding.
**Scope:** attack the 4-layer SQL validator (`packages/api/src/lib/tools/sql.ts`)
— regex mutation guard, AST parse + SELECT-only gate, table whitelist — plus
the runtime guards applied in `packages/api/src/lib/db/connection.ts`
(statement_timeout, read-only session, auto-LIMIT).
**Issue:** #1722
**Branch:** `security/1.2.3-phase-3-sql-validator-audit`

### Methodology

1. Read every layer of `validateSQL()` + the two driver factories
   (`createPostgresDB`, `createMySQLDB`).
2. Enumerate attack categories: mutation-keyword obfuscation, CTE/real-table
   collisions, UNION + subquery + lateral + array-subquery edges,
   schema-qualified + quoted-identifier whitelist collisions, LIMIT handling,
   dialect escape hatches (PG + MySQL), comment smuggling, multi-statement
   injection.
3. Build concrete reproductions for each category and run them through
   `validateSQL()` using the production mock-shape from
   `packages/api/src/lib/tools/__tests__/sql.test.ts`.
4. Where `validateSQL()` accepted a crafted input, classify as finding with
   severity, fix sketch, and a separate GH issue.
5. Encode findings + generator-based combinatorial cases in
   `packages/api/src/lib/__tests__/sql-validator-fuzz.test.ts` — well over
   the ≥200 threshold set by issue #1722.
6. Pin driver-layer runtime guards in
   `packages/api/src/lib/db/__tests__/connection-runtime-guards.test.ts` so a
   refactor that drops `SET statement_timeout` / `SET default_transaction_read_only`
   / `SET SESSION TRANSACTION READ ONLY` / `SET SESSION MAX_EXECUTION_TIME`
   fails CI immediately. Pins anchor to `await client.query(...)` /
   `await conn.execute(...)` so a commented-out line would not satisfy the
   match.

### Layers — current behavior

Anchors are function names rather than line numbers so trivial refactors in
the source don't silently invalidate this table. Exact positions lived in
the PR diff when this phase shipped and can be recovered from git blame.

| Layer | File — function | Enforcement |
|---|---|---|
| 0. Empty check | `sql.ts` — `validateSQL` entry | Rejects empty/whitespace-only input |
| 1. Regex mutation guard | `sql.ts` — `FORBIDDEN_PATTERNS`, `MYSQL_FORBIDDEN_PATTERNS`, `stripSqlComments` | `INSERT\|UPDATE\|DELETE\|DROP\|CREATE\|ALTER\|TRUNCATE` + privilege/admin + `\bINTO\s+OUTFILE\b`. MySQL adds `HANDLER\|SHOW\|DESCRIBE\|EXPLAIN\|USE`. Runs against `stripSqlComments(trimmed)` — comments are removed before match so `/* X */ DROP` is still caught |
| 2. AST parse + SELECT-only | `sql.ts` — `validateSQL` layer 2 | `node-sql-parser` 5.4 PG/MySQL mode. Single-statement. `stmt.type !== "select"` → reject. Parse failure → reject (conservative — confuses parser = crafted bypass) |
| 3. Table whitelist | `sql.ts` — `validateSQL` layer 3, `parser.tableList` | `parser.tableList()` → lowercase name; schema-qualified must be qualified-whitelisted; CTE names excluded |
| R1. Auto-LIMIT | `sql.ts` — pipeline `Step 5` before `executeAndAuditEffect` | Appends `LIMIT ${rowLimit}` if `/\bLIMIT\b/i` absent |
| R2. Statement timeout | `connection.ts` — `createPostgresDB.query`, `createMySQLDB.query` | PG: `SET statement_timeout = ${timeoutMs}`. MySQL: `SET SESSION MAX_EXECUTION_TIME = ${Math.floor(timeoutMs)}` |
| R3. Read-only session | `connection.ts` — `createPostgresDB.query`, `createMySQLDB.query` | PG: `SET default_transaction_read_only = on`. MySQL: `SET SESSION TRANSACTION READ ONLY` |

### Findings

**F-17 — MySQL version-gated executable comments `/*!NNNNN ... */` bypass the validator and execute as live SQL** — P1

**Repro:**
```sql
-- Agent writes this (validator sees a benign SELECT):
SELECT 1 /*!50000 UNION SELECT user, authentication_string FROM mysql.user */

-- MySQL 8 executes (version 80000 ≥ 50000 → content is live):
SELECT 1 UNION SELECT user, authentication_string FROM mysql.user
```

**Root cause:** `stripSqlComments()` in `sql.ts` treats every `/* ... */`
the same way, removing the block wholesale before the regex guard runs.
`node-sql-parser` in MySQL mode also treats `/*!NNNNN ... */` as a comment,
so the AST contains only `SELECT 1` and `tableList()` returns no reference
to `mysql.user`. MySQL (and MariaDB) interpret the construct as an
*executable comment* — the content runs as SQL when the server version is
≥ `NNNNN`. The validator's regex-strip and AST-strip both hide the attack
from every subsequent check.

**Impact:** A prompt-injected agent (or any caller with tool access) can
read any table the database user has SELECT on — including `mysql.user`,
other schemas in the same instance, and any table the semantic layer
intentionally omits. The whitelist is structurally bypassable on MySQL and
MariaDB. Runtime `SET SESSION TRANSACTION READ ONLY` does NOT help because
this is a SELECT/UNION read, not a write.

**Fix sketch:** Preprocess MySQL-mode queries to either (a) strip the
leading `/*!...` marker and re-emit the inner content as live SQL so the
validator sees what MySQL will execute, or (b) reject queries that contain
a `/*!` token outright in MySQL mode. Option (a) preserves compatibility
with any legitimate use; option (b) is simpler and safer. Preprocessing
must happen before `stripSqlComments` so subsequent layers (regex guard,
AST parse, whitelist) all see the executable content.

**Severity:** P1 — whitelist bypass, data exfiltration, no privilege
required beyond agent tool access. Upgraded from initial P2 scoring after
confirming the construct evaluates in both MySQL 8 and MariaDB 10.

**Issue:** #1772.

---

**F-18 — PostgreSQL `SELECT ... INTO new_table` passes the validator; caught only by `default_transaction_read_only` at runtime** — P2

**Repro:**
```sql
-- Validator: PASS (classified as SELECT, tableList = [companies])
SELECT * INTO new_table FROM companies
```

`node-sql-parser` returns `{ type: "select" }` for the PG `SELECT INTO`
construct; `tableList` surfaces only the source (`companies`) not the new
target (`new_table`). Because the regex guard does not match `INTO` alone
(only `INTO\s+OUTFILE`), nothing before the driver layer blocks it. The
query reaches `createPostgresDB`'s `SET default_transaction_read_only = on`
which rejects at execution time with `ERROR: cannot execute SELECT INTO in
a read-only transaction`.

**Impact:** Defense-in-depth only — the validator has a gap that the
runtime closes. If a plugin, config, or misapplied RLS rewrite caused the
read-only session to be skipped, the bypass would result in silent table
creation (a DDL-equivalent) on the analytics DB. Audit logs would record
this as a legitimate SELECT.

**Fix sketch:** The AST parser's `select_into` variant exposes an `into`
object on the SELECT node. Note: every parsed SELECT carries `into` — on a
query without `INTO` it comes back as `{ position: null }`, so a naive
"reject when `stmt.into != null`" guard would reject every SELECT.
Discriminate on `stmt.into?.expr` (the target table reference) or
`stmt.into?.position === "after-select"` (the syntactic position marker
for `SELECT ... INTO t FROM s`). Field shape is not in node-sql-parser's
public `.d.ts` — confirm with an AST snapshot from the fix PR.
Alternatively, extend `FORBIDDEN_PATTERNS` with a PG-mode-specific
`\bINTO\s+(?!OUTFILE\b)[A-Za-z_]\w*` pattern. AST check is preferred
because it avoids regex false positives against column references named
"into".

**Severity:** P2 — runtime catches it, but validator should not pass
DDL-equivalent queries. Gap is structural, not deployment-specific.

**Issue:** #1773.

---

**F-19 — MySQL `SELECT ... INTO DUMPFILE` passes the validator; `INTO OUTFILE` blocked but `INTO DUMPFILE` is not** — P2

**Repro:**
```sql
-- Validator: PASS (regex only checks INTO OUTFILE)
SELECT * FROM companies INTO DUMPFILE '/tmp/x'

-- Validator: REJECT (INTO OUTFILE matched by regex)
SELECT * FROM companies INTO OUTFILE '/tmp/x'
```

The current `FORBIDDEN_PATTERNS` entry is `/\bINTO\s+OUTFILE\b/i`. MySQL
supports two filesystem-writing variants — `INTO OUTFILE` (formatted rows,
one per line) and `INTO DUMPFILE` (single blob, used for dumping binary
data like BLOB column contents to disk). Same attack vector, same
privilege requirement (`FILE`), same regex class — only `OUTFILE` was
enumerated.

**Impact:** If the MySQL user has `FILE` privilege (should not be granted
to Atlas in production, but is a common dev-env default), a crafted query
writes arbitrary bytes to disk. Combined with a world-readable MySQL data
directory, this is trivial privilege escalation. Runtime
`SET SESSION TRANSACTION READ ONLY` does NOT block filesystem writes in
MySQL — read-only transactions prevent table writes, not filesystem
writes.

**Fix sketch:** Change the pattern to `/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i`.
One-line change, covered by the fuzz suite, trivially safe.

**Severity:** P2 — requires FILE privilege at runtime, but the validator
layer must enumerate both variants consistently.

**Issue:** #1774.

---

**F-20 — Case-sensitive quoted identifier whitelist collision** — P3

**Repro:**
```sql
-- Validator: PASS (lowercased to "companies" which is whitelisted)
SELECT * FROM "COMPANIES"

-- PostgreSQL: "COMPANIES" is a distinct table from "companies" because
-- quoted identifiers are case-preserving in PG.
```

`sql.ts:306` lowercases the parsed table name before whitelist lookup.
Unquoted PG identifiers are case-insensitive (folded to lowercase), so
`companies` and `COMPANIES` are the same table. Quoted identifiers
(`"COMPANIES"`) are case-preserving — they are a distinct object in the
catalog. The validator's normalization collapses both into one whitelist
entry.

**Impact:** Low. Requires an unusual schema where case-sensitive table
names carry sensitive data not intended for agent access, AND the
lowercase form is whitelisted. Most Atlas deployments have a single
canonical casing for table names. The MySQL equivalent (`"..."` in
`ANSI_QUOTES` mode) has the same property.

**Fix sketch:** When the parsed reference is quoted (detectable via
`node-sql-parser`'s table-ref structure; `tableList` flattens this), use
the quoted name verbatim for whitelist lookup instead of lowercasing. This
changes behavior for the rare case of mixed-case quoted identifiers; the
whitelist itself should also preserve the original casing as stored in
the entity YAML.

**Severity:** P3 — stays in this doc for the cleanup tail.

---

**F-21 — Dangerous MySQL + PostgreSQL functions pass the validator (known limitation)** — P3

Existing behavior pinned in `sql.test.ts` ("does not block dangerous
PostgreSQL functions") and confirmed for MySQL. Functions that pass:

- PostgreSQL: `pg_read_file`, `pg_ls_dir`, `pg_terminate_backend`,
  `pg_sleep`, `pg_cancel_backend`, `current_setting`, `generate_series`,
  any function call in SELECT that doesn't touch a real table.
- MySQL: `LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `RELEASE_LOCK`,
  `UUID_SHORT` (if session-scoped disambiguation matters).

**Mitigations in place:**
- `statement_timeout` (PG) / `MAX_EXECUTION_TIME` (MySQL) bounds
  long-running functions at 30 s default.
- `pg_read_file` / `pg_ls_dir` require superuser in PG 14+; correct
  production practice is to run Atlas as a non-superuser with limited
  grants.
- `LOAD_FILE` requires `FILE` privilege.
- Connection-pool rate limiting bounds concurrent expensive queries.

**Severity:** P3 — documented limitation; mitigated by DB-level controls.
Worth tracking for a future hardening pass that adds an explicit
function blocklist keyed by dialect.

### Severity summary

| ID | Severity | Type | Surface | Issue |
|---|---|---|---|---|
| F-17 | P1 | Validator bypass | MySQL `/*!NNNNN */` executable comments | #1772 |
| F-18 | P2 | Validator bypass | PG `SELECT INTO` | #1773 |
| F-19 | P2 | Validator bypass | MySQL `INTO DUMPFILE` | #1774 |
| F-20 | P3 | Normalization | Case-sensitive quoted identifier | — (stays in doc) |
| F-21 | P3 | Known limitation | Dangerous dialect functions | — (stays in doc) |

**Totals:** P0 = 0, P1 = 1 (F-17), P2 = 2 (F-18, F-19), P3 = 2 (F-20, F-21).

### Deliverables this PR

- **Audit corpus + property-based fuzz tests** at
  `packages/api/src/lib/__tests__/sql-validator-fuzz.test.ts`:
  well over the ≥200 threshold required by #1722, spread across mutation
  obfuscation, CTE collisions, UNION/subquery/lateral, schema-qualified +
  quoted identifier, LIMIT handling, PG dialect escapes, MySQL dialect
  escapes, comment smuggling + multi-statement, generator-based
  combinatorial (verbs × wrappers × case transforms; non-whitelisted
  tables × query shapes; whitelisted tables × query shapes), and
  known-bypass pins for F-17 (six variants covering single-form, boundary
  versions, bare `/*!`, CTE placement, comma-splice), F-18, and F-19.
  Generator assertions pin the expected rejection layer via reason
  fragments (`"forbidden"` for mutation-guard cases, `"not in the allowed
  list"` for whitelist cases) so a parser upgrade that incidentally
  rejects a payload cannot silently bypass the layer under test.
  Known-bypass cases use a dedicated `expectCurrentBypass(sql, findingId,
  expectedPostFixReason)` helper that fails loudly with flip instructions
  when a future fix closes the bypass.
- **Runtime guard source-level pins** at
  `packages/api/src/lib/db/__tests__/connection-runtime-guards.test.ts`:
  asserts `SET statement_timeout`, `SET default_transaction_read_only`,
  `SET SESSION TRANSACTION READ ONLY`, `SET SESSION MAX_EXECUTION_TIME`
  remain in the driver source and fire before the user query. Each pin
  anchors to the enclosing `await client.query(...)` /
  `await conn.execute(...)` call, so a refactor that comments out the
  statement but leaves the literal text in source cannot satisfy the
  match.
- **This audit section.**

Fixes for F-17/F-18/F-19 are follow-up PRs — intentional separation so
each finding lands with dedicated review + regression coverage, following
the phase-1/phase-2 pattern. The fuzz suite's known-bypass section
documents the current-behavior assertions that flip to rejection when
each fix ships.
