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

**Status:** audit complete (2026-04-23); fixes shipped in phase-3-followup PR
for F-17 / F-18 / F-19 (2026-04-23). F-20 and F-21 remain documented-only
(P3 tail items).
**Scope:** attack the 4-layer SQL validator (`packages/api/src/lib/tools/sql.ts`)
— regex mutation guard, AST parse + SELECT-only gate, table whitelist — plus
the runtime guards applied in `packages/api/src/lib/db/connection.ts`
(statement_timeout, read-only session, auto-LIMIT).
**Issue:** #1722
**Branch:** `security/1.2.3-phase-3-sql-validator-audit` (audit),
`security/1.2.3-phase-3-validator-fixes` (F-17/F-18/F-19 fixes).

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

**Issue:** #1772. **Fix shipped:** phase-3-followup PR. Option A applied —
`unwrapMysqlExecutableComments()` peels the `/*!NNNNN ... */` wrapper before
`stripSqlComments`, the regex guard, the AST parser, and the whitelist all
run. Loop-until-stable handles stacked wrappers; string-literal alternation
prevents false unwraps inside quoted strings; unclosed forms fall through to
the existing regex mutation guard. Fuzz pins F-17.a–F-17.h cover the
variant matrix.

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

**Issue:** #1773. **Fix shipped:** phase-3-followup PR. AST-layer guard in
`validateSQL` rejects when `stmt.into?.type === "into"` and
`stmt.into.keyword !== "var"`. Plain SELECT's `{ position: null }` shape
passes through, MySQL `SELECT ... INTO @var` (`keyword === "var"`) stays
allowed as session-local variable assignment, and PG `SELECT INTO <table>`
plus MySQL `SELECT INTO OUTFILE`/`DUMPFILE` (which already fail the F-19
regex first) all reject.

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

**Issue:** #1774. **Fix shipped:** phase-3-followup PR. `FORBIDDEN_PATTERNS`
extended from `/\bINTO\s+OUTFILE\b/i` to
`/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i`. A column named `dumpfile` (no leading
`INTO`) is unaffected — regression pin covers that case.

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

| ID | Severity | Type | Surface | Issue | Status |
|---|---|---|---|---|---|
| F-17 | P1 | Validator bypass | MySQL `/*!NNNNN */` executable comments | #1772 | Fixed in PR #1776 |
| F-18 | P2 | Validator bypass | PG `SELECT INTO` | #1773 | Fixed in PR #1776 |
| F-19 | P2 | Validator bypass | MySQL `INTO DUMPFILE` | #1774 | Fixed in PR #1776 |
| F-20 | P3 | Normalization | Case-sensitive quoted identifier | — (stays in doc) | Deferred |
| F-21 | P3 | Known limitation | Dangerous dialect functions | — (stays in doc) | Deferred |

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
  Known-bypass cases were originally pinned with an `expectCurrentBypass`
  helper that failed loudly with flip instructions when a fix closed the
  bypass; after the phase-3-followup PR shipped all F-17/F-18/F-19 fixes
  every call site became an `expectInvalid` (or `expectValid` for positive
  regressions) and the helper was removed. Future findings that land
  documented-but-unfixed should reintroduce the same pattern: inline
  `// BYPASS — see F-NN` comment next to an assertion that passes today
  and is designed to flip to `expectInvalid` when the fix ships.
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

Fixes for F-17/F-18/F-19 shipped in PR #1776 (branch
`security/1.2.3-phase-3-validator-fixes`, closes #1772 / #1773 / #1774)
— intentional separation from the audit PR so findings land with dedicated
review + regression coverage, following the phase-1/phase-2 pattern. The
fuzz suite's "regression pins" section keeps F-17.a–F-17.h, F-18, and F-19
pinned so a future refactor that moves the rejection layer or accidentally
reopens a bypass turns the suite red.

---

## Phase 4 — Audit-log coverage on write routes

**Status:** audit complete (2026-04-23); fixes tracked per-finding.
**Scope:** every POST/PUT/PATCH/DELETE route under
`packages/api/src/api/routes/` and the EE audit retention surface
(`ee/src/audit/`). Verify each write emits a well-formed audit event
(`{ actor, org, target, action, timestamp, metadata }`), that
append-only integrity is preserved, that the EE purge scheduler honors
configured retention AND emits a self-audit trail, and that audit
metadata does not carry credentials / connection strings / tokens.
**Issue:** #1723
**Branch:** `security/1.2.3-phase-4-audit-log`

### Methodology

1. Enumerate every route definition with `method: "post" | "put" |
   "patch" | "delete"` under `packages/api/src/api/routes/` — 201 write
   routes across 52 files.
2. For each write, grep the handler body for `logAdminAction(...)` and
   confirm the `{ actor, org, target, action, timestamp, metadata }`
   shape. Two audit sinks in the codebase:
   - `admin_action_log` via `logAdminAction()` — admin mutations.
   - `audit_log` via `persistAudit` inside the query pipeline — SQL
     query execution (chat / query / executeSQL). Not a route-level
     emitter; governed phase-3 instead.
3. Cross-reference each high-stakes flow enumerated in the phase-4
   scope (role changes, plugin install/uninstall, connection edits,
   SSO/SCIM/IP-allowlist, publish, archive/restore, API key rotation,
   user invite/remove) against the coverage table.
4. Walk the two audit tables' DDL + every SQL statement that touches
   them to prove append-only integrity.
5. Walk retention (`ee/src/audit/retention.ts`) and the daily purge
   scheduler (`ee/src/audit/purge-scheduler.ts`) end-to-end to verify
   (a) retention is honored and (b) the purge actions themselves are
   audited.
6. Grep every `metadata: { ... }` payload that ships with
   `logAdminAction` for credential-shaped field names (apiKey /
   password / token / secret / connection string). Any match is a
   leak.

### Audit sinks — what goes where

| Sink | File | Written by | Mutations allowed |
|---|---|---|---|
| `admin_action_log` | `packages/api/src/lib/audit/admin.ts` | `logAdminAction()` — pino + DB insert | **INSERT only**. No UPDATE / DELETE anywhere in the codebase. `0023_admin_action_log.sql` header explicitly says "kept indefinitely — no `deleted_at` column" |
| `audit_log` | `packages/api/src/lib/tools/sql.ts` pipeline → `internalExecute` | Query execution audit (chat / query / wizard) | INSERT; `UPDATE ... SET deleted_at` in `ee/retention.ts#purgeExpiredEntries`; `DELETE ... WHERE deleted_at < now() - interval` in `ee/retention.ts#hardDeleteExpired`; `DELETE ... WHERE org_id = $1` in `internal.ts#cascadeWorkspaceDelete` (workspace hard-delete) |
| `abuse_events` | `packages/api/src/lib/security/abuse.ts#persistAbuseEvent` | Abuse module state changes (including reinstate) | INSERT only. Split audit trail — reinstate emits here, not to `admin_action_log` (see F-33) |

`ADMIN_ACTIONS` catalog (`packages/api/src/lib/audit/actions.ts`) enumerates 54 action values across 16 domains (workspace / domain / residency / sla / backup / settings / connection / user / sso / semantic / pattern / integration / schedule / apikey / approval / mode). Two declared entries have zero call sites: `apikey.create` and `apikey.revoke` — Better Auth's API-key plugin owns key lifecycle through the `/api/auth/*` catch-all, so the catalog entries are dead weight (P3 cleanup, not a finding).

### Route coverage table

Legend: ✅ every write audited, 🟡 partial coverage, ❌ no writes audited, ✳︎ non-admin user content — explicitly out of scope (user-content mutations are not the audit-log coverage target).

Totals at the file level; individual uncovered writes are enumerated under the finding that tracks them.

| File | Writes | Audit calls | Status | Notes |
|---|---:|---:|---|---|
| `actions.ts` | 4 | 0 | ✳︎ | User action approve/deny is user-content not admin; approvals are audited via `admin-approval.ts` when admin-reviewed |
| `admin-abuse.ts` | 1 | 0 | 🟡 | Writes to `abuse_events` via lib — split trail (F-33) |
| `admin-approval.ts` | 5 | 1 | 🟡 | Approve/deny audited; **rule CRUD + expire unaudited** (F-29) |
| `admin-archive.ts` | 2 | 2 | ✅ | `mode.archive` / `mode.archive_reconcile` / `mode.restore` |
| `admin-audit-retention.ts` | 4 | 4 | ✅ | F-26 fixed (PR for #1781) — `audit_retention.policy_update` / `export` / `manual_purge` / `manual_hard_delete` emitted with success + failure paths; policy_update captures previous values |
| `admin-branding.ts` | 2 | 2 | ✅ | F-32 fixed (PR #1806) — `branding.update` / `branding.delete` emitted on success; `update` metadata preserves admin intent (only request-body fields present); `delete` intentionally silent on no-op (404 "no branding found") |
| `admin-cache.ts` | 1 | 0 | ❌ | DELETE purge (F-37) |
| `admin-compliance.ts` | 2 | 2 | ✅ | F-32 fixed (PR #1806) — `compliance.pii_config_update` / `compliance.pii_config_delete` emitted on success; update metadata captures only the admin's intent (request-body fields present) so compliance review can distinguish a masking-strategy shrink from a dismiss. Deliberately named distinct from `audit_retention.*` — these control PII-masking enforcement, not retention windows |
| `admin-connections.ts` | 7 | 3 | 🟡 | Create/update/delete audited; **test / /:id/test / pool drain unaudited** (F-34) |
| `admin-domains.ts` | 4 | 4 | ✅ | F-32 fixed (PR #1806) — `domain.workspace_register` / `workspace_remove` / `workspace_verify` / `workspace_verify_dns` emitted on success; verify paths short-circuit 404 before audit emission when no domain is configured (probes don't land stale rows) |
| `admin-email-provider.ts` | 3 | 3 | ✅ | F-30 fixed (PR #1805) — `email_provider.update` / `delete` / `test` emitted with success + failure paths; update carries `hasSecret: true` marker, delete captures prior provider pre-delete, test includes recipient + delivery outcome |
| `admin-integrations.ts` | 19 | 18 | 🟡 | Most install/uninstall emit `integration.*`; **one handler missing an audit call** — see F-29 |
| `admin-invitations.ts` | 2 | 1 | 🟡 | `user.invite` audited; **`DELETE /users/invitations/{id}` revoke is silent** — see F-29 |
| `admin-ip-allowlist.ts` | 2 | 0 | ❌ | **Per phase-4 scope: CRITICAL** (F-24) |
| `admin-learned-patterns.ts` | 3 | 3 | ✅ | `pattern.approve` / `pattern.reject` / `pattern.delete` |
| `admin-marketplace.ts` | 6 | 6 | ✅ | `plugin.catalog_create` / `catalog_update` / `catalog_delete` + `catalog_cascade_uninstall` / `plugin.install` / `plugin.uninstall` / `plugin.config_update` — F-22 fixed |
| `admin-migrate.ts` | 1 | 0 | ❌ | Schema migration trigger (F-37) |
| `admin-model-config.ts` | 3 | 3 | ✅ | F-30 fixed (PR #1805) — `model_config.update` / `delete` / `test` emitted with success + failure paths; metadata carries `hasSecret` marker and never the apiKey value; test route audits success + failure to close the credential-oracle gap |
| `admin-orgs.ts` | 4 | 4 | ✅ | F-31 fixed (PR #1804) — `workspace.suspend` / `workspace.unsuspend` / `workspace.change_plan` / `workspace.delete` emitted with `scope: "platform"`, matching `platform-admin.ts` canonical fields exactly. Regression test compares entries directly across both surfaces |
| `admin-plugins.ts` | 4 | 3 | ✅ | `plugin.enable` / `plugin.disable` / `plugin.config_update` audited; read-only health check stays silent — F-22 fixed |
| `admin-prompts.ts` | 7 | 0 | ❌ | Content governance — collection + prompt CRUD (F-35) |
| `admin-publish.ts` | 1 | 1 | ✅ | `mode.publish` |
| `admin-residency.ts` | 4 | 4 | ✅ | F-32 fixed (PR #1806) — `residency.workspace_assign` / `migration_request` / `migration_retry` / `migration_cancel` emitted. `workspace_assign` metadata carries explicit `permanent: true` so triage flags the irreversibility, and emits failure-status audits on validation / conflict errors so 409 probes for the current region leave a trail |
| `admin-roles.ts` | 4 | 4 | ✅ | F-25 fixed (PR #1800) — `role.create` / `role.update` / `role.delete` / `role.assign` emitted with success + failure paths; update captures previousPermissions, delete pre-fetches so metadata retains the deleted role, assign captures previousRole |
| `admin-sandbox.ts` | 2 | 0 | ❌ | Connect/disconnect BYOC sandbox (F-37) |
| `admin-scim.ts` | 3 | 3 | ✅ | `scim.connection_delete` / `scim.group_mapping_create` / `scim.group_mapping_delete` — F-23 fixed |
| `admin-semantic-improve.ts` | 4 | 0 | ❌ | AI-assisted semantic layer edits (F-35) |
| `admin-semantic.ts` | 3 | 3 | ✅ | `semantic.update_entity` / `semantic.delete_entity` |
| `admin-sessions.ts` | 2 | 2 | ✅ | F-28 fixed (PR for #1783) — `user.session_revoke` / `user.session_revoke_all` emitted with success + failure paths; single-session path pre-fetches target userId and records `wasCurrentUser` |
| `admin-sso.ts` | 6 | 4 | 🟡 | Configure / update / delete / test audited; **`POST /providers/{id}/verify` + `PUT /enforcement` unaudited** (F-29) |
| `admin-starter-prompts.ts` | 4 | 0 | ❌ | Queue moderation — approve/hide/unhide/author (F-36) |
| `admin-suggestions.ts` | 1 | 0 | ❌ | DELETE suggestion (F-37) |
| `admin.ts` | 12 | 10 | 🟡 | User role / ban / unban / remove-membership / delete-user / revoke-sessions / settings update + delete + semantic put/delete audited; **`POST /me/password`, `POST /semantic/org/import` unaudited** — tracked in F-29. `POST /users/{id}/revoke-sessions` now emits `user.session_revoke_all` (F-28 fixed, PR #1801) |
| `billing.ts` | 2 | 0 | ✳︎ | Stripe portal redirects — Stripe event log is the authoritative trail; both routes are admin-gated |
| `chat.ts` | 1 | 0 | ✳︎ | Agent messages; SQL executed via the tool is audited in `audit_log` |
| `conversations.ts` | 9 | 0 | ✳︎ | User content — out of scope for phase-4 |
| `dashboards.ts` | 11 | 0 | ✳︎ | User content — out of scope for phase-4 |
| `demo.ts` | 2 | 0 | ✳︎ | Signed-token demo; gated by `ATLAS_DEMO_ENABLED`, not admin |
| `onboarding-emails.ts` | 1 | 0 | ✳︎ | Phase-1 F-03 already hardened with signed tokens |
| `onboarding.ts` | 6 | 0 | 🟡 | Org creation emits Better Auth database hook breadcrumb via pino but no `admin_action_log` row for workspace creation (F-37) |
| `platform-admin.ts` | 5 | 5 | ✅ | `workspace.suspend` / `unsuspend` / `delete` / `purge` / `change_plan` |
| `platform-backups.ts` | 5 | 5 | ✅ | Full `backup.*` coverage |
| `platform-domains.ts` | 3 | 3 | ✅ | `domain.register` / `domain.verify` / `domain.delete` |
| `platform-residency.ts` | 1 | 1 | ✅ | `residency.assign` (platform path) |
| `platform-sla.ts` | 3 | 2 | 🟡 | `sla.update_thresholds` + `sla.acknowledge_alert` audited; **`POST /evaluate` (alert-evaluation trigger) unaudited** — see F-29 |
| `query.ts` | 1 | 0 | ✳︎ | SQL queries audited in `audit_log` via pipeline |
| `scheduled-tasks.ts` | 6 | 4 | 🟡 | Create / update / toggle / delete audited; **trigger, preview, tick unaudited** (F-29) |
| `sessions.ts` | 1 | 0 | ✳︎ | Self session delete — Better Auth session table drives audit inherently |
| `slack.ts` | 3 | 0 | 🟡 | Phase-1 F-04 fixed auth gap; **install/callback/events unaudited** in admin log (F-38) |
| `starter-prompts.ts` | 3 | 0 | ✳︎ | User favorites — not admin mutation |
| `suggestions.ts` | 1 | 0 | ✳︎ | Click-through tracking — not admin mutation |
| `validate-sql.ts` | 1 | 0 | ✳︎ | Pure validator — no state change |
| `wizard.ts` | 4 | 0 | ❌ | **Onboarding wizard creates connections without `connection.create` audit** — bypasses `admin-connections.ts` audit path (F-34) |

Total coverage: 201 write routes across 52 files. 77 routes currently emit an admin-audit entry (74 at scoreboard baseline + 3 added by F-23 fix); ✳︎-scoped files (user content, Stripe redirects, pure validators, signed-token demo) contribute another 47 writes that are intentionally audited elsewhere or legitimately skipped. Admin-scoped coverage alone is roughly 40% — the remainder clusters in the findings below. Per-file totals were verified by grepping `method: "(post|put|patch|delete)"` and `logAdminAction(` against each file on `main`; off-by-one errors surfaced during comment-analyzer review have been corrected in the table above (admin-integrations, admin-invitations, admin.ts, platform-sla).

### Findings

**F-22 — Plugin install / uninstall / config has no audit trail** — P0

**Scope match:** Explicit phase-4 high-stakes flow.

**Repro:**

```
POST /api/v1/admin/plugins/{id}/enable    → plugin enabled, no admin_action_log row
POST /api/v1/admin/plugins/{id}/disable   → plugin disabled, no admin_action_log row
PUT  /api/v1/admin/plugins/{id}/config    → plugin config saved (may include secrets), no admin_action_log row
POST /api/v1/admin/plugins/marketplace/install  → workspace install, no admin_action_log row
DELETE /api/v1/admin/plugins/marketplace/{id}   → workspace uninstall, no admin_action_log row
PUT  /api/v1/admin/plugins/marketplace/{id}/config → per-workspace config, no admin_action_log row
POST /api/v1/platform/plugins/catalog           → catalog entry created, no admin_action_log row
PUT  /api/v1/platform/plugins/catalog/{id}      → catalog entry updated, no admin_action_log row
DELETE /api/v1/platform/plugins/catalog/{id}    → cascade uninstalls across all workspaces, no admin_action_log row
```

All handlers in `admin-plugins.ts` and `admin-marketplace.ts` emit a pino `log.info` breadcrumb and nothing else. `ADMIN_ACTIONS` has no `plugin.*` domain.

**Impact:** A platform admin can silently mass-install a surveillance plugin into every workspace via the catalog, or a workspace admin can install a malicious plugin with arbitrary DB credentials — compliance review has no record of either. Cascading catalog delete (mentioned in the route doc as "all workspaces with this plugin installed lose it") is effectively an untraceable mass data-source revoke. Plugin config PUTs accept credentials (BigQuery service account JSON, Snowflake passwords) and store them to DB, yet there is no audit row to correlate a later credential leak with the admin who set it.

**Fix sketch:** Add `plugin.*` domain to `ADMIN_ACTIONS` (`install`, `uninstall`, `enable`, `disable`, `config_update`, `catalog_create`, `catalog_update`, `catalog_delete`). Emit from each handler. Metadata should include `{ pluginId, pluginSlug, orgId (for workspace scope), persisted }` — never the config values themselves, which may contain secrets. Consider a separate `plugin.catalog_cascade_uninstall` event emitted inside the delete transaction when cascading touches workspaces.

**Severity:** P0 — plugin install is enumerated in the phase-4 scope as high-stakes. Both the platform (catalog) and workspace (marketplace + on-disk plugins) paths are silent. Largest single file-level gap in the audit.

**Issue:** #1777.

---

**F-23 — SCIM connection + group-mapping management has no audit trail** — P0

**Scope match:** Explicit phase-4 high-stakes flow.

**Repro:**

```
DELETE /api/v1/admin/scim/connections/{id}      → SCIM connection revoked, no audit row
POST   /api/v1/admin/scim/group-mappings        → new group→role mapping, no audit row
DELETE /api/v1/admin/scim/group-mappings/{id}   → mapping removed, no audit row
```

`admin-scim.ts` is the only file in the admin surface that imports `SCIMError` but not `logAdminAction` / `ADMIN_ACTIONS`.

**Impact:** SCIM is the primary identity-provisioning channel for enterprise customers. A workspace admin who adds a group-to-role mapping (`scim_group_name` → `platform_admin` role, for example) silently grants cross-org privilege to everyone in that group on the next SCIM sync. Deleting a connection revokes the bearer token but leaves no trail of who revoked it — combined with F-28 (session-revocation gap) a hostile admin can break IdP sync and then quietly restore it before detection.

**Fix sketch:** Add `scim.*` domain (`connection_delete`, `group_mapping_create`, `group_mapping_delete`). Metadata includes `{ connectionId / mappingId, scimGroupName, roleName }`. Never include the bearer token itself in metadata.

**Severity:** P0 — SCIM is called out explicitly in the phase-4 scope. Role escalation via SCIM group mappings is a privilege-escalation vector with no detection signal.

**Issue:** #1778.

**Status:** fixed (PR #1796, closes #1778). `ADMIN_ACTIONS.scim.{connectionDelete, groupMappingCreate, groupMappingDelete}` added; all three write handlers in `admin-scim.ts` emit success + failure audit rows. The group-mapping delete handler pre-fetches the row via `listGroupMappings` so the audit metadata preserves `{ scimGroupName, roleName }` — without this the deletion trail would reduce to `{ mappingId }` and compliance queries couldn't reconstruct *which* grant was revoked. Bearer tokens are never written to metadata (asserted by test: bearer-token sentinel absent from audit payload). Failure-path emission uses `Effect.tapErrorCause` so DB-layer defects (rejected `Effect.promise`, `Effect.die`) also produce a failure row — an early iteration used `Effect.tapError` which only catches typed failures and would have left DB outages / pool exhaustion silently unrecorded. The pre-fetch → delete race (list returns row, delete returns false) emits with `status: "failure"` + `reason: "race_deleted_between_fetch_and_delete"` rather than claiming a successful revoke that didn't happen. Error-message hygiene: `errorMessage()` helper strips credential-bearing URI userinfo (`postgres://user:pass@host/db` → `postgres://***@host/db`) and truncates to 512 chars so pg/mysql error text that leaks a connection string can't reach `admin_action_log.metadata`.

---

**F-24 — IP allowlist add / remove has no audit trail** — P0

**Scope match:** Explicit phase-4 high-stakes flow.

**Repro:**

```
POST   /api/v1/admin/ip-allowlist   → add CIDR entry, no audit row
DELETE /api/v1/admin/ip-allowlist/{id}  → remove CIDR entry, no audit row
```

`admin-ip-allowlist.ts` imports the EE module and `runEffect` but not `logAdminAction`.

**Impact:** A compromised admin account can silently add `0.0.0.0/0` to the allowlist, wait for the attacker's follow-up request, and then remove it — no audit row at any stage. The GET route returns `effectivelyEnforced: boolean` which reveals whether any CIDR exists, giving the attacker a simple oracle. Post-incident forensics have no way to reconstruct whether an IP allowlist gap was intentional configuration or exploitation.

**Fix sketch:** Add `ip_allowlist.add` + `ip_allowlist.remove` to `ADMIN_ACTIONS`. Metadata `{ cidr, description }` — the CIDR itself is not a secret (it's routing config) and belongs in the metadata for compliance triage.

**Severity:** P0 — IP-allowlist config is called out explicitly in the phase-4 scope. Allowlist bypass is the most common "admin credential stolen" pivot.

**Issue:** #1779.

---

**F-25 — Custom role CRUD + user role assignment has no audit trail** — P0

**Scope match:** Explicit phase-4 high-stakes flow (role changes).

**Repro:**

```
POST   /api/v1/admin/roles                 → create custom role, no audit row
PUT    /api/v1/admin/roles/{id}            → update role (adds permissions), no audit row
DELETE /api/v1/admin/roles/{id}            → delete role, no audit row
PUT    /api/v1/admin/roles/users/{uid}/role → assign role to user, no audit row
```

`admin-roles.ts` (EE-gated custom RBAC) emits no audit. This is *separate from* `admin.ts`'s `changeUserRoleRoute`, which *is* audited as `user.change_role` — `admin-roles.ts` operates against the custom RBAC model introduced in 0.9.0 and maintained under `@atlas/ee/auth/roles`.

**Impact:** Phase-1 F-10 (shipped, PR #1758) prevented workspace admins from escalating to `platform_admin` via the body-role whitelist. The EE custom-role path still allows an admin to define a new custom role with permissions like `admin:read_audit` or `connection:delete`, assign it to any org member, and leave no trail. Combined with F-26 (audit retention unaudited) a compromised admin can stage an escalation, take the action, then reduce the retention window to purge the trail — zero detection.

**Fix sketch:** Add `role.create` / `role.update` / `role.delete` / `role.assign` to `ADMIN_ACTIONS`. Metadata `{ roleId, roleName, permissions (for create/update), userId (for assign), previousRole (for assign) }`. Match the pattern already established by `user.change_role` in `admin.ts`.

**Severity:** P0 — role changes are named in the phase-4 scope; the EE role surface is the *primary* privilege-assignment path in enterprise deployments.

**Issue:** #1780.

---

**F-26 — Audit retention config, manual purge, and hard-delete are unaudited — meta-audit tamper vector** — P0

**Scope match:** Phase-4 requirement "Retention: EE purge-scheduler honors configured retention AND produces an audit trail of its own purge actions."

**Repro:**

```
PUT  /api/v1/admin/audit/retention              → shrink retention_days from 365 to 7, no audit row
POST /api/v1/admin/audit/retention/export       → bulk-export audit log, no audit row
POST /api/v1/admin/audit/retention/purge        → manually soft-delete expired entries, no audit row
POST /api/v1/admin/audit/retention/hard-delete  → permanently drop soft-deleted entries, no audit row
```

Same class applies to the daily scheduler (see F-27): `ee/audit/purge-scheduler.ts#runPurgeCycle` invokes `purgeExpiredEntries()` + `hardDeleteExpired()` on a 24 h timer and emits pino `log.info` only.

**Impact:** A compromised admin can:

1. `PUT /retention` with `{ retentionDays: 7, hardDeleteDelayDays: 0 }` — drastically shrink the window.
2. `POST /purge` — soft-delete everything past 7 days.
3. `POST /hard-delete` — with `hardDeleteDelayDays: 0`, permanently erase.
4. Restore the original policy.

Steps 1–4 leave **zero** audit rows. Only pino-level breadcrumbs remain, which are often log-only (not persisted) in single-node self-hosted and subject to ring-buffer truncation in platform deployments. `POST /export` is a bulk-exfiltration endpoint (up to 50k rows per call, JSON/CSV) with no audit row recording who pulled what date range.

**Fix sketch:** Add `audit_retention.*` domain (`policy_update`, `export`, `manual_purge`, `manual_hard_delete`). The scheduler's self-audit is tracked under F-27 (dedicated because the scheduler has no user actor and needs a different metadata shape).

**Severity:** P0 — meta-audit. The entire audit system is only as trustworthy as its integrity against the admin who manages it. Current state: zero controls on the audit-about-audit dimension.

**Issue:** #1781.

---

**F-27 — EE purge scheduler and retention mutations emit no self-audit rows** — P1

**Scope match:** Phase-4 requirement "EE purge-scheduler honors configured retention AND produces an audit trail of its own purge actions."

**Repro:**

`ee/src/audit/purge-scheduler.ts#runPurgeCycle` — the 24 h loop that soft-deletes + hard-deletes audit rows across every org that has a retention policy — logs `log.info({ totalSoftDeleted, orgs })` and `log.info({ deletedCount })` to pino and returns. No row is inserted into `admin_action_log` or any sibling table. `ee/src/audit/retention.ts#setRetentionPolicy` and `#purgeExpiredEntries` also emit pino-only breadcrumbs.

Companion sub-finding: `purgeExpiredEntries` updates `audit_retention_config.last_purge_at / last_purge_count` per-org. That is the *only* persisted evidence of a purge ever happening, and it's keyed on the retention config row — so deleting the retention policy row (a side effect of `cascadeWorkspaceDelete`) wipes the evidence trail entirely.

**Impact:** Retention purges *silently* destroy audit history as a matter of routine operation. A compliance reviewer (SOC 2 / HIPAA / CCPA) cannot distinguish "retention purged 10,000 rows on the policy schedule" from "a manual purge in the last 30 s destroyed 10,000 rows evidencing the incident we are investigating." The spec explicitly calls this out.

**Fix sketch:** Emit a dedicated audit row per purge cycle using the existing `AdminActionEntry` shape (`{ actionType, targetType, targetId, status, metadata, scope, ipAddress }` — see `packages/api/src/lib/audit/admin.ts:22–37`). Fields for the scheduler cycle: `actionType: ADMIN_ACTIONS.audit_retention.purge_cycle_run` (reuses F-26's `audit_retention.*` domain — **not** a new `audit_log.*` domain, which would collide with the `audit_log` table name and the existing catalog convention), `targetType: "audit_retention"`, `targetId: "scheduler"`, `scope: "platform"`, `metadata: { softDeleted, hardDeleted, orgs }`. The scheduler has no human actor, so `logAdminAction()` needs a small extension to accept a declared `systemActor` field (e.g. `"system:audit-purge-scheduler"`) in place of the `getRequestContext()`-derived user. That extension is the only required change to the writer; the existing INSERT shape absorbs the new field trivially (`actor_id` + `actor_email` columns can take the system sentinel). For per-org manual purges, emit `audit_retention.manual_purge` with `{ orgId, softDeletedCount, retentionDays }` from the route layer (tracked under F-26).

**Companion regression the acceptance criteria must pin:** `cascadeWorkspaceDelete` currently drops the `audit_retention_config` row for a deleted workspace, which wipes the `last_purge_at / last_purge_count` trail that is the *only* persisted evidence of past purges pre-fix. The fix PR must ensure self-audit rows survive workspace deletion (e.g., by emitting them to `admin_action_log` which has no cascade, not to `audit_retention_config`).

**Severity:** P1 — requirement gap, not a live exploit. Downgrade from P0 only because the underlying purge operations are themselves append-only-respecting (soft-delete + fixed-delay hard-delete); the gap is observability, not data destruction.

**Issue:** #1782.

**Shipped (PR TBD):** Added `systemActor` field to `logAdminAction`'s `AdminActionEntry` — validated against `/^system:[a-z0-9][a-z0-9_-]*$/` at call time so a typo or rename fails loudly instead of writing a malformed audit row. The reserved literal `system:audit-purge-scheduler` lives in one place (`ee/src/audit/purge-scheduler.ts`) and is imported by `retention.ts`. New `audit_log.purge_cycle` domain emits once per `runPurgeCycle` tick (even at zero rows — absence is the signal that the scheduler stopped) with metadata `{ softDeleted, hardDeleted, orgs }`. New `audit_retention.hard_delete` fires from the library layer only when `count > 0` to avoid flooding `admin_action_log` on every zero-row scheduler tick (the outer cycle row proves the scheduler is alive). Dedup picked at the **library layer**: `setRetentionPolicy` and `hardDeleteExpired` suppress their library-layer emission when an HTTP user is in `getRequestContext()`, so the existing F-26 route-level rows (with their richer previous-value / ipAddress metadata) are not doubled. Failure cycles also emit a `status: "failure"` cycle row so a compliance reviewer can tell a silent drop-off from an errored run.

---

**F-28 — Admin session revocation is unaudited** — P1

**Scope match:** Phase-4 implicit — session revocation is a privileged admin action and phase-1 F-07 (cookie-cache delay) noted it as time-critical.

**Repro:**

```
DELETE /api/v1/admin/sessions/{id}         → single session revoked, only pino log.info
DELETE /api/v1/admin/sessions/user/{uid}   → all of user's sessions revoked, only pino log.info
```

`admin-sessions.ts` emits `log.info({ requestId, sessionId, actorId }, "Session revoked")` but no `logAdminAction`. `admin.ts` `revokeUserSessionsRoute` (line 2154) has the same gap.

Related: `admin_action_log.request_id` is a column, and pino logs include `actorId`, but the sink is pino-only. On SaaS deployments pino routes to Grafana Loki with a short retention; on self-hosted it often goes to stdout only.

**Impact:** A workspace admin can revoke the session of another member (e.g., the org's owner) at any time. Without an audit row, a denial-of-service or impersonation setup is untraceable. Combined with F-26, an attacker who owns the retention knob can also ensure that if a pino-to-audit bridge were ever backfilled, the evidence window is already closed.

**Fix sketch:** Add `session.revoke` + `session.revoke_all_for_user` to `ADMIN_ACTIONS`. Metadata `{ sessionId | targetUserId, count (for bulk), wasCurrentUser: boolean }`. Mirror on `admin.ts revokeUserSessionsRoute`.

**Severity:** P1 — session revocation directly affects availability + access; no live exploit but material compliance + incident-response gap.

**Issue:** #1783.

---

**F-29 — Partially-audited admin subrouters miss 1–4 writes each** — P2

Several files have *most* of their writes covered but leave stragglers. Coverage verified by grepping `method: "(post|put|patch|delete)"` + `logAdminAction(` against each file on `main`:

- `admin-sso.ts` (4/6 audited): `POST /providers/{id}/verify` (domain verification, line 544) and `PUT /enforcement` (workspace SSO enforcement toggle, line 493) — no audit. The 4 present calls cover configure / update / delete / test.
- `admin-connections.ts` (3/7 audited): `POST /test` (ephemeral URL), `POST /{id}/test` (health check), `POST /{id}/drain` (single pool drain, line 172), and `POST /pool/orgs/{orgId}/drain` (all pools for an org, line 149) — no audit. The 3 present calls cover create / update / delete.
- `scheduled-tasks.ts` (4/6 audited): `POST /{id}/run` (trigger immediate execution), `POST /{id}/preview` (dry-run), `POST /tick` (scheduler tick) — no audit. `schedule.toggle` fires from a branch inside the PUT update handler when only `enabled` changes, not a discrete route.
- `admin-approval.ts` (1/5 audited): `POST /rules`, `PUT /rules/{id}`, `DELETE /rules/{id}`, `POST /expire` — no audit. The 1 present call covers review (approve/deny).
- `admin.ts` (10/12 audited): `POST /me/password` (change password), `POST /semantic/org/import` (bulk import) — no audit. (`POST /users/{id}/revoke-sessions` was the third gap, fixed under F-28 and now emits `user.session_revoke_all`.)
- `admin-integrations.ts` (18/19 audited): one install/uninstall handler around lines 2353 (POST) or 2458 (DELETE) is missing its `logAdminAction` call. Cross-reference the 19 `method:` declarations against the 18 `logAdminAction({` call sites to find the orphaned write.
- `admin-invitations.ts` (1/2 audited): `DELETE /users/invitations/{id}` at line 313 runs `UPDATE invitations SET status = 'revoked'` with only `log.info` — no admin-action row. The route ships no `user.remove` or `user.revoke_invitation` audit despite being the primary invitation-revocation path.
- `platform-sla.ts` (2/3 audited): `POST /evaluate` (`evaluateAlertsRoute`, line 157) triggers alert evaluation across SLA targets without an audit row.

**Impact:** Partial coverage is worse than none for compliance posture because it reads as "we audit $DOMAIN" until the reviewer walks the gaps. Rule CRUD on approval workflows is especially material — an admin can disable an approval gate, run the action the gate was protecting, and re-enable — end-to-end invisible. Invitation revocation with no audit means a malicious admin can block access to a pending invite (e.g., to the org's owner finishing signup) without any trace.

**Fix sketch:** Case-by-case. For `admin-approval.ts` add `approval.rule_create` / `rule_update` / `rule_delete` / `rule.expire_sweep`. For `admin-sso.ts` add `sso.verify_domain` and `sso.enforcement_update`. For `admin-connections.ts` add `connection.test` (ephemeral), `connection.pool_drain_single` (per-id), `connection.pool_drain_org` (platform scope). For `scheduled-tasks.ts` add `schedule.trigger` and `schedule.preview`; `schedule.tick` uses the system actor (F-27 prerequisite). For `admin.ts` add `user.password_change` (self-action, `targetId: actorId`) and `semantic.bulk_import`. For `admin-integrations.ts` identify the single orphaned write and emit `integration.*` to match its sibling handlers. For `admin-invitations.ts` add `user.revoke_invitation` with metadata `{ invitationId, wasStatus }`. For `platform-sla.ts` add `sla.evaluate_alerts` at platform scope, metadata `{ alertsFired, targetsEvaluated, durationMs }`.

**Severity:** P2 — each individual gap is modest; the cluster is material. Grouped into one issue with per-file subtasks.

**Issue:** #1784 (body updated after comment-analyzer pass — includes the admin-integrations, admin-invitations, and platform-sla additions).

---

**F-30 — BYOT credential management (email provider, LLM model config) is unaudited** — P1

**Scope match:** Phase-4 implicit — credential-bearing endpoints need an audit trail.

**Repro:**

```
PUT    /api/v1/admin/email-provider  → saves API key / SMTP password to email_installations
DELETE /api/v1/admin/email-provider  → deletes override
POST   /api/v1/admin/email-provider/test → sends a test email with caller-supplied creds

PUT    /api/v1/admin/model-config    → saves LLM API key (Anthropic/OpenAI/etc.) to org
DELETE /api/v1/admin/model-config    → deletes override
POST   /api/v1/admin/model-config/test → test LLM call with caller-supplied creds
```

None of these six routes call `logAdminAction`. All six write or test credential material.

**Impact:** If an API key is later exfiltrated (via backup theft, SQL injection, or a compromised operator), there is no record of who configured the key or when. The test routes are particularly material — they accept credentials in the request body, attempt delivery, and return the result. An attacker who obtains admin access can harvest the response body for verification that a given key works (before deciding whether to steal the backup), and there is no audit signal of the repeated test attempts.

**Fix sketch:** Add `email_provider.*` + `model_config.*` domains. For the create/update paths, metadata `{ provider, fromAddress / model, hasSecret: true }` — NEVER the secret value itself. For test endpoints, `{ provider, success: boolean, recipientEmail (email case) }`.

**Severity:** P1 — credential provenance gap. Not currently exploitable by itself but multiplies the impact of every other credential-exfil vector.

**Issue:** #1785.

---

**F-31 — `admin-orgs.ts` is platform-gated post-F-08 but still emits no audit** — P1

**Repro:** Phase-2 F-08 (PR #1762) moved workspace CRUD under `createPlatformRouter`. The role gate was fixed; the audit gap was not. Four writes remain silent: suspend / activate / delete / change plan.

Overlap with `platform-admin.ts` — which DOES audit `workspace.suspend` / `unsuspend` / `delete` / `purge` / `change_plan`. There are now two workspace-mutation surfaces: `platform-admin.ts` (audited) and `admin-orgs.ts` (silent). Platform admins can pick the unaudited path and no one knows.

**Fix sketch:** Either (a) delete the overlap — route every admin-orgs mutation through `platform-admin.ts` internally — or (b) add `logAdminAction` calls to `admin-orgs.ts` matching the `platform-admin.ts` contract. Option (a) is preferred: a single workspace-mutation surface reduces the chance of future drift.

**Severity:** P1 — drift between two parallel admin surfaces is a classic compliance pitfall. The write path exists, the audit path is forgotten.

**Issue:** #1786.

**Status:** fixed (PR #1804, closes #1786). Option (b) shipped — no new `ADMIN_ACTIONS` entries, stays compatible with F-30 / F-32 parallel work. Canonical mapping: `PATCH /:id/suspend` → `workspace.suspend`; `PATCH /:id/activate` → `workspace.unsuspend` (same action_type as platform-admin `POST /unsuspend` — the endpoint path `/activate` deliberately differs from the canonical action_type so compliance queries filtering `action_type = 'workspace.unsuspend'` see one row shape per intent, not two); `PATCH /:id/plan` → `workspace.change_plan` with `metadata: { previousPlan, newPlan }` captured from the pre-mutation fetch; `DELETE /:id` → `workspace.delete` with `metadata: { cleanup, poolsDrained, warnings? }` where `cleanup` mirrors platform-admin's shape verbatim and `poolsDrained`/`warnings` are admin-orgs-specific additives (platform-admin does no pool drain). All emissions carry `scope: "platform"` and a `clientIpFor(c)` helper reusing the `x-forwarded-for`/`x-real-ip` extraction from `platform-admin.ts`. Suspend emits audit BEFORE the drain call so a transient `drainOrg` rejection doesn't silently drop the row after the DB mutation already committed. Regression suite (`admin-orgs-audit.test.ts`) parametrises all four surfaces, calls the admin-orgs and platform-admin equivalents back-to-back with the same workspace stub, and compares canonical audit fields directly between entries (not against literal expectations) — a one-sided regression where both surfaces silently agree on the wrong value still breaks the suite. Pool-drain enabled path covered: `isOrgPoolingEnabled()` + `drainOrg()` overrides exercise both the success (`poolsDrained: N`) and failure (`warnings: ["pool_drain_failed: ..."]`) branches so a future rename of those metadata keys fails the suite. Option (a) — consolidating both surfaces into a shared `lib/workspace-mutations.ts` helper so the drift window closes at the write layer, not just the audit layer — remains a candidate refactor; the parity test makes future drift observable but does not prevent it.

---

**F-32 — Workspace-scoped enterprise config writes (domains, branding, residency, compliance) are unaudited** — P1 — **FIXED**

Four admin files with explicit enterprise-gated config surfaces and zero audit coverage:

- `admin-domains.ts` (4 writes): add / delete / verify / verify-dns workspace custom domain.
- `admin-branding.ts` (2 writes): put / delete white-label branding.
- `admin-residency.ts` (4 writes): assign region (permanent), request / retry / cancel region migration.
- `admin-compliance.ts` (2 writes): put retention policy, delete PII config.

**Impact:** Custom-domain + residency in particular are permanent or semi-permanent workspace-identity changes. A workspace that migrates regions then experiences a data-export subpoena has no way to prove which region hosted what data when. Branding is lower risk but still governance-relevant — an admin can silently white-label the product before phishing tenant users. Compliance retention-policy changes share the class of F-26 (audit-about-audit).

**Fix sketch:** Add `domain.workspace_*` (register / remove / verify / verify_dns), `branding.update` / `branding.delete`, `residency.workspace_assign` / `migration_request` / `migration_retry` / `migration_cancel`, `compliance.pii_config_update` / `compliance.pii_config_delete` (originally drafted as `compliance.retention_update` but renamed to avoid semantic collision with the existing `audit_retention.*` domain — the PUT route updates PII-masking enforcement on a single classification, not a retention window).

**Severity:** P1 — workspace-identity and data-residency changes are compliance-critical.

**Issue:** #1787. Fixed in PR for #1787 — all 12 writes now emit `logAdminAction`. `residency.workspace_assign` metadata carries `permanent: true` and emits failure-status audits on conflict / validation paths (409 probes for the current region leave evidence). Branding / compliance / residency read endpoints intentionally stay silent. Regression coverage: `admin-domains.test.ts`, `admin-branding.test.ts`, `admin-residency.test.ts`, and new `admin-compliance.test.ts`.

---

**F-33 — Abuse reinstate writes to `abuse_events`, not `admin_action_log` — split audit trail** — P2

**Repro:** `POST /api/v1/admin/abuse/{workspaceId}/reinstate` → `reinstateWorkspace()` → `persistAbuseEvent()` → row in `abuse_events`. No `logAdminAction` call anywhere in the flow.

**Impact:** Compliance queries that scan `admin_action_log` for "what did platform admins do today?" miss every reinstate action entirely. A reviewer investigating billing anomalies ("why are there 500k queries from a previously suspended workspace?") has to know to cross-reference a second table. Phase-2 F-09 fixed the role gate but didn't unify the audit path.

The in-module handler code path (`admin-abuse.ts` lines 296–312) explicitly acknowledges this gap in its fail-mode branch: when `hasInternalDB()` is false, it logs a warning but still returns success. That's a real-world silent-failure path where *no audit row exists at all* — not in `abuse_events`, not in `admin_action_log`, not anywhere.

**Fix sketch:** Call `logAdminAction({ actionType: "workspace.reinstate_abuse", targetType: "workspace", targetId: workspaceId, scope: "platform", metadata: { previousLevel } })` alongside the `abuse_events` row. Dual-write is cheap and closes the compliance query gap.

**Severity:** P2 — evidence exists but in the wrong place. Not a compliance failure per se, but a consistent-view failure. Scored one tier below F-31 (P1) despite being the same class of "dual-surface write, split trail" because reinstate is not enumerated in the phase-4 high-stakes list and `abuse_events` retains a full record including actor + timestamp + previous level; F-31's `admin-orgs.ts` writes leave no trail at either surface for anyone who picks the unaudited path.

**Issue:** #1788.

---

**F-34 — Wizard onboarding + connection test paths bypass `connection.create` audit** — P2

**Repro:**

```
POST /api/v1/wizard/profile   → list tables from a connected datasource (reads using supplied connectionId)
POST /api/v1/wizard/generate  → profile tables + synthesize entity YAML (writes draft entities)
POST /api/v1/wizard/preview   → preview wizard output without persisting
POST /api/v1/wizard/save      → persist wizard-generated config + entities (NOT through admin-connections.create)
POST /api/v1/admin/connections/test           → test arbitrary URL, no audit (also F-29)
POST /api/v1/admin/connections/{id}/test      → health check, no audit (also F-29)
POST /api/v1/admin/connections/{id}/drain     → drain single pool, no audit (also F-29)
POST /api/v1/admin/connections/pool/orgs/{orgId}/drain → drain org pools, no audit (also F-29)
```

`wizard.ts` has 4 writes and 0 audit entries. The wizard is the *primary* UI path for onboarding a datasource and semantic layer. `admin-connections.ts` audits `connection.create` on the raw API path but the wizard's `/save` writes connection + entity rows directly via `lib/` helpers, short-circuiting the audited route. Net effect: a datasource added via the happy-path UI produces no `connection.create` row.

**Impact:** Compliance review of "when did the org add datasource X" returns stale data. Pool drain is an availability lever (disconnects all active sessions to a connection or to every connection in an org) and has no trace. The wizard's `/profile` endpoint also accepts a `connectionId` and lists tables — low-risk given it reuses an already-stored connection, but a brute-force probe of "is this connection reachable?" leaves no audit.

**Fix sketch:** Wizard `POST /save` should call `logAdminAction(ADMIN_ACTIONS.connection.create, ...)` — same action type + metadata shape as `admin-connections.ts` (`{ name, dbType }`) so compliance queries treat the two surfaces uniformly. Wizard `/generate` creates draft semantic entities and should emit `semantic.create_entity` per new entity (or a single `semantic.bulk_import` row with a count). Test + drain endpoints in `admin-connections.ts` are covered by F-29.

**Severity:** P2 — silent creation of data sources via the wizard bypasses the compliance signal for the same resource class that *is* audited elsewhere.

**Issue:** #1789.

---

**F-35 — Prompt library + semantic-improve + starter-prompt moderation writes unaudited** — P2

Bundled class — content-governance admin writes:

- `admin-prompts.ts` (7 writes): prompt collection + prompt CRUD.
- `admin-semantic-improve.ts` (4 writes): AI-assisted semantic layer drafts + apply.
- `admin-starter-prompts.ts` (4 writes): queue moderation (approve / hide / unhide / author).

**Impact:** Content-governance actions that affect every user of the workspace (starter prompts surfaced on first-run, prompts in the library, semantic drafts that reshape agent SQL). No trail of who approved / hid / applied. Same shape as the learned-patterns surface that IS audited (`pattern.approve` / `pattern.reject` / `pattern.delete` in `admin-learned-patterns.ts`).

**Fix sketch:** Model on `admin-learned-patterns.ts`. Add `prompt.create` / `prompt.update` / `prompt.delete` / `prompt_collection.*`, `semantic.improve_draft` / `semantic.improve_apply`, `starter_prompt.approve` / `starter_prompt.hide` / `starter_prompt.unhide` / `starter_prompt.author_update`.

**Severity:** P2 — content-governance trail gap. Less privileged than F-22/F-25 but same class of "admin mutations visible to end users, invisible in audit."

**Issue:** #1790.

---

**F-36 — `admin_action_log` has no retention policy — grows unbounded, no purge mechanism** — P2

**Repro:** `audit_log` has a per-org retention policy via `audit_retention_config` and a daily scheduler. `admin_action_log` has neither. Migration `0023_admin_action_log.sql` states "kept indefinitely — no `deleted_at` column." Two problems follow:

1. **Unbounded growth** — a busy SaaS workspace admin UI generates hundreds of `admin_action_log` rows per day. Over years this accumulates without any purge or archival mechanism, eventually impacting query performance on the indexes.
2. **Compliance mismatch** — GDPR / CCPA "right to erasure" requests cover audit data too. A user who is forgotten has their `actor_id` in `admin_action_log` rows indefinitely, violating the contract. `audit_log` supports this via retention purge; `admin_action_log` does not.

**Fix sketch:** Add a retention policy table + scheduler for `admin_action_log` parallel to `audit_retention_config`. Default retention significantly longer than query audit (7 years for SOC 2 alignment).

GDPR "right to erasure" support is the open design decision the fix PR must propose and defend — there is no pre-existing anonymization pattern in the codebase to model on (`cascadeWorkspaceDelete` in `lib/db/internal.ts` hard-deletes workspace-scoped rows; no user-level erasure helper exists yet). Candidate shapes, in order of preference: (1) `actor_id = NULL, actor_email = NULL, anonymized_at = now()` — preserves the row, avoids collision with real values, gives queries a positive signal; (2) sentinel strings (`"__erased__"`) — simpler but risks false-positive collision with real values unless an invariant check runs at insert; (3) cryptographic hashing with a peppered SHA-256 — preserves action-sequence correlation without exposing the user, at the cost of pepper-rotation complexity. The fix PR must also address the pino sink: pre-erasure log lines retain the full `actorEmail` in Grafana Loki / stdout, so actor anonymization in Postgres is half of the compliance story; either pipe pino audit records through a redaction filter before write, or document the log-retention boundary separately. Requires migration + scheduler extension (F-27 prerequisite for self-audit) + EE admin surface to configure.

**Severity:** P2 — not a live exploit; long-term storage + compliance gap. Classified under phase-4 because the phase-4 scope covers "Retention" explicitly.

**Issue:** #1791.

---

**F-37 — Low-signal admin writes unaudited: cache purge, migrate, suggestion delete, sandbox, onboarding complete** — P3

Bundled:

- `admin-cache.ts` DELETE (`/purge`) — platform cache bust.
- `admin-migrate.ts` POST (trigger schema migration).
- `admin-suggestions.ts` DELETE (remove a suggestion).
- `admin-sandbox.ts` POST `/connect` + DELETE `/disconnect`.
- `onboarding.ts` `POST /complete` (workspace creation).

**Impact:** Each is a narrow admin lever; audit gap is a posture issue rather than a live exploit. Cache purge can be weaponized for a temporary DoS but leaves no trace; sandbox connect stores Vercel/E2B/Daytona credentials that share the F-30 credential-provenance concern (lower volume); onboarding complete is the creation point for a workspace and therefore is the implicit target of every later `workspace.*` audit call.

**Fix sketch:** Add corresponding `cache.purge`, `schema.migrate_trigger`, `suggestion.delete`, `sandbox.connect` / `sandbox.disconnect`, `workspace.create` actions. Metadata conventions follow the table above. Sandbox connect must NOT include credentials in metadata.

**Severity:** P3 — stays in this doc for the cleanup tail unless one of these is promoted by a specific incident.

---

**F-38 — Slack / Teams / Discord install + callback + events unaudited in admin log** — P3

Phase-1 F-04 fixed the auth gap on install routes (PR #1748). Callbacks now record an `integrations_installs` row, so an install *is* persisted. The admin action trail does not reflect this — no `integration.enable` is emitted on the OAuth callback path despite that being the moment of truth for the install. Stream integrations (`events`, `interactions`, `commands`) write their own dedicated signals (signed requests, message IDs) so the audit gap for message-flow events is intentional. The callback gap is not.

**Fix sketch:** Emit `integration.enable` from the OAuth callback after successful token exchange, metadata `{ platform, installationId, byot: false }`.

**Severity:** P3 — the `integrations_installs` row serves as a working trail; adding a parallel `admin_action_log` row unifies the admin-view but is not compliance-critical given the existing mechanism.

---

### Append-only integrity — verified

- **`admin_action_log`**: no `UPDATE` or `DELETE` statements anywhere in `packages/`, `ee/`, or `apps/` (verified by grep of `UPDATE admin_action_log` + `DELETE FROM admin_action_log` across the whole repo — zero matches). Enforcement is convention-level: there is no RLS policy, DB trigger, or per-role grant revoking UPDATE/DELETE to application roles. A misbehaving route could technically issue either. **Mitigation:** consider migration that revokes UPDATE/DELETE on `admin_action_log` from the app role; ship only the INSERT grant. Tracked as F-40 below (P3).
- **`audit_log`**: mutations are tightly scoped and all legitimate:
  - `UPDATE audit_log SET deleted_at = now()` — `ee/audit/retention.ts#purgeExpiredEntries` (soft-delete under retention policy).
  - `DELETE FROM audit_log WHERE deleted_at < now() - interval` — `ee/audit/retention.ts#hardDeleteExpired` (hard-delete under retention policy).
  - `DELETE FROM audit_log WHERE org_id = $1` — `lib/db/internal.ts#cascadeWorkspaceDelete` (workspace hard-delete cascade).
  All three paths are documented + gated by retention / cascade. No route-layer mutation paths.
- **`abuse_events`**: INSERT-only, no mutation queries.

**F-40 — No DB-level grant revocation on `admin_action_log`** — P3

Append-only is enforced by code convention. Either a future refactor that accidentally issues `UPDATE admin_action_log SET ...` or a SQL injection via a misbehaving admin route could mutate or delete audit rows silently. Postgres supports per-role grants (e.g., grant only INSERT + SELECT to the app role). This is defense-in-depth, not a live-exploit bar.

**Fix sketch:** Add a migration that `REVOKE UPDATE, DELETE ON admin_action_log FROM app_role`. Requires a schema-admin migration because the app role is already using the table. Add a runtime guard / test that INSERT works and UPDATE is rejected.

**Severity:** P3 — documented known-risk that stays in this doc for the cleanup tail.

### Sensitive-field redaction — verified

Grep every `metadata: { ... }` literal on the admin-audit call sites. Sampled payloads:

- `admin-integrations.ts`: `{ platform: "<name>" }`, `{ platform, mode: "byot" }`, `{ platform: "email", provider }` — all safe, no credentials.
- `admin-sso.ts`: `{ providerType }`, `{ providerType: result.type, success }` — safe.
- `admin-connections.ts`: `{ name: id as string, dbType }`, `{ name: id, urlChanged }`, `{ name: id }` — safe. `urlChanged` is a **boolean** not the URL, confirmed at `admin-connections.ts:805`.
- `admin-semantic.ts`: `{ name, entityType }` — safe.
- `admin.ts` user routes: `{ previousRole, newRole }`, `{ reason, expiresIn }`, `{ orgId, previousRole }` — safe.
- `admin.ts` settings: `{ key, value }` at line 2294 and `{ key, action: "reset_to_default" }` at line 2339 — **partial concern**. The earlier handler body rejects `def.secret === true` before reaching the audit call, so `value` here is always a non-secret setting. But a non-secret setting can still carry sensitive-ish data (webhook URL with a token query param, sender email address, a CIDR range that identifies a home network). Technically compliant because the registry marks secret settings; practically the `value` dimension is worth reviewing per-setting on any future registry addition. P3 hardening hook, not a live finding.
- `platform-backups.ts`: `{ backupId }`, `{ verified, message }`, `{ preRestoreBackupId }` — safe. Additionally at `platform-backups.ts:454` the update-config audit carries `{ previousConfig: { storagePath }, newConfig: { storagePath } }`. `storagePath` is a filesystem or cloud-storage path — not a secret per se (it's operator-configured infrastructure), but operators should avoid embedding access tokens in storage URIs. No current finding; flagged for the redaction-posture record.
- `platform-admin.ts`, `platform-domains.ts`, `platform-residency.ts`, `platform-sla.ts`: all sampled payloads are IDs / enum values / booleans. No credentials.
- `scheduled-tasks.ts`: `{ name, enabled }`, `{ taskId }` — safe.

**Result:** no credentials / connection strings / tokens leak into audit metadata on current `logAdminAction` call sites. Redaction is solid. Risk is **F-30** — many credential-touching endpoints don't currently emit audit at all; once those land, the fix PRs must not regress the redaction posture.

### High-stakes flow coverage — summary

| Flow | Audited? | Gap |
|---|---|---|
| Role changes (Better Auth user role) | ✅ | `user.change_role` in `admin.ts` (phase-1 F-10 hardened) |
| Role changes (EE custom RBAC) | ❌ | **F-25** |
| Plugin install/uninstall | ❌ | **F-22** |
| Connection edits | 🟡 | `admin-connections.ts` create/update/delete audited; **wizard + test + drain unaudited** (F-34) |
| SSO config | 🟡 | Most audited; verify + enforcement-update gaps (F-29) |
| SCIM config | ❌ | **F-23** |
| IP allowlist config | ❌ | **F-24** |
| Publish events | ✅ | `mode.publish` |
| Archive / restore | ✅ | `mode.archive` / `mode.archive_reconcile` / `mode.restore` |
| API key rotation | N/A | Better Auth `apiKey()` plugin handles lifecycle via `/api/auth/*`; catalog has dead `apikey.*` entries (dead code, P3) |
| User invite / remove | 🟡 | `user.invite` / `user.remove` / `user.remove_from_workspace` audited; **invitation revoke at `admin-invitations.ts:313` unaudited** — tracked in F-29 |

### Findings summary

| ID | Severity | Type | Surface | Issue | Status |
|---|---|---|---|---|---|
| F-22 | P0 | Audit gap | Plugin install/uninstall (`admin-plugins.ts`, `admin-marketplace.ts`) | #1777 | fixed (PR #1802) |
| F-23 | P0 | Audit gap | SCIM management (`admin-scim.ts`) | #1778 | open |
| F-24 | P0 | Audit gap | IP allowlist (`admin-ip-allowlist.ts`) | #1779 | fixed (PR #1797) |
| F-25 | P0 | Audit gap | EE custom-role CRUD + assignment (`admin-roles.ts`) | #1780 | fixed (PR #1800) |
| F-26 | P0 | Meta-audit | Audit retention config + manual purge / hard-delete / export (`admin-audit-retention.ts`) | #1781 | fixed (PR #1799) |
| F-27 | P1 | Self-audit | EE purge scheduler + retention mutations (`ee/audit/*`) | #1782 | fixed (PR TBD) |
| F-28 | P1 | Audit gap | Admin session revocation (`admin-sessions.ts`, `admin.ts`) | #1783 | fixed (PR #1801) |
| F-29 | P2 | Partial coverage | `admin-sso.ts`, `admin-connections.ts`, `scheduled-tasks.ts`, `admin-approval.ts`, `admin.ts` stragglers | #1784 | open |
| F-30 | P1 | Credential-provenance | Email provider + model config (`admin-email-provider.ts`, `admin-model-config.ts`) | #1785 | fixed (PR #1805) |
| F-31 | P1 | Audit gap | Platform-admin workspace CRUD via `admin-orgs.ts` (post-F-08 drift) | #1786 | fixed (PR #1804) |
| F-32 | P1 | Audit gap | Workspace enterprise config (`admin-domains.ts`, `admin-branding.ts`, `admin-residency.ts`, `admin-compliance.ts`) | #1787 | fixed (PR #1806) |
| F-33 | P2 | Split trail | Abuse reinstate writes to `abuse_events`, not `admin_action_log` | #1788 | open |
| F-34 | P2 | Audit gap | Wizard connection path bypasses `connection.create` (`wizard.ts`, plus connection test/drain in `admin-connections.ts`) | #1789 | open |
| F-35 | P2 | Audit gap | Prompt / semantic-improve / starter-prompt moderation | #1790 | open |
| F-36 | P2 | Retention | `admin_action_log` unbounded, no purge, no GDPR erasure path | #1791 | open |
| F-37 | P3 | Audit gap | Low-signal admin writes (cache / migrate / suggestions / sandbox / onboarding) | — (stays in doc) | deferred |
| F-38 | P3 | Audit gap | OAuth-callback install path not mirrored in `admin_action_log` | — (stays in doc) | deferred |
| F-39 | — | unused | (reserved; gap in numbering avoided) | — | — |
| F-40 | P3 | Defense-in-depth | No DB-level grant revocation on `admin_action_log` | — (stays in doc) | deferred |

**Totals:** P0 = 5 (F-22, F-23, F-24, F-25, F-26), P1 = 5 (F-27, F-28, F-30, F-31, F-32), P2 = 5 (F-29, F-33, F-34, F-35, F-36), P3 = 3 (F-37, F-38, F-40). No F-39 — skipped to preserve the per-finding numbering discipline from phases 1–3 after the P3 regroup.

### Deliverables this PR

- **This audit section** — table + 15 P0/P1/P2 findings + 3 P3 items.
- **15 GitHub issues filed** (#1777 – #1791) with `security`, `bug`, `area: api` labels and `1.2.3 — Security Sweep` milestone.
- **Phase-4 checkbox flipped** in the tracker (#1718).
- **No production code changes** — fixes ship as follow-up PRs per the phase-1/2/3 workflow, each finding landing with dedicated review + regression coverage. Several findings cluster by file (e.g., F-30 covers two files, F-32 covers four) and can be bundled into a single fix PR per cluster.

Fixes for F-22 through F-38 are follow-up PRs. Priority ordering: P0s ship first (F-22 → F-26), then P1 credential/retention self-audit (F-27, F-30), then the rest. F-40 (DB grant revocation) is a migration-only change that ships independently of the per-route audit additions.
