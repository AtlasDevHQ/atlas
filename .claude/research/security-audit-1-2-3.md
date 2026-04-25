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
| `abuse_events` | `packages/api/src/lib/security/abuse.ts#persistAbuseEvent` | Abuse module state changes (including reinstate) | INSERT only. Dual-written with `admin_action_log` on reinstate post-F-33 (PR #1808) — see route-table row for `admin-abuse.ts` |

`ADMIN_ACTIONS` catalog (`packages/api/src/lib/audit/actions.ts`) enumerates 54 action values across 16 domains (workspace / domain / residency / sla / backup / settings / connection / user / sso / semantic / pattern / integration / schedule / apikey / approval / mode). Two declared entries have zero call sites: `apikey.create` and `apikey.revoke` — Better Auth's API-key plugin owns key lifecycle through the `/api/auth/*` catch-all, so the catalog entries are dead weight (P3 cleanup, not a finding).

### Route coverage table

Legend: ✅ every write audited, 🟡 partial coverage, ❌ no writes audited, ✳︎ non-admin user content — explicitly out of scope (user-content mutations are not the audit-log coverage target).

Totals at the file level; individual uncovered writes are enumerated under the finding that tracks them.

| File | Writes | Audit calls | Status | Notes |
|---|---:|---:|---|---|
| `actions.ts` | 4 | 0 | ✳︎ | User action approve/deny is user-content not admin; approvals are audited via `admin-approval.ts` when admin-reviewed |
| `admin-abuse.ts` | 1 | 1 | ✅ | F-33 fixed (PR #1808) — see finding below |
| `admin-approval.ts` | 5 | 1 | 🟡 | Approve/deny audited; **rule CRUD + expire unaudited** (F-29) |
| `admin-archive.ts` | 2 | 2 | ✅ | `mode.archive` / `mode.archive_reconcile` / `mode.restore` |
| `admin-audit-retention.ts` | 4 | 4 | ✅ | F-26 fixed (PR #1799) — `audit_retention.policy_update` / `export` / `manual_purge` / `manual_hard_delete` emitted with success + failure paths; policy_update captures previous values |
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
| `admin-prompts.ts` | 7 | 7 | ✅ | F-35 fixed — `prompt.collection_create` / `collection_update` / `collection_delete` + `prompt.create` / `update` / `delete` / `reorder` emitted. Delete handlers pre-fetch the row so metadata carries the name after deletion. Reorder carries the full `newOrder: string[]` for drag-and-drop forensics |
| `admin-publish.ts` | 1 | 1 | ✅ | `mode.publish` |
| `admin-residency.ts` | 4 | 4 | ✅ | F-32 fixed (PR #1806) — `residency.workspace_assign` / `migration_request` / `migration_retry` / `migration_cancel` emitted. `workspace_assign` metadata carries explicit `permanent: true` so triage flags the irreversibility, and emits failure-status audits on validation / conflict errors so 409 probes for the current region leave a trail |
| `admin-roles.ts` | 4 | 4 | ✅ | F-25 fixed (PR #1800) — `role.create` / `role.update` / `role.delete` / `role.assign` emitted with success + failure paths; update captures previousPermissions, delete pre-fetches so metadata retains the deleted role, assign captures previousRole |
| `admin-sandbox.ts` | 2 | 0 | ❌ | Connect/disconnect BYOC sandbox (F-37) |
| `admin-scim.ts` | 3 | 3 | ✅ | `scim.connection_delete` / `scim.group_mapping_create` / `scim.group_mapping_delete` — F-23 fixed |
| `admin-semantic-improve.ts` | 4 | 4 | ✅ | F-35 fixed — `semantic.improve_draft` on `/chat`, `semantic.improve_accept` / `improve_reject` on `/proposals/{id}/approve+reject`, `semantic.improve_apply` (approved) / `improve_reject` (rejected) on `/amendments/{id}/review`. Rejection branches on the DB-backed route collapse to `improve_reject` so forensic queries catch both surfaces |
| `admin-semantic.ts` | 3 | 3 | ✅ | `semantic.update_entity` / `semantic.delete_entity` |
| `admin-sessions.ts` | 2 | 2 | ✅ | F-28 fixed (PR #1801) — `user.session_revoke` / `user.session_revoke_all` emitted with success + failure paths; single-session path pre-fetches target userId and records `wasCurrentUser` |
| `admin-sso.ts` | 6 | 4 | 🟡 | Configure / update / delete / test audited; **`POST /providers/{id}/verify` + `PUT /enforcement` unaudited** (F-29) |
| `admin-starter-prompts.ts` | 4 | 4 | ✅ | F-35 fixed — `starter_prompt.approve` / `hide` / `unhide` emit on successful moderation outcomes (gated on `outcome.status === "ok"` so 403/404 paths do not produce audit rows); `starter_prompt.author_update` emits on the admin-authored seed path with the new suggestion id + text |
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

**Shipped (PR #1807):** Added `systemActor` field to `logAdminAction`'s `AdminActionEntry` — validated against `/^system:[a-z0-9][a-z0-9_-]*$/` at call time so a typo or rename fails loudly instead of writing a malformed audit row. The reserved literal `system:audit-purge-scheduler` lives in one place (`ee/src/audit/purge-scheduler.ts`) and is imported by `retention.ts`. New `audit_log.purge_cycle` domain emits once per `runPurgeCycle` tick (even at zero rows — absence is the signal that the scheduler stopped) with metadata `{ softDeleted, hardDeleted, orgs }`. New `audit_retention.hard_delete` fires from the library layer only when `count > 0` to avoid flooding `admin_action_log` on every zero-row scheduler tick (the outer cycle row proves the scheduler is alive). Dedup picked at the **library layer**: `setRetentionPolicy` and `hardDeleteExpired` suppress their library-layer emission when an HTTP user is in `getRequestContext()`, so the existing F-26 route-level rows (with their richer previous-value / ipAddress metadata) are not doubled. Failure cycles also emit a `status: "failure"` cycle row so a compliance reviewer can tell a silent drop-off from an errored run.

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

**Shipped (batched with F-34):** Fixed the five primary subrouters called out above — `admin-sso.ts`, `admin-connections.ts`, `scheduled-tasks.ts`, `admin-approval.ts`, `admin.ts`. New `ADMIN_ACTIONS` entries (catalog growth): `sso.verify_domain`, `sso.enforcement_update`; `connection.probe` (ephemeral `POST /test` URL probes) + `connection.health_check` (registered `POST /:id/test` routine health checks) — split into two distinct action types per type-design review so compliance queries can separately count the privilege-escalation probe surface vs. routine operational signal without parsing a metadata discriminator (matches the `manualHardDelete` vs `hardDelete` / `archive` vs `archiveReconcile` pattern already in the catalog); `connection.pool_drain` (platform scope, covers org-wide drain only — per-connection `POST /:id/drain` remains in F-29 backlog); `schedule.trigger`, `schedule.preview`, `schedule.tick`; `approval.rule_create`, `approval.rule_update` (metadata holds `keysChanged: string[]` — never pattern / threshold values, those may be sensitive shape data for a compromised admin mapping the approval surface), `approval.rule_delete`, `approval.expire_sweep`; `user.password_change` (self-action, `targetId: actorId` pinned in regression test; emitted BEFORE the post-Better-Auth `password_change_required` flag clear so a flag-clear failure doesn't lose the audit row — Better Auth has already committed the new password, so the route now log-warns + returns success on flag-clear errors rather than 500-ing and dropping both the row and the user's trust); `semantic.bulk_import`. `schedule.tick` uses the F-27 `system:scheduler` reserved actor, emits even at zero tasks, and fires a failure-status row on engine errors so scheduler drop-off is distinguishable from healthy silence (absence of a row is the signal). Prompt originally called for `sso.group_mapping_update` — corrected to `sso.enforcement_update` since no `group-mappings` route exists on `admin-sso.ts` (group mappings live on `admin-scim.ts`; cross-check with the F-29 PR-status table row above). Per-file regression coverage landed in five new test files mirroring the F-31 `admin-orgs-audit.test.ts` pattern: `admin-sso-audit.test.ts`, `admin-connections-audit.test.ts`, `scheduled-tasks-audit.test.ts`, `admin-approval-audit.test.ts`, `admin-password-semantic-import-audit.test.ts`, plus `admin-wizard-save-audit.test.ts` carrying the parity pin. Multi-agent review pass added: silent-failure-hunter flagged the password flag-clear gap (fixed), comment-analyzer caught a dead `POST /connection-test` reference in the wizard comment + "this PR" language rot (both tightened), type-design-analyzer prompted the probe/health-check split (shipped). Remaining in F-29 backlog (open): `admin-integrations.ts` (1 orphaned write), `admin-invitations.ts` (invitation-revoke), `platform-sla.ts` (`POST /evaluate`), and `admin-connections.ts`' per-connection `POST /:id/drain` path — tracked as F-29 residuals in #1784.

**F-29 residuals shipped (bundled with F-46, see below):** All four remaining routes audited (#1828). `admin-integrations.ts` `POST /email/test` → new `integration.test` action (`hasSecret` omitted — request body carries only `recipientEmail`; the test exercises stored creds, not new ones). `admin-invitations.ts` `DELETE /users/invitations/:id` → new `user.revoke_invitation` action with pre-fetched `invitedEmail` + `role` + `previousStatus` so the forensic context survives a future retention-purge of the invitations table. `platform-sla.ts` `POST /evaluate` → new `sla.evaluate` action at platform scope; metadata carries only `newAlertCount` (alert payloads are PII-adjacent across workspaces). `admin-connections.ts` `POST /:id/drain` → reuses the org-wide `connection.pool_drain` action with `scope: "workspace"` + `targetId: connectionId`; failure-path emission on throw so a mid-flight pool-drain error still lands a forensic row. Per-file regression tests: `admin-integrations-audit.test.ts`, `admin-invitations-audit.test.ts`, `platform-sla-audit.test.ts`, and an extension to `admin-connections-audit.test.ts` covering the per-id path.

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

**Issue:** #1787. Fixed in PR #1806 — all 12 writes now emit `logAdminAction`. `residency.workspace_assign` metadata carries `permanent: true` and emits failure-status audits on conflict / validation paths (409 probes for the current region leave evidence). Branding / compliance / residency read endpoints intentionally stay silent. Regression coverage: `admin-domains.test.ts`, `admin-branding.test.ts`, `admin-residency.test.ts`, and new `admin-compliance.test.ts`.

---

**F-33 — Abuse reinstate writes to `abuse_events`, not `admin_action_log` — split audit trail** — P2 — **FIXED**

**Repro:** `POST /api/v1/admin/abuse/{workspaceId}/reinstate` → `reinstateWorkspace()` → `persistAbuseEvent()` → row in `abuse_events`. No `logAdminAction` call anywhere in the flow.

**Impact:** Compliance queries that scan `admin_action_log` for "what did platform admins do today?" miss every reinstate action entirely. A reviewer investigating billing anomalies ("why are there 500k queries from a previously suspended workspace?") has to know to cross-reference a second table. Phase-2 F-09 fixed the role gate but didn't unify the audit path.

The in-module handler code path (`admin-abuse.ts` lines 296–312) explicitly acknowledges this gap in its fail-mode branch: when `hasInternalDB()` is false, it logs a warning but still returns success. That's a real-world silent-failure path where *no audit row exists at all* — not in `abuse_events`, not in `admin_action_log`, not anywhere.

**Fix sketch:** Call `logAdminAction({ actionType: "workspace.reinstate_abuse", targetType: "workspace", targetId: workspaceId, scope: "platform", metadata: { previousLevel } })` alongside the `abuse_events` row. Dual-write is cheap and closes the compliance query gap.

**Severity:** P2 — evidence exists but in the wrong place. Not a compliance failure per se, but a consistent-view failure. Scored one tier below F-31 (P1) despite being the same class of "dual-surface write, split trail" because reinstate is not enumerated in the phase-4 high-stakes list and `abuse_events` retains a full record including actor + timestamp + previous level; F-31's `admin-orgs.ts` writes leave no trail at either surface for anyone who picks the unaudited path.

**Status:** fixed (PR #1808). `ADMIN_ACTIONS.workspace.reinstateAbuse` (`"workspace.reinstate_abuse"`) added to the catalog. `reinstateWorkspace()` now returns `ReinstatedLevel | null` where `ReinstatedLevel = Exclude<AbuseLevel, "none">` — the previous level on success, `null` when the workspace is not flagged — so the route can feed `previousLevel` straight into audit metadata without a second getter call. The named alias lives at the module boundary so audit-metadata typing, mock fixtures, and the function signature stay in lockstep as `ABUSE_LEVELS` evolves. The route emits `logAdminAction({ actionType: "workspace.reinstate_abuse", targetType: "workspace", targetId: workspaceId, scope: "platform", metadata: { previousLevel } })` alongside the existing `persistAbuseEvent()` call; both writes happen for every successful reinstate. The `!hasInternalDB()` branch no longer short-circuits the audit attempt — `logAdminAction` is called unconditionally (noop-safe when no internal DB, consistent with F-30 / F-31 / F-32 sites) so the pino trail survives on the admin-action-log side; `persistAbuseEvent` short-circuits without a pino line on that path, which is a deliberate asymmetry documented in the route comment. The response schema gained a first-class `auditPersisted: boolean` field so non-UI clients (CLI, integrations, smoke tests) can branch on one boolean without parsing `warnings[]`; the `audit_persist_skipped` warning still surfaces for UI banner rendering. Regression coverage is split across two layers:  `admin-abuse.test.ts` parameterizes the dual-write across all three `ReinstatedLevel` values (pins identity pass-through into audit metadata), asserts the 400 not-flagged branch does NOT emit `logAdminAction` (so compliance row counts match real state transitions, not clicks), and asserts the no-internal-DB branch emits `auditPersisted: false` + `audit_persist_skipped` + still calls `logAdminAction`; `abuse.test.ts` captures `internalExecute` and pins the `INSERT INTO abuse_events` SQL with `previousLevel` in the metadata params so a future regression that deletes the `persistAbuseEvent` call (or drops `previousLevel`) fails at the lib layer before ever reaching the route mocks.

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

**Shipped (batched with F-29):** Wizard `POST /save` emits `connection.create` with canonical `{ name, dbType }` metadata — dbType resolved from `connections.describe()` at emit time (falls back to `"unknown"` when the runtime registry has no entry, e.g. pre-restart; best-effort dbType beats zero forensic signal). The emission is deliberately broader than "connection row written" — audit research note: wizard's `/save` actually persists entity YAMLs for an already-selected connection, not a new connection row, because the wizard's Step 1 reads from `/api/v1/admin/connections` and selects an existing connection. The prompt treats `/save` as the onboarding-completion signal, which means a typical wizard run produces TWO `connection.create` rows (one from `admin-connections` POST, one from wizard `/save`). That's deliberate — compliance queries counting distinct connections should group by targetId; the duplicate signals the wizard path completed for the onboarding funnel. Wizard `/connection-test` (probe; corresponds to `admin-connections`' `POST /test` in this codebase) is NOT audited from wizard — high-volume / low-forensic-signal, and the admin-connections probe IS audited, so the privileged probe surface is covered. Parity pinned in `admin-wizard-save-audit.test.ts`: a single test exercises both `admin-connections` POST / and wizard `/save` for the same connection payload, then asserts the emitted entries share `actionType`, `targetType`, `targetId`, and structurally-equal metadata keys — a rename on either surface breaks the suite.

---

**F-35 — Prompt library + semantic-improve + starter-prompt moderation writes unaudited** — P2 — **FIXED**

Bundled class — content-governance admin writes:

- `admin-prompts.ts` (7 writes): prompt collection + prompt CRUD.
- `admin-semantic-improve.ts` (4 writes): AI-assisted semantic layer drafts + apply.
- `admin-starter-prompts.ts` (4 writes): queue moderation (approve / hide / unhide / author).

**Impact:** Content-governance actions that affect every user of the workspace (starter prompts surfaced on first-run, prompts in the library, semantic drafts that reshape agent SQL). No trail of who approved / hid / applied. Same shape as the learned-patterns surface that IS audited (`pattern.approve` / `pattern.reject` / `pattern.delete` in `admin-learned-patterns.ts`).

**Resolution:** 15 new action types added to `ADMIN_ACTIONS` — `prompt.{collection_create, collection_update, collection_delete, create, update, delete, reorder}`, `semantic.{improve_draft, improve_apply, improve_accept, improve_reject}`, `starter_prompt.{approve, hide, unhide, author_update}`. Each of the 15 write routes emits `logAdminAction` on success. Metadata contracts:

- Content items: `{ id, name }` (collection create additionally carries `industry` + `status`; prompt items carry `collectionId`).
- Moderation decisions: `{ id, name }` for starter-prompt approve/hide/unhide/author; `{ id, decision }` for amendment review.
- Reorder: `{ collectionId, newOrder: string[] }` — the full ordered id list so drag-and-drop forensics can replay the admin's intent.
- `semantic.improve_*` carries `{ sessionId, proposalIndex, entityName, amendmentType }` where available; the `/chat` draft row additionally marks `resumed: boolean` so a resumed session is distinguishable from a fresh one.

Rejection paths on `POST /amendments/{id}/review` collapse to `semantic.improve_reject` (rather than keeping the route-anchored `improve_apply`) so forensic queries can filter on a single action_type regardless of which surface — in-memory session or DB-backed amendment — rejected a proposal. Delete handlers pre-fetch `{ id, name }` so the audit row survives the row's removal (matches the F-25 role-delete pattern).

Starter-prompt moderation emits are gated on `outcome.status === "ok"`: 403/404 outcomes do not emit, keeping the trail clean of probe attempts (the 403 boundary is already covered by the `adminAuth` middleware and the test suite pins the non-emission on the forbidden/not-found branches).

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

**Status:** fixed phase 1. Design + data layer landed in PR <this-pr> (closes #1791 phase 1; Phase 2 admin-UI surface tracked in follow-up). Design commitments codified in `.claude/research/design/admin-action-log-retention.md` and pinned by tests:
- **Erasure shape — option 1 (NULL + `anonymized_at` timestamp).** Migration `0035_admin_action_retention.sql` adds `anonymized_at TIMESTAMPTZ` to `admin_action_log`, relaxes `actor_id` / `actor_email` to nullable so the erasure writer can scrub both columns to NULL, and carries a partial index `idx_admin_action_log_anonymized_at` for scrubbed-row forensic queries. `anonymizeUserAdminActions(userId, initiatedBy)` in `ee/src/audit/retention.ts` runs the UPDATE inside a single-statement CTE with an `anonymized_at IS NULL` idempotency guard so a second erasure run does not refresh the first-scrub timestamp.
- **Retention default — 7 years (`2555` days).** Parallel `admin_action_retention_config` table (separate from `audit_retention_config`, not a `table_name` discriminator on it — see D4 of the design doc) reuses `MIN_RETENTION_DAYS = 7` and `DEFAULT_HARD_DELETE_DELAY_DAYS = 30` by shape parity. No per-org row exists until policy is set; an operator who never configures a policy gets unlimited retention (same convention as audit-log).
- **pino boundary — out-of-band.** The forensic store is `admin_action_log`; pino is the operational log. Phase 1 does not redact pino pre-write; the Phase 2 UI will carry helper copy reading "Identifiers are removed from the audit log. Pino / operational logs are controlled by your log-aggregator retention policy." This keeps operational triage readable while the regulator-facing promise ("prove user X's identifier is gone") resolves against the DB.
- **Self-audit row shape — per-table, not combined.** Scheduler emits two rows per tick: `audit_log.purge_cycle` (existing, F-27) and `admin_action_log.purge_cycle` (new). The two branches are independent `Effect.tryPromise` calls so one table's failure cannot suppress the other's cycle row; the F-27 "absence of a cycle row = scheduler stopped" invariant extends to per-table granularity so a reviewer can detect a table-scoped outage.
- **`user.erase` emits even at zero rows.** The regulator-facing contract is "we processed the request" — a zero-row erasure is still forensic evidence. Metadata carries `{ targetUserId, anonymizedRowCount, initiatedBy: "self_request" | "dsr_request" | "scheduled_retention" }` with a runtime guard on `initiatedBy` so a typo at a future callsite fails loudly instead of quietly rewriting the DSR-reporting split.

**Phase 2 (admin UI surface) tracked as #1813** — `/admin/audit/retention` gains a second tab for admin-action retention, plus a "Erase user" action that calls `anonymizeUserAdminActions`. Phase 2 is a UI-only follow-up; the data contract is frozen by this PR.

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

- **`admin_action_log`**: mutations are tightly scoped and all legitimate post-F-36:
  - `UPDATE admin_action_log SET actor_id = NULL, actor_email = NULL, anonymized_at = now() WHERE actor_id = $1 AND anonymized_at IS NULL` — `ee/audit/retention.ts#anonymizeUserAdminActions` (GDPR / CCPA right-to-erasure; idempotent via the NULL guard).
  - `DELETE FROM admin_action_log WHERE ... AND timestamp < now() - ...` — `ee/audit/retention.ts#purgeAdminActionExpired` (retention-window hard-delete under `admin_action_retention_config`).
  Both paths are documented + gated by retention / erasure and fire self-audit rows under the `system:audit-purge-scheduler` actor. No route-layer mutation paths. Enforcement is still convention-level at the DB (no RLS policy, no per-role grant revocation); a misbehaving future route could technically issue either statement. **Mitigation:** migration to `REVOKE UPDATE, DELETE ON admin_action_log FROM app_role` tracked as F-40 below (P3).
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
| F-27 | P1 | Self-audit | EE purge scheduler + retention mutations (`ee/audit/*`) | #1782 | fixed (PR #1807) |
| F-28 | P1 | Audit gap | Admin session revocation (`admin-sessions.ts`, `admin.ts`) | #1783 | fixed (PR #1801) |
| F-29 | P2 | Partial coverage | `admin-sso.ts`, `admin-connections.ts`, `scheduled-tasks.ts`, `admin-approval.ts`, `admin.ts` stragglers | #1784 | fixed (batched with F-34 — see below) |
| F-30 | P1 | Credential-provenance | Email provider + model config (`admin-email-provider.ts`, `admin-model-config.ts`) | #1785 | fixed (PR #1805) |
| F-31 | P1 | Audit gap | Platform-admin workspace CRUD via `admin-orgs.ts` (post-F-08 drift) | #1786 | fixed (PR #1804) |
| F-32 | P1 | Audit gap | Workspace enterprise config (`admin-domains.ts`, `admin-branding.ts`, `admin-residency.ts`, `admin-compliance.ts`) | #1787 | fixed (PR #1806) |
| F-33 | P2 | Split trail | Abuse reinstate writes to `abuse_events`, not `admin_action_log` | #1788 | fixed (PR #1808) |
| F-34 | P2 | Audit gap | Wizard connection path bypasses `connection.create` (`wizard.ts`, plus connection test/drain in `admin-connections.ts`) | #1789 | fixed (batched with F-29 — see below) |
| F-35 | P2 | Audit gap | Prompt / semantic-improve / starter-prompt moderation | #1790 | fixed (PR #1809) |
| F-36 | P2 | Retention | `admin_action_log` unbounded, no purge, no GDPR erasure path | #1791 | fixed phase 1 (data layer) — Phase 2 UI is a follow-up |
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

---

## Phase 5 — Secrets + error surfaces + plugin credentials

**Status:** audit complete (2026-04-24); fixes tracked per-finding.
**Scope:** static + dynamic audit of every surface where a secret could
escape Atlas: 500-response bodies, pino logs, Effect-level logs, client
bundles (`@atlas/web`, `@useatlas/react` widget entry), plugin config
storage + rotation story, and workspace integration secrets (Slack /
Teams / Discord / Telegram / GChat / GitHub / Linear / WhatsApp / email
provider + custom-domain DNS tokens + sandbox BYOC credentials + AI
provider BYOT). Matches #1724 scope list verbatim.
**Issue:** #1724
**Branch:** `security/1-2-3-phase-5-audit`

### Methodology

1. **Tagged-error path sweep.** Walk every variant in the `AtlasError`
   union (`packages/api/src/lib/effect/errors.ts`) and confirm each has
   an HTTP mapping in `mapTaggedError()`; grep every message literal for
   a raw URL / apiKey / password / token substring. `classifyError()`
   (the function that drives `runHandler` + `runEffect`) lives in
   `packages/api/src/lib/effect/hono.ts` — the #1724 scope list names
   `lib/effect/classify.ts`, which does not exist; the code is in
   `hono.ts` (F-49 doc-fix).
2. **500-body capture.** Every `return c.json({ error: ..., message: ... }, 500)`
   site across `packages/api/src/api/routes/*.ts` inspected for message
   shape. Special focus on connection-test wizard + admin-connections
   create/update/test/drain because these receive a URL with embedded
   credentials. Confirmed `err.message` from `detectDBType()` /
   `connections.healthCheck()` never echoes the URL (`detectDBType` has
   a fixed message referencing the env var; `healthCheck` catches
   internally and returns a `HealthCheckResult.message` scrubbed through
   `matchError()`).
3. **FiberFailure pattern audit.** Grep every `Effect.runPromise(...)`
   call site to find the systematic-risk pattern that F-37 / #1798
   identified on `IPAllowlistError`: an EE function that fails with a
   tagged error, then `Effect.runPromise` wraps the tagged failure in a
   `FiberFailure` wrapper, then the outer `.catch` checks `"code" in err`
   which is now `false`. Cross-reference with where the error surfaces
   (route response, internal log, transaction rollback).
4. **Pino redact audit.** Read `packages/api/src/lib/logger.ts` redact
   path list; confirm every listed secret field (`url`, `apiKey`,
   `password`, `authorization`, `*.connectionString`, etc.) is covered
   at top-level, one-deep, and array-of-objects shapes. Cross-check
   against every `log.warn({ err, ... })` site for messages that could
   contain an embedded connection-string userinfo (e.g., pg errors echo
   `postgres://user:pass@host`) where pino redact does not cover
   substrings inside a string value.
5. **Effect-level logs.** Grep `Effect.logInfo` / `Effect.logDebug` /
   `Effect.logWarn` / `Effect.logError` — zero call sites (`grep -r` on
   `packages/api/src` returns nothing). The codebase uses `createLogger()`
   (pino wrapper) throughout; F-28's `errorMessage()` scrub helper is
   the audit-metadata analogue, not a log-sink filter.
6. **Client-bundle inspection.** Walk every `process.env.*` usage in
   `packages/web/src/` + `packages/react/src/`. Confirm every
   `NEXT_PUBLIC_*` reference is intentionally public. Trace every
   non-`NEXT_PUBLIC_*` env var read to its callsite to confirm it runs
   only on the server (server components, API handlers, Next.js
   instrumentation). Build output inspection skipped in favor of
   source-level proof because (a) all server-only env reads are in
   files never imported by `"use client"` components and (b) Next.js
   statically replaces only `NEXT_PUBLIC_*` — other vars resolve to
   `undefined` in the browser.
7. **Widget-bundle inspection.** Read `packages/react/src/widget-entry.ts`
   + `packages/react/tsup.config.ts`. Confirm the widget bundle is
   `platform: "browser"`, pulls React + AtlasChat + `setTheme`, and
   reads zero env vars. The widget is loaded unauthenticated from
   third-party sites — any env access would be a critical leak.
8. **Plugin credential storage.** Read every `plugin_settings` +
   `workspace_plugins` write site; trace secret-marked fields through
   the DB column (plain JSONB), then through the GET-back path to
   confirm masking. Grep every `plugins/*/src/index.ts` config schema
   for `secret: true` markers. Compare against the precedent
   (`workspace_model_config.api_key_encrypted` — AES-256-GCM at rest).
9. **Workspace integration secrets.** Walk every `packages/api/src/lib/*/store.ts`
   (`slack`, `teams`, `discord`, `telegram`, `gchat`, `github`, `linear`,
   `whatsapp`, `email`) and inspect the CREATE TABLE migration for each
   credential column. Confirm (or contradict) the F-30 `hasSecret: true`
   audit-metadata coverage across all BYOT paths in
   `admin-integrations.ts`. Inspect the custom-domain DNS token shape
   (migration 0033) separately.
10. **Key rotation story.** Trace `getEncryptionKey()` in
    `packages/api/src/lib/db/internal.ts` — derived from
    `ATLAS_ENCRYPTION_KEY ?? BETTER_AUTH_SECRET` via SHA-256. Search the
    codebase for any re-encryption migration, dual-key transition
    helper, or operator-facing doc describing how to rotate this key.

### Surfaces walked — fingerprint

| Surface | Files inspected | Outcome |
|---|---|---|
| Tagged-error → HTTP mapping | `lib/effect/errors.ts`, `lib/effect/hono.ts` (`mapTaggedError`, `classifyError`, `isEnterpriseError`, domain-error registry) | messages generic, status codes correct — F-49 doc-fix only |
| 500-body shape | 52 route files under `packages/api/src/api/routes/` | one systematic pattern risk (F-52 FiberFailure) + admin-connections `err.message` paths cleared |
| Connection-test routes | `admin-connections.ts` lines 442–510 (test), 510–650 (create), 680–790 (update), 800–880 (archive); `wizard.ts` (profile, generate, save); `onboarding.ts` (`/test-connection`) | `detectDBType` never echoes URL; `healthCheck` scrubs via `matchError` internally; `encryptUrl` protects stored URLs |
| Pino redact paths | `lib/logger.ts:44-78` (27 paths) | covers every canonical top-level + 1-deep + array shape; gap is substring-in-error-message (F-44) |
| Effect-level logs | whole repo | zero `Effect.logXxx` sites — N/A |
| Client bundle env | `next.config.ts`, every `packages/web/src/**` tsx/ts with `process.env` | four `NEXT_PUBLIC_*` vars (ATLAS_API_URL, ATLAS_AUTH_MODE, OPENSTATUS_SLUG, STATUS_URL) all public-safe; one hygiene note (F-50) |
| Widget bundle | `widget-entry.ts`, `tsup.config.ts` (widget target) | 20-line entry, bundles React + AtlasChat + setTheme; no env reads — verified |
| Plugin config storage | `lib/plugins/settings.ts`, `schema.ts:324-330` (`plugin_settings`), migrations `0014_plugin_marketplace.sql` (`workspace_plugins`), `admin-plugins.ts`, `admin-marketplace.ts` | both tables plaintext JSONB; platform plugin surface masks on GET, marketplace surface does not (F-42 + F-43) |
| Integration secret storage | `slack_installations.bot_token`, `teams_installations.app_password`, `discord_installations.bot_token`, `telegram_installations.bot_token`, `gchat_installations`, `github_installations`, `linear_installations.api_key`, `whatsapp_installations`, `email_installations.config`, `sandbox_credentials.credentials` | every column plaintext (F-41) |
| BYOT audit-metadata coverage | 18 `logAdminAction` sites in `admin-integrations.ts` | `{ platform, mode: "byot" }` emitted; `hasSecret: true` missing on every platform vs. F-30 precedent (F-46) |
| AI provider keys | `settings.ts:393-413` (ANTHROPIC_API_KEY, OPENAI_API_KEY), `admin.ts:2323` (secret settings read-only from UI), `ee/platform/model-routing.ts:216-251` (workspace BYOT — `api_key_encrypted`) | platform keys env-only (never persisted); workspace BYOT keys encrypted via `encryptUrl`; no leakage on test/update/delete paths |
| Custom domain DNS token | migration `0033_custom_domains_dns_verification.sql` | plaintext `verification_token` — not a credential (F-51) |
| Key-rotation helper | `internal.ts:40-54` (`getEncryptionKey`), whole-repo grep | no rotation path (F-47) |

### Findings

**F-41 — Workspace integration secrets stored as plaintext columns** — P1

**Repro:**

```sql
\d slack_installations;                       -- bot_token TEXT
\d teams_installations;                       -- app_password TEXT (migration 0006)
\d discord_installations;                     -- bot_token TEXT (migration 0006)
\d telegram_installations;                    -- bot_token TEXT
\d gchat_installations;                       -- various credential columns
\d github_installations;                      -- various credential columns
\d linear_installations;                      -- api_key TEXT
\d whatsapp_installations;                    -- various credential columns
\d email_installations;                       -- config JSONB (carries apiKey / serverToken / password / secretAccessKey depending on provider)
\d sandbox_credentials;                       -- credentials JSONB (Vercel / E2B / Daytona tokens)
```

**Impact:** A DB dump (backup, disk image, read-replica snapshot,
compromised read-only credential) exposes every workspace's chat
platform bot tokens and email provider API keys verbatim. Both are
*high-value* credentials: a bot token lets an attacker impersonate the
Atlas bot in Slack / Teams / Discord / Telegram, read all channels it
was invited to, and send messages appearing to come from Atlas. Email
provider keys (Resend, SendGrid, Postmark, SES) let an attacker send
phishing email from the customer's authenticated sender address. Both
bypass Atlas authentication because the bearer credential IS the
secret — no additional challenge step stands between the DB dump and
the attack.

Precedent: connection URLs are encrypted at rest via `encryptUrl` in
`internal.ts` (AES-256-GCM with an `iv:authTag:ciphertext` format) —
same class of bearer credential, different storage policy.
`workspace_model_config.api_key_encrypted` uses the same encryption
helper for BYOT AI keys. Integration tables are the odd ones out.

**Compliance lens:** SOC 2 CC6.1 / CC6.7 (data-at-rest encryption for
sensitive data); GDPR Article 32 ("appropriate technical and
organisational measures"); ISO 27001 A.10.1 (cryptographic controls).
A customer signing an MSA with a data-protection addendum will ask
"are integration tokens encrypted at rest?" — the honest answer today
is "no."

**Fix sketch:** Extend `encryptUrl`/`decryptUrl` (or add a parallel
`encryptSecret`/`decryptSecret` pair) to each `*Installations` store
write + read path. Migration plan: (a) add `_encrypted` columns
alongside the plaintext, (b) dual-write for a release, (c) one-shot
migration to encrypt existing rows using current key, (d) flip reads
to the encrypted column, (e) drop the plaintext column. Same pattern
the connections table took. `email_installations.config` is JSONB —
either encrypt the whole blob or split secret vs non-secret fields
into two columns. `sandbox_credentials.credentials` follows the same
shape decision.

**Severity:** P1 — not an active exploit (requires DB access), but the
systematic at-rest encryption gap fails a standard compliance audit
and the fix is mechanical given the `encryptUrl` precedent.

**Issue:** #1815.

**Step 4 shipped (PR #N — F-41 + F-42 soak cleanup, closes #1832):**
plaintext columns dropped after soak (migration
`0040_drop_integration_plaintext.sql`); `_encrypted` columns are now
NOT NULL on every table whose original plaintext was NOT NULL pre-0036
(Slack `bot_token_encrypted`, Telegram `bot_token_encrypted`, GChat
`credentials_json_encrypted`, GitHub `access_token_encrypted`, Linear
`api_key_encrypted`, WhatsApp `access_token_encrypted`, Email
`config_encrypted`, Sandbox `credentials_encrypted`); Teams + Discord
encrypted columns stay nullable because admin-consent / OAuth-only
installs persist no bearer credential by design. Back-compat
fall-through in every integration store deleted — reads call
`decryptSecret(<col>_encrypted)` directly, and the JSONB carriers
(email + sandbox) call `JSON.parse(decryptSecret(...))` inline instead
of `pickEncryptedConfig` / `pickEncryptedCredentials`. Helper functions
`pickDecryptedSecret` (and the email/sandbox config-pick variants) are
removed from `secret-encryption.ts` along with their unit tests; the
F-47 `UnknownKeyVersionError` discriminator stays exported for
rotation tooling. `packages/api/src/lib/db/backfill-integration-credentials.ts`
deleted with its test file (one-shot tool — never runs post-drop).
Pre-flight enforced by the F-42 audit script (#1835) — every region
must report zero residue rows before merge; the migration's leading
comment + this PR's description enumerate the operator checks
explicitly. Status flipped from open → shipped.

---

**F-42 — Plugin config stored as plaintext JSONB (platform + workspace)** — P1

**Repro:**

```
plugin_settings.config              JSONB  -- per-plugin (platform-wide); admin-plugins.ts PUT /:id/config
workspace_plugins.config            JSONB  -- per-workspace; admin-marketplace.ts PUT /:id/config
```

Multiple plugins declare secret-marked config fields:

- `plugins/slack/src/index.ts`: `signingSecret`, `botToken`, `clientSecret`
- `plugins/salesforce/src/index.ts`: OAuth client secret + refresh token
- `plugins/jira/src/index.ts`: API token
- `plugins/e2b`, `plugins/daytona`, `plugins/vercel-sandbox`: sandbox
  provider API keys
- `plugins/chat`, `plugins/email-digest`: provider API keys
- `plugins/webhook`: HMAC signing secret

All are written verbatim into the `config` JSONB column via
`savePluginConfig()` / the marketplace `PUT /:id/config` handler.

**Impact:** Same class as F-41. A DB dump exposes every plugin's
credential material. Higher impact when the plugin talks to a
customer-owned destination (Slack workspace, Salesforce org, sandbox
API) because the attacker gets a foothold into the customer's own
systems, not Atlas.

`admin-plugins.ts` masks secret-marked fields on `GET /:id/schema`
readback using the `MASKED_PLACEHOLDER = "••••••••"` convention
(`admin-plugins.ts:346-355`). That masks the API response but not the
DB column — an operator with DB read access still sees the plaintext.

**Fix sketch:** Encrypt secret-marked fields at write time in
`savePluginConfig()`. Because the plugin SDK already declares
`secret: true` on its config schema (`@useatlas/plugin-sdk`), the
write path has the metadata it needs to selectively encrypt without
touching non-secret fields. Key rotation story is F-47 — same
encryption key as connection URLs means rotating the key affects every
surface at once.

**Severity:** P1 — compliance failure, mechanical fix, precedent
exists.

**Issue:** #1816.

**Soak audit shipped (PR #N — F-41 + F-42 soak cleanup, closes #1835):**
new read-only `packages/api/scripts/audit-plugin-config-residue.ts`
walks every `plugin_settings.config` and `workspace_plugins.config`
row, joins on `plugin_catalog.config_schema` to identify per-plugin
secret keys, asserts every `secret: true` value matches the
`enc:v\d+:` prefix, and folds in the F-41 invariant
(`<col>_encrypted IS NOT NULL` for every row in `NON_NULL_ENCRYPTED_TABLES`)
in the same pass. Exits `0` with a single-line JSON report (scanned
counts + secret-fields-verified count) when clean; exits `2` with
row IDs (NOT values) per affected table/key when any residue is
found. Idempotent and safe against a production replica. Strict-mode
opt-in `ATLAS_STRICT_PLUGIN_SECRETS=true` rejects plugin admin writes
whose catalog schema is corrupt or carries per-key secret-vs-passthrough
drift, returning `422 Unprocessable Entity` with an actionable
message — wired into all three write surfaces (`admin-plugins.ts` PUT,
`admin-marketplace.ts` POST install, `admin-marketplace.ts` PUT). Default
off preserves the historical idempotent-but-tolerant baseline; SaaS
regions opt in via env var. `INTEGRATION_TABLES` extracted to
`packages/api/src/lib/db/integration-tables.ts` as the single source
of truth shared by rotation + audit (replaces the dropped backfill's
`TABLES` constant). Status flipped from open → shipped.

---

**F-43 — Marketplace `GET /available` returns raw `installedConfig` without masking secrets** — P1

**Repro:** `GET /api/v1/admin/plugins/marketplace/available` (defined
in `admin-marketplace.ts:682-719`) returns `installedConfig: inst?.config ?? null`
for each catalog entry the workspace has installed.

`inst.config` is the raw JSONB blob from `workspace_plugins.config`.
For a plugin whose catalog entry declares `secret: true` fields
(stored in `plugin_catalog.config_schema`), the secret values land in
the response body unchanged.

Compare `admin-plugins.ts` (the platform-plugin surface) which uses a
`MASKED_PLACEHOLDER` for the same field type.

**Impact:** Any workspace admin role (which includes every org owner)
can read stored credentials by calling the marketplace endpoint.
Because workspace admin is already the persona authorized to install
the plugin, the credential disclosure is "rereading what I wrote" —
but the UX precedent from the platform surface says these values are
write-only once saved. A lower-role admin added to the workspace
later *inherits* read access without having typed the credential.

Additionally: `logAdminAction` for `plugin.config_update` emits
`keysChanged: string[]` only, NOT the values (F-22 precedent). The
disclosure path is only the GET, not the audit log.

**Fix sketch:** Look up the catalog entry's `config_schema` in the
same handler, walk the JSONB response, and replace any
`secret: true` key's value with `MASKED_PLACEHOLDER`. The write path
already tolerates the placeholder (same pattern as
`admin-plugins.ts:416-421`). A second fix required at
`admin-marketplace.ts:711` (`installedConfig: inst?.config`) — that
line is the single chokepoint.

**Severity:** P1 — live credential disclosure to any workspace admin;
read-write asymmetry vs. the platform surface; fix is ~20 lines.

**Issue:** #1817.

---

**F-44 — pino error logs don't run through `errorMessage()` scrubber; userinfo survives in logs** — P2

**Repro:** `packages/api/src/lib/logger.ts` redact path list covers
field names (`url`, `password`, `apiKey`, `*.url`, etc.), not
substrings inside string values. A pg / mysql driver error that
echoes `connection to postgres://user:pass@host:5432/db failed` lands
in pino via `log.warn({ err: err.message }, "...")` where the top-level
field is `err`, not `url`. `err` is not redacted. Result: the
connection-string userinfo (username + password) survives into pino
output, logfiles, stdout, and downstream log aggregation (Grafana
Loki, Railway log stream, Datadog, etc.).

Precedent: F-28 shipped `errorMessage()` / `causeToError()` in
`packages/api/src/lib/audit/error-scrub.ts` specifically to scrub
`scheme://user:pass@host` userinfo from audit metadata. Not applied
to pino log sinks.

Call sites affected (partial list — every `err: err.message` log emission
where `err` could carry a DB driver error message):

```
packages/api/src/api/routes/admin-connections.ts:447, 476, 531, 574, 605, 630, 689, 704, 746, 764, 785
packages/api/src/api/routes/onboarding.ts:419, 508, 545
packages/api/src/lib/db/connection.ts:1025 (healthCheck internal log)
```

**Impact:** Any log aggregator operator (DevOps team, oncall engineer,
support reviewing a Railway log stream during triage) can read
admin-provided connection credentials out of the log feed. In a SaaS
deployment this expands the audience dramatically — Atlas platform
operators shouldn't see customer datasource credentials, ever.

**Fix sketch:** Add a pino `formatters.log` or `serializers.err`
hook that runs every string field through `errorMessage()`. Cheaper
alternative: wrap `createLogger(...)` so the returned logger has
pre-applied scrubbers on `log.warn`/`log.error`. Even cheaper: replace
`err: err instanceof Error ? err.message : String(err)` with
`err: errorMessage(err)` at every flagged call site and lint-enforce it
(eslint-plugin-no-raw-error-message).

**Severity:** P2 — operationally high-impact (log-feed audience is
broad in SaaS), no live HTTP-surface leakage so not P1.

**Issue:** #1818.

---

**F-45 — Duplicate `errorMessage` / `causeToError` helpers in 3 routes (drift risk)** — P3 → merged into F-44

`admin-scim.ts:39-59`, `admin-residency.ts:40-72`, `admin-roles.ts:46-72`
each define a local copy of `errorMessage` + `causeToError` that is
byte-compatible with `packages/api/src/lib/audit/error-scrub.ts`. This
predates F-28's shared extraction.

Drift risk: the next scrub-rule added to the shared helper (e.g.,
JWT body scrubbing, PII masking for error detail strings, UUID
truncation) is not applied in these three routes unless each file is
manually kept in sync.

**Fix sketch:** Replace the three local copies with
`import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub"`.
Zero behavior change; pure consolidation. **Folded into the F-44 fix
PR** because the two findings touch the same module set and any
scrubber enhancement that F-44 introduces should land with the
duplicates removed.

**Severity:** P3 — hygiene, not live risk. Tracked as a dependency of
F-44 rather than a standalone issue to keep the PR count honest.

**Status:** no standalone issue; fix alongside F-44.

---

**F-46 — BYOT integration audit metadata lacks `hasSecret: true` marker** — P2

**Repro:** F-30 / PR #1805 landed `hasSecret: true` on email-provider +
model-config audit metadata as the load-bearing signal for "this admin
action wrote a credential." Grep `admin-integrations.ts` for
`hasSecret` — zero matches. Metadata shapes on BYOT paths:

```
Slack BYOT           — metadata: { platform: "slack", mode: "byot" }           (line 681)
Teams BYOT           — metadata: { platform: "teams", mode: "byot" }           (line 825)
Discord BYOT         — metadata: { platform: "discord", mode: "byot" }         (line 974)
Telegram connect     — metadata: { platform: "telegram" }                      (line 1108)
GChat connect        — metadata: { platform: "gchat" }                         (line 1344)
GitHub connect       — metadata: { platform: "github" }                        (line 1587)
Linear connect       — metadata: { platform: "linear" }                        (line 1847)
WhatsApp connect     — metadata: { platform: "whatsapp" }                      (line 2097)
```

All write a credential (bot token / app password / api key) as part of
the handler but emit no `hasSecret` marker.

**Impact:** Compliance review that relies on `metadata.hasSecret` to
filter credential-bearing admin actions misses every integration
install / BYOT connect. "How often did this org rotate integration
credentials this quarter?" returns zero rows.

**Fix sketch:** Add `hasSecret: true` to every `logAdminAction`
payload on BYOT / install paths that writes a credential-bearing
column. No change to downstream consumers required — the field is
already established. Trivial fix; consolidate with F-41 to land at
the same time the storage encryption is applied (they touch the same
handlers).

**Severity:** P2 — compliance-query gap, not live risk.

**Issue:** #1819.

**Shipped (bundled with F-29 residuals):** `hasSecret: true` landed on all
8 BYOT / connect audit emissions listed above. Additive metadata-shape
change only. `admin-integrations-audit.test.ts` pins the marker per
platform so a future emission drift (e.g., a new BYOT path missing the
flag) turns the suite red. The `integration.test` action newly added for
F-29 residuals deliberately *omits* the marker — the test endpoint
accepts only `recipientEmail` in the body; the credential exercised
is the saved one, consistent with `email_provider.test`'s precedent.
Noted follow-up: `admin-integrations.ts` `POST /email` (install at
line 2335) writes a credential-bearing config JSONB (SMTP password /
SendGrid apiKey / Postmark serverToken / SES access key / Resend
apiKey) but its emission stayed at `{ platform, provider }` since the
issue body explicitly enumerated 8 handlers — trivial follow-up.

---

**F-47 — No key-rotation path for `ATLAS_ENCRYPTION_KEY`** — P2

**Repro:** `getEncryptionKey()` in `packages/api/src/lib/db/internal.ts:40-54`
derives the 32-byte AES key from
`ATLAS_ENCRYPTION_KEY ?? BETTER_AUTH_SECRET` via SHA-256. Every
ciphertext (`connections.url`, `workspace_model_config.api_key_encrypted`,
any future encrypted column) is encrypted under this single key.

Grep the repo for re-encryption / dual-key / key-versioning logic —
zero matches. Rotating `ATLAS_ENCRYPTION_KEY` (or `BETTER_AUTH_SECRET`
when it's the fallback key) renders every existing ciphertext
undecryptable. `decryptUrl` throws; every read of a connection URL or
BYOT API key fails.

**Impact:** SOC 2 CC6.1 (cryptographic key management) typically
requires a documented rotation schedule and a defined rotation
procedure. Atlas has neither. Operator incident: a suspected
key-compromise event forces an immediate rotation; without a dual-key
window, every workspace's connections + model config must be
re-entered by the admin because the ciphertext is now unreadable.
No backwards-compatible rollback either.

Secondary concern: `BETTER_AUTH_SECRET` is the Better Auth session
signing key, semantically separate from encryption-at-rest. Making
it the fallback means rotating the session signing key (a common
Better Auth operational step) silently destroys datastore secrets.
The fallback is convenient for self-hosted bootstrap but dangerous
for SaaS.

**Fix sketch:** (a) Add a key-version column to every encrypted table
(`connections.url_key_version`, `workspace_model_config.api_key_key_version`);
(b) support a comma-separated `ATLAS_ENCRYPTION_KEYS` list with the
first entry as the active write key and subsequent entries as read-only
decrypt-legacy keys; (c) document a rotation runbook: add new key as
second entry → rolling deploy → re-encrypt migration → promote new
key to first position → drop old key. Optional phase 2: decouple from
`BETTER_AUTH_SECRET` entirely (warn on startup if the fallback is in
use in a deploy where `ATLAS_DEPLOY_MODE=saas`).

**Severity:** P2 — compliance-posture gap with operational risk
(rotation is a documented SOC 2 control), no live-exploit bar.

**Issue:** #1820.

---

**F-48 — Widget-bundle sanity — verified, no finding** — —

`packages/react/src/widget-entry.ts` is 20 lines. It imports
`createElement`, `Component` (React), `createRoot` (ReactDOM/client),
`AtlasChat` (local component), `setTheme` (local hook), and exposes
them on `globalThis.AtlasWidget`. Zero `process.env` references.
Zero fetch calls with hard-coded URLs. Zero server module imports.
`tsup.config.ts` sets `platform: "browser"` for the widget target,
which forbids node built-ins; `noExternal: /.*/` bundles all React
deps in-line. Any server-side import would fail the build, not
silently bundle.

Result: the widget bundle is clean. No finding filed.

---

**F-49 — `#1724` scope references non-existent `lib/effect/classify.ts`** — P3 → doc-only

Issue #1724 scope list names `packages/api/src/lib/effect/classify.ts`
as a key file. No such file exists on `main` — the classification
code (`classifyError`, `mapTaggedError`) lives in
`packages/api/src/lib/effect/hono.ts`. This is a scope-doc typo, not
a code issue. Noting it so a future audit doesn't waste cycles
searching for the missing file.

**Severity:** P3 hygiene; doc-fix on the scope list if/when #1724 is
reopened for commentary.

**Status:** no issue filed; noted here.

---

**F-50 — Non-`NEXT_PUBLIC_*` env read in client-reachable module (`shared/lib.ts`)** — P3

**Repro:** `packages/web/src/app/shared/lib.ts:31-37` defines
`getApiBaseUrl()` which reads
`process.env.NEXT_PUBLIC_ATLAS_API_URL || process.env.ATLAS_API_URL || "http://localhost:3001"`.
The file is imported by `packages/web/src/app/report/[token]/*.tsx`
(a Next.js server component page + a `"use client"` report-view
component).

Next.js only statically inlines `NEXT_PUBLIC_*` env vars in client
bundles; non-public env reads resolve to `undefined` in the browser.
So `process.env.ATLAS_API_URL` evaluates to `undefined` client-side,
the `||` falls through to `"http://localhost:3001"`, and no secret
leaks. Confirmed by reading the import context (report-view.tsx is
`"use client"` but imports only a *type* from `shared/lib.ts`, so the
module code never executes in the browser).

**Impact:** zero as currently wired. But the pattern is a foot-gun —
a future client component that imports `getApiBaseUrl()` would
silently point at localhost in production instead of the real API.
Hygiene issue, not a secret leak.

**Fix sketch:** Either (a) remove the `ATLAS_API_URL` fallback and
rely solely on `NEXT_PUBLIC_ATLAS_API_URL` (the API URL is not a
secret — a SaaS deployment already advertises it in the auth cookie
domain), or (b) split the server-only fallback into a separate module
that `"use client"` components cannot import. Prefer (a) — simpler.

**Severity:** P3 hygiene, not a live risk.

**Status:** no issue filed; low-volume cleanup-tail candidate.

---

**F-51 — Custom-domain `verification_token` stored plaintext** — P3

**Repro:** migration `0033_custom_domains_dns_verification.sql` adds
`custom_domains.verification_token TEXT`. The token is a random
string used as the value in the customer's DNS TXT record so Atlas
can confirm domain ownership.

A verification_token IS NOT a persistent credential. Its only use is
"does this TXT record match what Atlas generated?" — compromise of
the token lets an attacker post the same TXT record to a domain they
already control, which doesn't accomplish anything (they still need
domain control for the DNS write). Impact is scoped to the single
one-time verification step. Storage plaintext is therefore
acceptable; flagged for completeness because the Phase 5 scope asked.

**Severity:** P3 — not a finding; documented for future-audit
visibility.

**Status:** no issue filed.

---

**F-52 — `Effect.runPromise` + FiberFailure unwrap — systematic risk pattern** — P3

**Repro:** F-37 / #1798 already identified this on `IPAllowlistError`:
`Effect.runPromise(eeEffect)` flattens a typed `_tag` failure into a
`FiberFailure` wrapper that does NOT expose the inner `.code`. Any
caller that checks `"code" in err` after `Effect.runPromise` silently
degrades to 500 instead of the tagged status.

Other `Effect.runPromise` sites in `packages/api/src`:

```
server.ts:266                    — runtime bootstrap; defects are fatal, response shape N/A
admin-publish.ts:226             — runPublishPhases; caught by outer try/catch; response is generic "publish_failed"
admin-ip-allowlist.ts:190        — list; never fails with a tagged error; pattern intact for list path
db/internal.ts:269,463,596,1542,1627  — read-layer helpers; caller owns classification
db/connection.ts:1433            — region-database-URL resolution; outer try/catch falls back to default datasource
agent.ts:521,541                 — background work; no route response
scheduler/engine.ts:404          — scheduler-tick entrypoint (`runTick`); caller owns scheduler-level error surface
scheduler/executor.ts:83         — scheduler path; separate audit
scheduler/delivery.ts:314        — scheduler path
tools/sql.ts:1019,1049,1052,1239 — approval path + validator; errors surface via catchTag earlier, not tagged-to-FiberFailure
tools/python-sandbox.ts:233,439  — sandbox; errors not tagged
semantic/entities.ts:419         — admin surface; outer try/catch generic
auth/middleware.ts:198           — SSO enforcement; failure already handled with generic "fail-closed"
email/engine.ts:332              — scheduler
```

All 13 locations verified by `grep -rn "Effect.runPromise" packages/api/src --include="*.ts"` against the checked-in codebase on the PR branch. None surface a tagged error through a FiberFailure to a route-level classifier.

Most of these don't expose a tagged error through a FiberFailure to a
route-level classifier — either the inner effect doesn't fail with a
tagged type, or the outer catch returns a generic message regardless.
Two sites on the edge of the pattern:

- `admin-publish.ts:226` — `runPublishPhases` can fail with
  `PublishPhaseError`; the outer `catch` returns a generic 500 with
  message "Publish failed — all changes rolled back." The tagged
  error is logged but not surfaced to the client. This is the
  correct posture for a transaction-rolled-back surface.
- `admin-ip-allowlist.ts:190` (list handler) — list never fails with
  a tagged error; kept for historical context in comments. The
  add/delete handlers have been migrated to direct `yield*` on the
  EE effect (correct pattern) per the #1798 fix.

**Impact:** No live-exploit path at the current call graph. Risk is
that a future contributor copies the `Effect.runPromise` + catch
pattern into a new route where the inner effect DOES fail with a
tagged error, and the bug silently ships at 500 instead of the
intended 400 / 409 / 404.

**Fix sketch:** Lint rule or doc note in `lib/effect/hono.ts` JSDoc
warning against `Effect.runPromise(eeEffect)` + catch-and-classify in
route handlers. Prefer composing with `yield* ee.xyz().pipe(Effect.catchTag(...))`
per the admin-ip-allowlist.ts:232-259 pattern. Alternatively, export
a helper that unwraps FiberFailure back to the inner tagged error so
classify logic keeps working on the boundary.

**Severity:** P3 — no live exploit, pattern documentation + optional
lint.

**Status:** no issue filed; noted here for future contributors. If a
P2+ instance surfaces during remediation, it gets promoted.

---

### Append: pino `redact` paths audit

Current list (`packages/api/src/lib/logger.ts:44-78`):

```
connectionString, databaseUrl, apiKey, password, secret, authorization, url,
*.connectionString, *.databaseUrl, *.apiKey, *.password, *.secret, *.authorization, *.url,
[*].connectionString, [*].databaseUrl, [*].apiKey, [*].password, [*].secret, [*].authorization, [*].url,
datasources.*.url, datasources.*.connectionString, datasources.*.password,
config.datasources.*.url, config.datasources.*.connectionString,
connection.url, connection.connectionString, connection.password,
connections.*.url, connections.*.connectionString, connections.*.password
```

Missing paths worth adding (P3 hygiene — not separate findings
because the F-44 fix covers the underlying "error-message substring"
gap):

- `cookie`, `set-cookie`, `[*].cookie`, `*.cookie` — bearer cookies
- `bearer`, `[*].bearer`, `*.bearer` — Better Auth bearer plugin token shape
- `refreshToken`, `*.refreshToken`, `[*].refreshToken` — OAuth refresh token shape
- `botToken`, `*.botToken`, `[*].botToken` — Slack/Discord/Telegram BYOT
- `signingSecret`, `*.signingSecret` — Slack / webhook plugin
- `clientSecret`, `*.clientSecret` — OAuth-app-level secret
- `webhookSecret`, `*.webhookSecret` — webhook plugin
- `appPassword`, `*.appPassword` — Teams BYOT
- `serverToken`, `*.serverToken` — Postmark email provider

Add alongside the F-44 fix so the error-substring scrubber and the
field-name redact rules stay in lockstep.

### Considered, not filed

- **`err.message` in 500 bodies at `admin-connections.ts:463, 479, 594, 736`** —
  messages originate from `detectDBType()` (fixed string referencing
  `ATLAS_DATASOURCE_URL`, never echoes the URL) or from
  `connections.healthCheck()` (catches internally + scrubs via
  `matchError()`). Confirmed no URL substring can survive into the
  response.
- **Plugin readback on platform surface (`admin-plugins.ts` `GET /:id/schema`)** —
  masks secret-marked fields via `MASKED_PLACEHOLDER`. Correct posture;
  contrasts with the marketplace surface gap (F-43).
- **`workspace_model_config.api_key_encrypted`** — already encrypted
  via `encryptUrl` (EE `ee/platform/model-routing.ts:216-251`). BYOT
  test path (`testModelConfig`) uses the apiKey in a one-shot HTTP
  probe and never persists it outside the encrypted column. No
  finding.
- **Platform-level `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`** — `settings.ts`
  marks them `secret: true`; `admin.ts:2323` forbids mutation via the
  settings UI (`"Secret settings cannot be modified from the UI"`).
  Env-only, never persisted, never surfaced. No finding.
- **Public `branding` / `domain` / `residency` audit-metadata field review** —
  every sampled payload carries IDs / enums / booleans (phase-4
  F-32 PR #1806 already reviewed the metadata shape). No leakage.
- **Custom-domain `verification_token` plaintext storage** — not a
  credential; see F-51 rationale.
- **Non-`NEXT_PUBLIC_*` env read in `shared/lib.ts`** — runtime-safe
  (resolves to `undefined` in the browser); see F-50 rationale.
- **`Effect.runPromise` sites in `db/internal.ts`, `agent.ts`,
  `scheduler/*`, `db/connection.ts:1433`** — none surface tagged errors
  through a FiberFailure to a route-level classifier; see F-52
  rationale.
- **OAuth state nonces (`oauth_state` table)** — phase-1 F-04 / PR #1748
  covered the auth-gap on Slack/Teams/Discord install routes and
  confirmed the single-use `DELETE ... RETURNING` consume. The state
  payload is `{ orgId, provider }` — no credential material, no bearer
  token. Plaintext storage is acceptable; no phase-5 concern.
- **Better Auth session tokens** — session cookies are set by Better
  Auth, flagged `httpOnly + secure + sameSite=lax` per phase-1. The
  token value never appears in application code (Better Auth owns
  `/api/auth/*` and the cookie jar). Pino redact covers `authorization`
  + `cookie` is a P3 gap folded into F-44's redact-path hygiene list.
  No standalone finding.
- **Stripe webhook secret handling** — `STRIPE_WEBHOOK_SECRET` is
  env-only, consumed once in the webhook handler's signature verify
  step (`stripe.webhooks.constructEvent`), and never persisted.
  Mirrors the AI provider key posture (env-only, `settings.ts`
  `secret: true`, admin UI `admin.ts:2323` read-only guard). No
  leakage path.

### Findings summary

| ID | Severity | Type | Surface | Compliance lens | Issue | Status |
|---|---|---|---|---|---|---|
| F-41 | P1 | At-rest encryption gap | Workspace integration tokens (Slack/Teams/Discord/Telegram/GChat/GitHub/Linear/WhatsApp/email/sandbox) | SOC 2 CC6.1 / GDPR A32 / ISO A.10.1 | #1815 / #1832 | shipped |
| F-42 | P1 | At-rest encryption gap | `plugin_settings.config` + `workspace_plugins.config` plaintext JSONB | SOC 2 CC6.1 / GDPR A32 | #1816 / #1835 | shipped |
| F-43 | P1 | Live disclosure | Marketplace `GET /available` returns `installedConfig` raw (no secret mask) | SOC 2 CC6.7 (logical access) | #1817 | open |
| F-44 | P2 | Log redaction | pino `err.message` passes through driver-echoed connection strings | SOC 2 CC7.2 (monitoring) | #1818 | open |
| F-45 | P3 | Hygiene | Duplicate `errorMessage`/`causeToError` helpers in 3 routes | — | merged into F-44 (#1818) | deferred |
| F-46 | P2 | Audit-metadata coverage | BYOT integration paths don't emit `hasSecret: true` | SOC 2 CC7.2 | #1819 | fixed (bundled with F-29 residuals — see F-46 shipped note) |
| F-47 | P2 | Operations | No key-rotation path for `ATLAS_ENCRYPTION_KEY`; fallback entangles with Better Auth signing key | SOC 2 CC6.1 (key management) | #1820 | open |
| F-48 | — | Verified no leak | `@useatlas/react` widget entry | — | n/a | verified |
| F-49 | P3 | Doc-fix | `#1724` scope list references missing `classify.ts` | — | — | noted |
| F-50 | P3 | Hygiene | `shared/lib.ts` reads non-`NEXT_PUBLIC_*` env in client-reachable module | — | — | noted |
| F-51 | P3 | Verified not a credential | `custom_domains.verification_token` plaintext | — | — | noted |
| F-52 | P3 | Pattern risk | `Effect.runPromise` + FiberFailure unwrap (systematic) | — | — | noted |

**Totals:** P0 = 0, P1 = 3 (F-41, F-42, F-43), P2 = 3 (F-44, F-46, F-47), P3 = 4 (F-45 merged into F-44; F-49 / F-50 / F-51 / F-52 noted without issues); F-48 is an affirmative-verification row, not a finding.

### Deliverables this PR

- **This audit section** — table + 6 P1/P2 issue-bearing findings + 1
  P3 merged-into-P2 + 4 P3 noted-only + 1 affirmative-verification row.
- **6 GitHub issues filed** (#1815 – #1820) for every P0/P1/P2 finding
  (none here are P0). Labels: `bug`, `security`, and one of `area: api`,
  `area: plugins`, `area: web` per the scope of the handler touched.
  Milestone `1.2.3 — Security Sweep`.
- **Phase-5 checkbox flipped** in the tracker (#1718).
- **ROADMAP update** — Phase 5 bullet annotated per the phase-4 pattern
  (audit complete, remediation PRs follow).
- **No production code changes** — fixes ship as follow-up PRs per the
  phase-1/2/3/4 workflow. F-41 + F-42 + F-43 likely cluster into one
  "integration + plugin credential encryption + marketplace mask" PR
  because they touch overlapping module sets; F-44 + F-45 cluster
  into one "pino error-scrubber + duplicate-helper consolidation" PR;
  F-46 can bundle with F-41 (same handlers); F-47 ships standalone as
  migration + runbook.

Fixes for F-41 through F-47 are follow-up PRs. Priority ordering:
F-43 first (live disclosure, small fix), then F-41 + F-42 + F-46
(clustered credential encryption + hasSecret marker), then F-44 + F-45
(pino scrubber), then F-47 (rotation runbook + key-versioning
migration).

---

## Phase 6 — Rate limiting + timeouts + DoS surfaces

**Status:** audit complete (2026-04-24); fixes tracked per-finding.
**Scope:** every throttle / timeout / pool / queue cap on the public API
surface — agent loop step + wall-clock caps, SQL validator
LIMIT/timeout, per-tenant connection pools, per-user/org throttles on
expensive routes (`/chat`, `/publish`, admin bulk imports, semantic
sync, plugin install), unauthenticated route inventory, Python sandbox
execution + memory + queue caps across all backends, and webhook
signature + replay + rate-limit posture. Matches #1725 scope list
verbatim.
**Issue:** #1725
**Branch:** `security/1-2-3-phase-6-audit`

### Methodology

1. **Route inventory.** Walk every `app.route(...)` registration in
   `packages/api/src/api/index.ts` and the middleware applied at each
   mount point (`adminAuth` / `platformAdminAuth` / `standardAuth` /
   `withRequestId` / unauth). Cross-reference against `routes/*.ts` to
   confirm `.use(...)` does what the mount comment claims. Same shape
   Phase 4 used for write routes — three columns this time
   (auth-required, rate-limited, timeout-bounded) instead of audit
   coverage.
2. **Agent + SQL caps.** Trace `runAgent` end-to-end
   (`packages/api/src/lib/agent.ts`) for the four caps the prompt named
   — `stepCountIs(getAgentMaxSteps())`, per-tool SQL timeout, total
   wall-clock budget per request, optional override for demo mode.
   Confirm `ATLAS_QUERY_TIMEOUT` is applied at the driver layer (not
   wrapped only in JS) for both PostgreSQL and MySQL paths. Confirm
   `ATLAS_ROW_LIMIT` is auto-appended by the validator.
3. **Pool capacity behaviour.** Read `packages/api/src/lib/db/connection.ts`
   start-to-finish — base + per-org pool config, LRU eviction order,
   `PoolCapacityExceededError` catch boundary, drain cooldown,
   consecutive-failure auto-drain threshold. Confirm exhaustion
   surfaces as a tagged 429 (graceful degrade), not an unhandled
   exception that kills a fiber.
4. **Per-route throttles.** Grep every authenticated handler for
   `checkRateLimit` call sites. Compare per-route weighting (chat = 25
   LLM steps; admin/audit = 1 DB query) against the single global
   `ATLAS_RATE_LIMIT_RPM` bucket.
5. **Unauthenticated route enumeration.** Walk every route file that
   either has no auth middleware (`new Hono()` constructor) or
   explicitly registers under `/api/public/*`. For each, confirm
   whether the handler reaches a paid surface (LLM, sandbox).
6. **Python + explore sandbox audit.** Read every backend in
   `packages/api/src/lib/tools/` (`python-nsjail.ts`, `python-sandbox.ts`,
   `python-sidecar.ts`, `explore-nsjail.ts`, `explore-sandbox.ts`,
   `explore-sidecar.ts`, `explore.ts` just-bash fallback) for per-call
   execution timeout, per-call memory cap, sidecar request queue / 429
   on overflow.
7. **Webhook signature + replay.** Enumerate every inbound webhook
   receiver across the codebase. `grep -rn "signature\|webhook\|HMAC"`
   then walk each — Stripe (Better Auth plugin), Slack
   (`/api/v1/slack/{commands,events,interactions}`), the webhook
   plugin (`POST /webhook/:channelId`). Confirm signature verification,
   timestamp window for replay, and rate limit posture for each.
   Verify Discord / Teams / Telegram / GChat / GitHub / Linear /
   WhatsApp don't expose webhook receivers (OAuth-only outbound
   surfaces).

### Surfaces walked — fingerprint

| Surface | Files inspected | Outcome |
|---|---|---|
| Auth-middleware coverage | `routes/middleware.ts`, `routes/admin-router.ts`, every `routes/*.ts` `.use(...)` and module-constructor pattern | every authenticated route runs through `adminAuth` / `platformAdminAuth` / `standardAuth`, all of which call `checkRateLimit` → `IP allowlist` → `misrouting` → `migration write-lock` (write methods only) before the handler. The `withRequestId` middleware is the no-auth context provider used by `/chat` (inline auth), `/query` (inline auth), `/widget*` (no auth needed), `/api/public/*` (no auth) — see route-inventory table |
| Rate limit | `lib/auth/middleware.ts:80-109` (sliding-window per-key) + `lib/db/source-rate-limit.ts:76-110` (per-source QPM + concurrency) + per-public-route in-memory limiters in `routes/conversations.ts:1191-1252` and `routes/dashboards.ts:124-153` + demo limiter in `lib/demo.ts:46-58` | five distinct limiters in the codebase. The global `ATLAS_RATE_LIMIT_RPM` defaults to 0 (disabled). Per-source DB rate limit defaults 60 QPM / 5 concurrent. Public-share routes default to 60 / 30 per IP / 60s. Demo mode 10 RPM. **No per-route weighting** between chat (25-step) and cheap reads (single query) — F-74 |
| Agent loop caps | `lib/agent.ts:622-633` | `stepCountIs(maxStepsOverride ?? getAgentMaxSteps())` (default 25, range 1-100, env `ATLAS_AGENT_MAX_STEPS`); `timeout: { totalMs: 180_000, stepMs: 30_000, chunkMs: 5_000 }` — full request budget capped at 180s wall-clock, per step at 30s, per stream chunk at 5s |
| SQL row LIMIT + timeout | `lib/tools/sql.ts:430-457` (settings reads), `lib/db/connection.ts:281` (PG `SET statement_timeout = ${timeoutMs}`), `lib/db/connection.ts:319-326` (MySQL `SET SESSION TRANSACTION READ ONLY` + `SET SESSION MAX_EXECUTION_TIME`) | `ATLAS_ROW_LIMIT` (default 1000) auto-appended by validator when `LIMIT` not present. `ATLAS_QUERY_TIMEOUT` (default 30000ms) applied at driver layer for both PG and MySQL — defense-in-depth against runaway queries even if the JS wrapper is bypassed |
| Per-tenant pool caps | `lib/db/connection.ts:399-417` (defaults), `:552-646` (lazy lookup + LRU), `:580-597` (capacity check + `PoolCapacityExceededError`), `:678-710` (close-and-evict path), `:909-931` (consecutive-failure auto-drain), `:1149-1166` (drain cooldown via Effect) | per-org pool: max 5 conns × 50 orgs (default), `maxTotalConnections = 100` global. LRU eviction triggers when capacity hit. `PoolCapacityExceededError` is mapped to `PoolExhaustedError` (`tools/sql.ts:553-559`) → 429 (`lib/effect/hono.ts:169`). Graceful degrade verified |
| Python sandbox timeouts + memory + queue | `lib/tools/python-nsjail.ts:23-30` (DEFAULT_TIME_LIMIT=30s, MEMORY=512MB, NPROC=16), `lib/tools/python-sandbox.ts:35,265-268` (Vercel: 30s timeout via env, no Atlas-layer memory cap), `lib/tools/python-sidecar.ts:18,46-50` (HTTP timeout = ATLAS_PYTHON_TIMEOUT default 30s + 10s overhead), `packages/sandbox-sidecar/src/server.ts:33-39` (sidecar concurrency cap = 10, MAX_TIMEOUT=120s) | nsjail has explicit time + memory caps; Vercel sandbox delegates memory to platform; sidecar enforces concurrency = 10 with 429 on overflow. Just-bash fallback (dev-only) has no wall-clock cap (F-78 noted) |
| Explore tool timeouts | `lib/tools/explore.ts:42-81` (just-bash with maxCommandCount=5000, no wall-clock), `lib/tools/explore-nsjail.ts:38-115`, `lib/tools/explore-sidecar.ts:95-141` (DEFAULT_TIMEOUT=10s) | nsjail + sidecar have explicit timeouts; just-bash uses `executionLimits.maxCommandCount = 5000` + `maxLoopIterations = 1000` but no wall-clock guard. Production warning logged when just-bash is the active backend |
| Stripe webhook signature + replay | `lib/auth/server.ts:498-505` (Better Auth Stripe plugin); upstream `stripe.webhooks.constructEvent` enforces signature + 5-min timestamp tolerance | F-82 verified-clean — replay protection delegated to the official Stripe SDK |
| Slack webhook signature + replay | `lib/slack/verify.ts:13` (MAX_TIMESTAMP_AGE_SECONDS = 300), `:42-46` (timestamp window check), `:48-67` (HMAC + timing-safe compare) | F-83 verified-clean — 5-min replay window + timing-safe compare |
| Webhook plugin signature + replay | `plugins/webhook/src/routes.ts:31-60` | HMAC + API-key auth implemented; **no replay protection** (F-75) and **no per-channel rate limit** (F-76). The two together let a captured signed request burn unbounded LLM cost |
| Other integrations | `routes/discord.ts`, `routes/teams.ts`, `lib/{telegram,gchat,github,linear,whatsapp}/store.ts` | OAuth-only / outbound message senders — no inbound webhook receivers. Verified by listing every `routes/*.ts` constructor and grepping for `webhook` / `signature` |
| Demo route caps | `lib/demo.ts:24-58` (max steps default 10, RPM default 10), `routes/demo.ts` agent invocation | demo mode enforces a *separate* RPM bucket and a lower `ATLAS_DEMO_MAX_STEPS` (10 vs 25 for the main chat). Token-gated by HMAC-signed email — F-88 verified-clean |
| Public-share routes | `routes/conversations.ts:1302-1407` (60 / 60s default), `routes/dashboards.ts:1133-1203` (30 / 60s default) | per-IP in-memory limiter exists. **Bypass when `ATLAS_TRUST_PROXY` is unset** because `getClientIP` returns `null` and the fallback `unknown-${requestId}` is per-request (F-73). Org-scoped shares additionally require auth and org-membership match |

### Route inventory

Same convention as Phase 4. Legend:

- **Auth**: `admin` / `plat` (platform_admin) / `std` (any authenticated) / `inline` (handler authenticates explicitly) / `none` (unauthenticated) / `secret` (shared-secret token, e.g. CRON_SECRET)
- **RL**: `g` (global `ATLAS_RATE_LIMIT_RPM` bucket from `checkRateLimit`), `p` (per-route in-memory limiter), `d` (demo limiter), `s` (per-source DB QPM via `withSourceSlot` for SQL-bearing routes), `n` (none)
- **Timeout**: `req` (per-request budget), `tool` (per-tool-call SQL timeout / sandbox timeout), `n` (none — handler is a single read or write with no long-running work)

| Mount | Auth | RL | Timeout | Notes |
|---|---|---|---|---|
| `POST /api/v1/chat` | inline | g | req + tool | 25-step + 180s + 30s/step + 5s/chunk; SQL via `withSourceSlot` (60 QPM / 5 concurrent default); plan + abuse + workspace status checks; F-74 / F-77 |
| `GET  /api/health/...` | none | n | n | Static status response; no DB / LLM |
| `*    /api/auth/*` | inline (Better Auth) | g | n | Catch-all to `getAuthInstance().handler`; signup body rewritten by `normalizeSignupResponseBody` to scrub error messages. Stripe webhook lives at `/api/auth/stripe/webhook` — F-82 verified |
| `POST /api/v1/query` | inline | g | tool | One-shot SQL through tools/sql.ts; same caps as chat tool path |
| `*    /api/v1/conversations` | std | g | n | CRUD on conversations (admin-RL bucket) |
| `GET  /api/public/conversations/:token` | none | p | n | Public share view; **rate limit broken without `ATLAS_TRUST_PROXY` (F-73)** |
| `*    /api/v1/dashboards` | std | g | n | CRUD on dashboards |
| `GET  /api/public/dashboards/:token` | none | p | n | Same shape as conversations — F-73 applies |
| `*    /api/v1/semantic` | std | g | n | Semantic-layer reads + diff |
| `*    /api/v1/tables` | std | g | n | Table list / metadata |
| `POST /api/v1/validate-sql` | inline | g | n | Pure validator — no execution |
| `*    /api/v1/prompts` | std | g | n | Prompt library reads + writes |
| `GET  /widget` | none | n | n | Static iframe HTML — no DB / LLM |
| `GET  /widget/atlas-widget.{js,css}` | none | n | n | Static asset bundles loaded once at module init |
| `GET  /widget.js` | none | n | n | Loader script (templated JS) |
| `GET  /widget.d.ts` | none | n | n | TypeScript declarations |
| `GET  /api/v1/branding` | none | n | n | Public branding read; cached + light DB |
| `GET  /api/v1/onboarding-emails/...` | inline | g | n | Signed-token onboarding email list |
| `GET  /api/v1/mode` | std | g | n | Returns published vs developer mode + draft counts |
| `*    /api/v1/starter-prompts` | std | g | n | Adaptive starter prompts surface |
| `*    /api/v1/onboarding/*` | std (per-route) | g | n | Self-serve signup flow; mixes std + inline |
| `*    /api/v1/wizard/*` | admin | g | n | Guided semantic-layer setup |
| `*    /api/v1/suggestions(/)` | std | g | n | Click-through tracking + suggestion list |
| `*    /api/v1/demo/*` | inline | d | req | Demo mode with separate RPM (10 default) + lower step cap (10) — F-88 |
| `*    /api/v1/actions/*` | std | g | n | Action approval flow (gated by `ATLAS_ACTIONS_ENABLED`) |
| `*    /api/v1/scheduled-tasks/*` | admin | g | n | CRUD on scheduled tasks |
| `POST /api/v1/scheduled-tasks/tick` | secret | n | tool | CRON_SECRET / ATLAS_SCHEDULER_SECRET via Bearer header; runs `runTick()` |
| `*    /api/v1/sessions/*` | std | g | n | Self session-revoke surface |
| `*    /api/v1/admin/*` | admin | g | n | Admin console mutations + reads (50+ routes); see Phase 4 audit table for the per-route audit detail. Includes `POST /api/v1/admin/publish` — atomic mode promotion, also `g`-bucketed |
| `POST /api/v1/internal/migrate/import` | secret | n | n | `ATLAS_INTERNAL_SECRET` via `X-Atlas-Internal-Token`; cross-region import. **No body-size limit / per-call rate limit** (F-80) |
| `*    /api/v1/platform/*` | plat | g | n | Cross-tenant platform admin |
| `*    /api/v1/billing/*` | admin | g | n | Subscription status + Stripe portal redirects (Stripe webhook is at `/api/auth/stripe/webhook`) |
| `POST /api/v1/slack/commands` | inline (Slack signature) | n | n | Acks within 3s, processes async; F-83 verified-clean |
| `POST /api/v1/slack/events` | inline (Slack signature) | n | n | Same |
| `POST /api/v1/slack/interactions` | inline (Slack signature) | n | n | Same |
| `GET  /api/v1/slack/install` | admin | g | n | OAuth install (admin-gated post-Phase-1 F-04) |
| `GET  /api/v1/slack/callback` | none | n | n | OAuth callback; state nonce single-use via `consumeOAuthState` (Phase 5 verified-clean) |
| `*    /api/v1/teams/*` | mixed | g | n | OAuth + bot install; admin-gated paths use `adminAuthPreamble` |
| `*    /api/v1/discord/*` | admin | g | n | OAuth-only outbound; no inbound webhook |
| `POST /webhook/:channelId` (plugin) | inline (HMAC / API-key) | n | n | Webhook plugin entrypoint — **no replay protection (F-75), no per-channel rate limit (F-76)** |

Total mounted route prefixes: 40 distinct `app.route(...)` mounts in `packages/api/src/api/index.ts`. The `admin` / `platform` mounts each fan out into ~50 / ~25 inner routes respectively — those inherit the parent's auth + RL posture. `withSourceSlot` rate limit applies to every SQL execution path regardless of which route invoked it, so it's a defense-in-depth layer below the table.

### Unauthenticated route inventory

Hitting any of these without credentials:

| Route | Handler | LLM? | Sandbox? | DB? | Risk |
|---|---|---|---|---|---|
| `GET /api/health/*` | static / pool stats | no | no | yes (pool counters) | low |
| `GET /widget` | static HTML | no | no | no | low — static |
| `GET /widget/atlas-widget.{js,css}` | static asset | no | no | no | low — static |
| `GET /widget.js` | static loader | no | no | no | low — static |
| `GET /widget.d.ts` | static .d.ts | no | no | no | low — static |
| `GET /api/v1/branding` | branding row | no | no | yes | low — single keyed read |
| `GET /api/public/conversations/:token` | shared conversation | no | no | yes | **F-73 rate-limit bypass** |
| `GET /api/public/dashboards/:token` | shared dashboard | no | no | yes | **F-73 rate-limit bypass** |
| `*    /api/auth/*` | Better Auth catch-all | no | no | yes | bounded by Better Auth's own rate limit + signup-email scrubber |
| `POST /api/v1/onboarding/test-connection` (when ATLAS_AUTH_MODE=none) | DB connectivity test | no | no | yes | gated by managed-auth-or-self-host check inside the handler |
| `GET /api/v1/slack/callback` | OAuth callback | no | no | yes | state nonce single-use; verified Phase 5 |
| `POST /api/v1/slack/commands,events,interactions` | Slack signature inline | yes (eventually) | maybe | yes | signature verifies sender; 5-min replay window |
| `POST /api/v1/scheduled-tasks/tick` | CRON_SECRET | yes (per scheduled task) | maybe | yes | shared-secret guard |
| `POST /api/v1/internal/migrate/import` | ATLAS_INTERNAL_SECRET | no | no | yes | shared-secret guard; **F-80: no body-size limit** |
| `POST /webhook/:channelId` (plugin) | HMAC / API-key inline | yes | maybe | yes | **F-75 / F-76** |

**No unauthenticated route hits a paid surface (LLM / sandbox) without an upstream credential check.** The Slack / scheduled-tasks / webhook surfaces all gate on a signature or shared secret. The widget is static. The `*  /api/auth/*` catch-all is signup / login / Stripe webhook — Better Auth owns the cost shape.

The closest call is `POST /webhook/:channelId` — once the channel secret is in the wrong hands, the handler bills the workspace operator for unbounded agent runs (F-75 + F-76). That's a credential-leak follow-on, not a primary unauth vector.

**No P0 from the unauth inventory.**

### Findings

**F-73 — Public-share rate limit silently no-op without `ATLAS_TRUST_PROXY`** — P1

**Location:** `packages/api/src/api/routes/conversations.ts:1329-1337`,
`packages/api/src/api/routes/dashboards.ts:1140-1148`,
`packages/api/src/lib/auth/middleware.ts:55-67`.

**Observation:** Both public-share endpoints implement an in-memory
per-IP rate limit (60 / 60s for conversations, 30 / 60s for
dashboards). The bucket key is `getClientIP(req) ?? \`unknown-${requestId}\``.
`getClientIP` only reads `x-forwarded-for` / `x-real-ip` when
`ATLAS_TRUST_PROXY` is `\"true\"` or `\"1\"`; otherwise it returns
`null`, and the `unknown-${requestId}` fallback creates a fresh
`crypto.randomUUID()`-keyed bucket on every request. The bucket count
starts at 1, never repeats, and the rate limit returns `true`
indefinitely.

**Attack shape:** Single attacker without `ATLAS_TRUST_PROXY` set runs
`seq 1 1000 | xargs -P 32 curl ...` against
`/api/public/conversations/:token` — server processes 32 concurrent
DB reads / second sustained. Pressure lands directly on the internal
Postgres (conversation + messages + notebook state for each call).
The rate limit comment in code says \"rate limited per IP\" but the
actual behavior depends on a separate operator decision that's easy to
miss.

**Score:** P1. Live in any deployment without `ATLAS_TRUST_PROXY`.
Self-hosted operators behind a reverse proxy adding the canonical
headers are routinely going to miss this env var.

**Suggested fix sketch:** Drop the per-request fallback. Either bucket
all anonymous traffic into a single `__public_unknown__` key (small
RPM ceiling, e.g. 10/min, gates the no-IP slow path) or derive a
stable surrogate from the `x-forwarded-for` header without trusting
it for IP-allowlist purposes. Option (a) is the smaller diff and
matches \"safe by default.\"

**Issue:** #1844.

---

**F-74 — Single global RPM bucket conflates chat (25-step LLM) with cheap reads** — P2

**Location:** `packages/api/src/lib/auth/middleware.ts:80-109`. Single
`windows: Map<string, number[]>` keyed on user ID or IP, single global
RPM ceiling (`ATLAS_RATE_LIMIT_RPM`).

**Observation:** Every authenticated route increments the same bucket
regardless of per-call cost. A chat request can fan out to 25 LLM
calls + same number of tool calls. An audit-log read costs one
Postgres query. Both subtract 1 from the same allowance. The
middleware comment at line 76-78 explicitly acknowledges:

> this limits API *requests*, not agent steps. A single chat request
> may run up to 25 agent steps internally, so effective LLM call
> volume can be higher than the RPM value implies.

There is no per-route weighting and no per-route override. A SaaS
deploy targeting cost-per-user budgets has to pick one RPM that
satisfies both \"fair load on /chat\" and \"don't break /audit/log
scrolling.\"

**Attack shape:** Compromised user account inside a workspace burns
the RPM ceiling on `/chat` for the full window, paying full LLM cost.
Mitigated by per-source DB rate limit (60 QPM / 5 concurrent), agent
step cap, agent wall-clock cap, plan-limit + abuse-detection — but no
per-bucket weighting at the chat surface itself.

**Score:** P2 — hardening, not a free-cost exploit. Cost ceiling per
request is bounded; per-window cost ceiling is not.

**Suggested fix sketch:** Two-tier RPM model — separate
`ATLAS_RATE_LIMIT_RPM_CHAT` (default `max(5, RPM/4)`) wired into the
chat handler, leaving the global RPM for cheap reads. Alternative:
token-bucket weighting where chat counts as N tokens.

**Issue:** #1845.

---

**F-75 — Webhook plugin has no replay-attack protection (no timestamp window)** — P2 — **shipped**

**Location:** `plugins/webhook/src/routes.ts:43-60` (`verifyHmac`),
`:31-41` (`verifyApiKey`).

**Observation:** Atlas's webhook plugin verifies inbound requests via
HMAC-SHA256 or API-key (timing-safe). Neither verification path
includes a timestamp / nonce — the signing input is the body alone.
A captured signed request stays valid forever. Each replay triggers
`executeQuery(query)` synchronously — full agent loop, full LLM cost,
full sandbox concurrency consumption.

Compare with Slack (`packages/api/src/lib/slack/verify.ts:42-46`)
which rejects requests outside `Math.abs(now - ts) > 300` seconds. A
5-minute timestamp window is the minimum bar for HMAC webhook signing.

**Attack shape:** Attacker captures a signed webhook request from any
upstream system (log scrape, MITM on a non-TLS internal hop,
compromised upstream sender). Replays it at line speed — every replay
invokes the full agent. Cost externality lands on the workspace
operator.

**Score:** P2. Exploit requires a captured signed request — that's a
credential-leak follow-on, not a primary vector. But the cost ceiling
once compromised is unbounded; the protection is the industry
standard and trivially missing.

**Suggested fix sketch:** Add `X-Webhook-Timestamp` (Unix seconds) to
the signing input — `${timestamp}:${body}` — and reject when the
delta is > 300s. Match the Slack pattern. Add a small recent-nonce
cache for in-window replay.

**Remediation:** Shipped in `plugins/webhook/src/replay.ts` (timestamp
window + nonce cache, 305s TTL keyed on `(channelId, signature)`),
wired through `routes.ts`. HMAC mode requires the timestamp by
default; api-key mode opts in via `requireTimestamp`. Soft-fail flag
`ATLAS_WEBHOOK_REPLAY_LEGACY=true` lets operators stage upstream
senders through the wire-format change before flipping to fail-closed.

**Issue:** #1846 — closed by the F-75/F-76 webhook hardening PR.

---

**F-76 — Webhook plugin has no per-channel rate limit; one secret leak = unbounded agent invocations** — P2 — **shipped**

**Location:** `plugins/webhook/src/routes.ts:115-236`.

**Observation:** Inbound `POST /webhook/:channelId` has no per-channel
rate limit. After auth (`verifyApiKey` / `verifyHmac`) the handler
calls `executeQuery(query)` synchronously, or in async mode runs
`processAsync()` without any in-flight queue cap. A leaked channel
secret produces unbounded agent runs until the operator notices.

The natural ceiling is `withSourceSlot` (60 QPM / 5 concurrent
default per datasource) — that bounds DB pressure, but not LLM token
spend or sandbox concurrency, both of which are paid surfaces.

**Attack shape:** Compromised channel secret → fire `POST
/webhook/:channelId` at line speed. A small operator monthly LLM
budget can be drained in minutes.

**Score:** P2. Pairs with F-75; both ship together to make the
webhook surface safe-by-default.

**Suggested fix sketch:** Per-channel `rateLimitRpm` + `concurrencyLimit`
on the `WebhookChannel` type. Borrow the `acquireSlot` /
`withSourceSlot` shape from `lib/db/source-rate-limit.ts` (lift to
`lib/throttle/` if shared with other plugins). Default to safe values
(60 RPM, 3 concurrent) so channels configured without overrides still
get a ceiling.

**Remediation:** Shipped in `plugins/webhook/src/throttle.ts`
(borrows the shape from `lib/db/source-rate-limit.ts` but stays
in-plugin so the standalone npm package keeps its no-`@atlas/api`
shape — lift to a shared module once a second plugin needs it).
Per-channel slot acquired before `executeQuery`, released in a
`finally` block (sync) or after `processAsync` settles (async).
Excess requests get `429` + `Retry-After` and a structured
`webhook.rate_limited` log line for downstream abuse signals. Default
ceilings 60 RPM / 3 concurrent apply when the channel doesn't
override.

**Issue:** #1847 — closed by the F-75/F-76 webhook hardening PR.

---

**F-77 — No aggregate per-conversation cost ceiling; unbounded agent runs across requests on the same conversationId** — P2

**Location:** `packages/api/src/lib/conversations.ts` (no aggregate
counter on conversations); `packages/api/src/api/routes/chat.ts:391`
(`addMessage` appends without bound).

**Observation:** Per-request caps are well-enforced — `stepCountIs(25)`,
180s wall-clock budget, 30s/step, 5s/chunk. There's no aggregate
budget across requests on the same conversation. A user can send N
follow-up messages on the same `conversationId`, each consuming its
own full budget. The conversation context grows monotonically (each
follow-up replays the full message history), so per-message LLM cost
grows roughly linearly with message count.

Mitigations partially in place:
- `checkAbuseStatus(orgId)` can throttle / suspend a workspace once
  abuse-detection flags it.
- `checkPlanLimits(orgId)` enforces SaaS plan ceilings.
- `getRequestContext().user.id` ties chat to a user for billing.

None of these enforce a per-conversation hard ceiling.

**Attack shape:** Authenticated user with a large open conversation
runs unbounded marginal cost on each follow-up. A 50-message ×
25-step × ~3k-tokens conversation = ~3.75M tokens consumed against
platform budget on one conversation, all within plan / abuse limits if
the workspace is on a generous tier.

**Score:** P2 — hardening. Not directly exploitable; pattern fragility
becomes acute when notebook + scheduled-task surfaces lift the
per-call ceiling further.

**Suggested fix sketch:** Track `total_steps` (or `total_tokens`) on
the `conversations` row. Reject new messages once the cap is hit; surface a
`conversation_budget_exceeded` error code so the chat UI renders
\"start a new conversation.\" Audit the rejection so abuse detection
gets a signal.

**Issue:** #1848.

---

### P3 noted-only

**F-78 — `just-bash` explore backend has no wall-clock timeout** — P3

`packages/api/src/lib/tools/explore.ts:40-81` builds the just-bash
backend with `executionLimits: { maxCommandCount: 5000,
maxLoopIterations: 1000 }`. Both are *count* limits; neither is a
wall-clock guard. A pathological grep over a huge semantic dir under
just-bash could run unbounded wall-clock time inside the JS process.

Production warning is logged when just-bash is the active backend
(\"SECURITY DEGRADATION: Explore tool running without process
isolation\"). nsjail / sidecar / Vercel sandbox all have explicit
wall-clock caps. Self-hosted dev fallback only — explicit operator
intent.

**Severity:** P3. Documented for completeness; no live exploit.

**Status:** No issue filed.

---

**F-79 — Vercel Python sandbox has no Atlas-layer memory cap** — P3

`packages/api/src/lib/tools/python-sandbox.ts:264-268` reads
`ATLAS_PYTHON_TIMEOUT` for the per-execution timeout but does not
configure a memory limit. Vercel's runtime applies its own caps; nsjail
sets `--rlimit_as 512` (default 512MB,
`packages/api/src/lib/tools/python-nsjail.ts:117`). Operators relying
on Vercel get whatever Vercel applies (typically 1024MB default for
the sandbox runtime; not surfaced in `@vercel/sandbox` API).

**Severity:** P3 — platform-managed; documented for parity with the
nsjail backend.

**Status:** No issue filed.

---

**F-80 — Internal cross-region migrate `/import` has no body-size limit / per-call rate limit** — P3

`packages/api/src/api/routes/admin-migrate.ts:354-410`. The endpoint
authenticates via `ATLAS_INTERNAL_SECRET` shared secret (timing-safe
compare). The bundle body has no upstream size limit and the call has
no rate limit — a large or repeated import floods the internal Postgres.

The shared secret is operator-controlled and never reaches a customer
surface. A compromised secret would already give the attacker
unbounded write into the internal DB; the body-size / rate-limit gap
is a secondary concern after that. P3 hardening.

**Severity:** P3 — hardening for a service-to-service surface.

**Status:** No issue filed.

---

**F-81 — Global `ATLAS_RATE_LIMIT_RPM` defaults to 0 (rate limiting disabled)** — P3

`packages/api/src/lib/auth/middleware.ts:34-46` returns 0 (\"disabled\")
when the env var is unset. Operator opt-in. SaaS deploys
(`app.useatlas.dev`) explicitly set this; self-hosted operators
typically don't. Per-source DB rate limit (60 QPM / 5 concurrent)
applies regardless and bounds DB pressure even when global RPM is off.

**Severity:** P3 — operator-config gotcha. Documented for visibility.
The fix lives in F-74 (per-route weighted bucket) — once that lands,
the default-on conversation can reopen with a sensible ceiling.

**Status:** No issue filed.

---

### Verified-clean rows (no finding)

**F-82 — Stripe webhook signature + replay protection (Better Auth Stripe plugin)**

`packages/api/src/lib/auth/server.ts:498-505` mounts the Better Auth
Stripe plugin. Inbound `/api/auth/stripe/webhook` verifies signature
+ timestamp tolerance via `stripe.webhooks.constructEvent` —
upstream Stripe SDK enforces a 5-minute timestamp window by default.
`STRIPE_WEBHOOK_SECRET` is env-only (Phase 5 F-50 verified). Plugin
is gated behind `STRIPE_SECRET_KEY` presence; without that the route
is not mounted. Verified-clean.

---

**F-83 — Slack signature verification + 5-min timestamp window + timing-safe compare**

`packages/api/src/lib/slack/verify.ts:13` (MAX_TIMESTAMP_AGE_SECONDS =
300), `:42-46` (replay-window check), `:48-67` (HMAC-SHA256 +
`crypto.timingSafeEqual`). All three Slack receivers
(`/api/v1/slack/{commands,events,interactions}`) call `verifyRequest`
before dispatching. Verified-clean.

---

**F-84 — Sandbox sidecar concurrency cap + 429 on overflow**

`packages/sandbox-sidecar/src/server.ts:33-39` — `MAX_CONCURRENT = 10`,
`activeExecs` counter incremented per request, 429 returned when at
capacity. Both `/exec` (shell) and `/exec-python` paths share the
counter. Sidecar request queue is implicit (Bun's HTTP server
backpressure) but bounded by 10 in-flight × max-timeout (60s shell /
120s python). Verified-clean.

---

**F-85 — Per-source DB rate limit (60 QPM / 5 concurrent default) on every datasource**

`packages/api/src/lib/db/source-rate-limit.ts:24-27` (`DEFAULT_LIMIT`),
`:76-110` (`acquireSlot`), `:112-133` (`withSourceSlot` Effect
helper). Wraps every SQL execution path in
`packages/api/src/lib/tools/sql.ts`. Failures map to 429 via
`RateLimitExceededError` / `ConcurrencyLimitError` →
`hono.ts:159-170`. Defense-in-depth — applies even when the global
`ATLAS_RATE_LIMIT_RPM` is disabled. Verified-clean.

---

**F-86 — Connection pool LRU + drain cooldown + graceful 429 on capacity exceeded**

`packages/api/src/lib/db/connection.ts:399-417` (defaults: per-org
maxConnections=5, maxOrgs=50, drainThreshold=5; `maxTotalConnections=100`),
`:552-646` (lazy create + LRU eviction), `:580-597` (capacity check
throws `PoolCapacityExceededError`), `:909-931` (consecutive-failure
auto-drain), `:1149-1166` (drain cooldown via Effect.sleep).
`PoolCapacityExceededError` is mapped at `tools/sql.ts:553-559` to
`PoolExhaustedError` → 429 (`hono.ts:169`). Pool exhaustion never
crashes the process; the worst case is a graceful 429 to the caller.
Verified-clean.

---

**F-87 — SQL row LIMIT + per-statement timeout enforced at driver layer for both PG and MySQL**

`packages/api/src/lib/tools/sql.ts:1210-1211` auto-appends `LIMIT
${rowLimit}` when not present (`ATLAS_ROW_LIMIT` default 1000).
`packages/api/src/lib/db/connection.ts:281` runs `SET
statement_timeout = ${timeoutMs}` per Postgres connection acquisition;
`:319-326` runs `SET SESSION TRANSACTION READ ONLY` + `SET SESSION
MAX_EXECUTION_TIME = ${safeTimeout}` per MySQL connection. Both apply
the timeout at the *driver* layer — defense-in-depth even if the JS
wrapper is bypassed. Verified-clean.

---

**F-88 — Demo mode separate rate limit (10 RPM) + lower max steps (10) + signed-token gate**

`packages/api/src/lib/demo.ts:24-58` — `ATLAS_DEMO_RATE_LIMIT_RPM`
(default 10, separate bucket from main `ATLAS_RATE_LIMIT_RPM`),
`ATLAS_DEMO_MAX_STEPS` (default 10, range 1-100). Demo route gated
by HMAC-SHA256-signed email token (`signDemoToken` /
`verifyDemoToken`) derived from `BETTER_AUTH_SECRET` with `:demo`
suffix. 24-hour token TTL. Verified-clean — the separate
limiter + lower step cap are the intentional differential trust
posture.

---

**F-89 — Agent loop step + wall-clock + per-step + per-chunk caps**

`packages/api/src/lib/agent.ts:622-633` —
`stopWhen: stepCountIs(maxStepsOverride ?? getAgentMaxSteps())`
(default 25, env `ATLAS_AGENT_MAX_STEPS`, range 1-100); `timeout:
{ totalMs: 180_000, stepMs: 30_000, chunkMs: 5_000 }`. The
`getAgentMaxSteps()` reader (`:59-70`) clamps invalid values to the
default and warns once per change. Demo override path sets a lower
cap. Per-tool SQL timeout via `ATLAS_QUERY_TIMEOUT` flows through
the validator pipeline. Verified-clean.

---

**F-90 — Widget assets unauth but static-only (no LLM, no DB)**

`packages/api/src/api/routes/widget.ts` (3 routes), `widget-loader.ts`
(2 routes). All four are `GET` with cached static content loaded
once at module init from `@useatlas/react/dist`. No DB touch, no
LLM, no per-request work beyond writing the cached body. Phase 5
F-48 already verified the bundle reads zero env vars. Verified-clean.

---

**F-91 — Internal cross-region migration auth via timing-safe compare**

`packages/api/src/api/routes/admin-migrate.ts:340-369` —
`timingSafeCompare(token, secret)` over SHA-256 hashes of equal-length
inputs. Empty token rejected. Missing env var rejected with 503.
Verified-clean for the *auth* path; the body-size / rate-limit gap
is tracked as F-80.

---

**F-92 — nsjail Python timeout + memory cap configurable, defaults 30s / 512MB**

`packages/api/src/lib/tools/python-nsjail.ts:23-30` — `DEFAULT_TIME_LIMIT
= 30`, `DEFAULT_MEMORY_LIMIT = 512MB`, `DEFAULT_NPROC = 16`. Override
via `ATLAS_NSJAIL_TIME_LIMIT` / `ATLAS_NSJAIL_MEMORY_LIMIT`.
`--rlimit_fsize 50` (50MB) caps chart output; `--rlimit_nofile 128`.
nsjail `-u 65534 -g 65534` runs as nobody. Verified-clean.

---

### Considered, not filed

- **Discord / Teams / Telegram / GChat / GitHub / Linear / WhatsApp
  webhook receivers** — none exist. All seven integrations are
  outbound-only (Atlas sends messages to those platforms via OAuth
  bot tokens). No inbound webhook routes mounted in
  `packages/api/src/api/index.ts`. Verified by listing every
  `app.route(...)` line and grepping `routes/*.ts` for `webhook` /
  `signature`.
- **Public branding read (`GET /api/v1/branding`)** — single keyed
  read, no per-IP rate limit but also no LLM / sandbox cost. Safe to
  treat as a static surface.
- **`POST /api/v1/internal/migrate/import` body-size limit** — see
  F-80. Rolled into the same finding because the gap is operationally
  paired (a missing body cap + missing rate limit produces the same
  attack shape against the same operator-controlled secret).
- **Better Auth signup rate limit** — Better Auth ships its own
  rate limit on `/api/auth/sign-up/email`. Phase 1 F-05 already
  reviewed the signup auth posture. No phase-6 concern.
- **Plugin tool `runCommand` timeouts** — every datasource plugin
  inherits the parent SQL pipeline's per-source rate limit + driver
  timeout (verified F-85 / F-87). No plugin-level escape hatch.
- **Concurrent agent runs per user** — there's no soft cap on
  parallel `/chat` calls from the same user. Mitigated by the global
  RPM bucket (when set), per-source DB limit, and abuse detection.
  F-74 partially addresses this; revisit if a future incident shows
  the abuse detector lagging.

### Findings summary

| ID | Severity | Type | Surface | Compliance lens | Issue | Status |
|---|---|---|---|---|---|---|
| F-73 | P1 | Live DoS surface | `/api/public/conversations/:token`, `/api/public/dashboards/:token` rate limit broken without `ATLAS_TRUST_PROXY` | SOC 2 CC6.6 / availability | #1844 | shipped |
| F-74 | P2 | Hardening | Single global RPM bucket conflates chat (25-step) with cheap reads | — | #1845 | shipped |
| F-75 | P2 | Replay protection gap | Webhook plugin has no timestamp-window check | SOC 2 CC6.7 | #1846 | shipped |
| F-76 | P2 | Cost ceiling gap | Webhook plugin has no per-channel rate limit | — | #1847 | shipped |
| F-77 | P2 | Hardening | No per-conversation aggregate budget cap | — | #1848 | shipped |
| F-78 | P3 | Hardening | `just-bash` explore backend has no wall-clock timeout | — | — | noted |
| F-79 | P3 | Hardening | Vercel python sandbox memory cap delegated to platform | — | — | noted |
| F-80 | P3 | Hardening | Internal `/migrate/import` no body-size / rate limit | — | — | noted |
| F-81 | P3 | Operator config | Global `ATLAS_RATE_LIMIT_RPM` defaults to 0 | — | — | noted |
| F-82 | — | Verified-clean | Stripe webhook signature + replay (Better Auth + stripe SDK) | — | n/a | verified |
| F-83 | — | Verified-clean | Slack signature + 5-min replay window + timing-safe | — | n/a | verified |
| F-84 | — | Verified-clean | Sidecar concurrency cap (10) + 429 on overflow | — | n/a | verified |
| F-85 | — | Verified-clean | Per-source DB rate limit (60 QPM / 5 concurrent) | — | n/a | verified |
| F-86 | — | Verified-clean | Connection pool LRU + drain cooldown + 429 graceful degrade | — | n/a | verified |
| F-87 | — | Verified-clean | SQL LIMIT + per-statement timeout at driver layer (PG + MySQL) | — | n/a | verified |
| F-88 | — | Verified-clean | Demo mode separate RPM + lower max steps + signed-token gate | — | n/a | verified |
| F-89 | — | Verified-clean | Agent loop step + wall-clock + step + chunk caps | — | n/a | verified |
| F-90 | — | Verified-clean | Widget assets unauth but static-only | — | n/a | verified |
| F-91 | — | Verified-clean | Internal migrate timing-safe compare + 503 on missing secret | — | n/a | verified |
| F-92 | — | Verified-clean | nsjail Python timeout + memory + nproc + fsize + nofile caps | — | n/a | verified |

**Totals:** P0 = 0, P1 = 1 (F-73), P2 = 4 (F-74 / F-75 / F-76 / F-77), P3 = 4 noted-only (F-78 / F-79 / F-80 / F-81), 11 verified-clean rows (F-82 – F-92). Pool-exhaustion behavior verified by code-read (load testing out of scope per the prompt). Numbering note: Phase 7 (parallel session) claimed F-53–F-60 first via tracker #1718; Phase 6 picked up at F-73 to avoid the clash. Phase 5 P3 notes (F-48–F-52) and Phase 7 (F-53–F-60) sit between.

### Deliverables this PR

- **This audit section** — route-inventory table + 5 P1/P2 issue-bearing
  findings + 4 P3 noted-only + 11 affirmative-verification rows.
- **5 GitHub issues filed** (#1844 – #1848) for every P0/P1/P2 finding.
  Labels: `security` + `bug` (live flaw) or `chore` (hardening) + the
  area label (`area: api` or `area: plugins`). Milestone
  `1.2.3 — Security Sweep`.
- **Phase-6 checkbox flipped** in tracker #1718.
- **No production code changes** — fixes ship as follow-up PRs per the
  phase-1/2/3/4/5 workflow. Suggested ordering: F-73 first (live DoS),
  then the F-75 + F-76 webhook-plugin cluster (paired remediation),
  then F-74 + F-77 (chat-bucket + per-conversation cap, both touch
  `lib/auth/middleware.ts` + `routes/chat.ts`).

---


## Phase 7 — Enterprise governance paths

**Status:** complete (2026-04-24)
**Scope:** SSO enforcement, SCIM directory sync, IP allowlist, approval
workflows, custom roles, deploy-mode gating, and the `requireEnterprise()`
guard contract. Sources walked: `ee/src/auth/{sso,scim,ip-allowlist,roles}.ts`
+ `.test.ts`, `ee/src/governance/approval.ts` + `.test.ts`,
`ee/src/deploy-mode.ts`, `ee/src/index.ts`,
`packages/api/src/api/routes/admin-{sso,scim,roles,approval,ip-allowlist,
action-retention}.ts`, `packages/api/src/api/routes/middleware.ts`,
`packages/api/src/api/routes/{slack,teams,discord,billing,scheduled-tasks,
auth,demo,query,chat,validate-sql}.ts`,
`packages/api/src/lib/auth/{middleware,managed,server}.ts`, and
`packages/api/src/lib/{tools/sql,scheduler/executor,agent-query}.ts`.
**Issue:** #1726
**Phase 6 coordination:** Phase 6 (rate-limit / DoS audit) had not started
at the time this section was written, so Phase 7 claims the IDs starting at
F-53. If Phase 6 starts after this lands it picks up at F-61+, per the
coordination rule in the original prompt.

### Bypass matrix

Governance control × entry point. **yes** = bypass exists (and is a
finding); **no** = control is enforced; **n/a** = control does not apply
to this entry point by design (the cell links to the rationale).

| Entry point | SSO enforcement | SCIM-managed identity | IP allowlist | Approval workflows | Custom-role permissions |
|---|---|---|---|---|---|
| Web session (cookie / Better Auth bearer) | no | no — admin still mutates SCIM users (F-57) | no | no — chat / query bind user (F-54 covers scheduler) | **yes** — never gated at route layer (F-53) |
| Better Auth API key (`apiKey()` plugin) | no — `validateManaged` resolves user, SSO check fires | no — same admin path (F-57) | no — `adminAuth`/`standardAuth` middleware fires `checkIPAllowlist` | no — agent path inherits user context | **yes** — never gated at route layer (F-53) |
| `simple-key` mode (`x-api-key` header, self-hosted) | **yes** — `authenticateRequest` skips SSO check in this branch (F-56) | n/a — no managed users | no — IP allowlist still runs (no orgId → check returns `{ allowed: true }`, by design) | n/a — no orgId → approval check returns `required: false` | n/a — no user role; legacy admin assumed |
| `byot` mode (third-party JWT) | **yes** — `authenticateRequest` skips SSO check in this branch (F-56) | n/a — IdP owns identity | no — IP allowlist still runs against the BYOT user | inherits user context if user has orgId | inherits user role; **yes** — same route-layer gap as web session (F-53) |
| Slack / Teams / Discord webhook receivers (`/commands`, `/events`, `/interactions`) | n/a — no Atlas user identity in webhook payload | n/a | **yes** — by design but undocumented (F-58) | **yes** — `executeAgentQuery(text)` runs without user/org context (F-55) | n/a — no user role |
| Scheduled-task executor (`/tick` + bun in-process loop) | n/a — system-initiated | n/a | n/a — server-internal call, not a request | **yes** — `executeAgentQuery(question, requestId)` drops user (F-54) | n/a — system context |
| Stripe webhook (`/api/auth/stripe/*`) | n/a — Stripe-originated | n/a | n/a — third-party | n/a | n/a |
| OAuth install (`/api/v1/{slack,teams,discord}/install`) | n/a — pre-auth handshake; admin gate enforced via `adminAuthPreamble` (F-04 fix) | n/a | no — `adminAuthPreamble` does not invoke `rateLimitAndIPCheck` directly, but admin role is required (gap noted, low risk) | n/a | n/a |
| MCP server (stdio + SSE) | n/a — local stdio + bearer over SSE | n/a — separate identity model | n/a — outside the Hono app | n/a — runs separately from agent loop | n/a |
| Embedded widget (`/widget`, `/widget.js`) | n/a — public static asset | n/a | n/a — public static asset | n/a — widget calls back into authenticated API which enforces approval | n/a |
| Plugin callbacks (Better Auth Stripe plugin, plugin SDK hooks) | n/a — server-internal | n/a | n/a | n/a | n/a |

**Reading the matrix:** every "yes" maps to a finding below. The cells
that look concerning at first glance (e.g. webhook receivers vs. IP
allowlist) are documented as "by design" because there is no Atlas-user
identity to bind to a workspace allowlist — the third-party platform is
the originating IP. The findings below tighten the cases where bypass is
exploitable, surfaces undocumented carve-outs, and notes the cases that
are correct-by-design but undocumented.

### F-53 — Custom-role permission flags defined but never enforced at the route layer ⬆ **P1**

**Where:** `ee/src/auth/roles.ts:42-53` defines `PERMISSIONS` (`query`,
`query:raw_data`, `admin:users`, `admin:connections`, `admin:settings`,
`admin:audit`, `admin:roles`, `admin:semantic`).
`ee/src/auth/roles.ts:256-279` exports a `checkPermission()` middleware
factory. **Zero call sites** in `packages/api/src/api/routes/**` or
anywhere outside `roles.ts` itself:

```
$ grep -rn "checkPermission\|hasPermission\|resolvePermissions\b" \
    packages/api/src/ --include="*.ts" | grep -v test
packages/api/src/api/routes/admin-roles.ts:34: } from "@atlas/ee/auth/roles";   # CRUD only
packages/api/src/api/routes/shared-schemas.ts:38: * custom-role surface (@atlas/ee/auth/roles) ...
```

The admin routes (`admin.ts`, `admin-{users,connections,audit,settings,
semantic,roles}.ts`) all gate via `adminAuth` middleware
(`packages/api/src/api/routes/middleware.ts:244-282`) which checks role
∈ {admin, owner, platform_admin}. None of them refine by permission flag.

**Repro path:** an admin creates a custom role `data-engineer` with
permissions `["query", "query:raw_data"]` — explicitly NOT
`admin:audit`. They `assignRole(userId, "data-engineer")`. The user's
`member.role` becomes `"data-engineer"`, but every admin route still
gates on `adminAuth` which doesn't know `data-engineer` from `admin`. The
user lacks admin role and can't reach `/api/v1/admin/audit` — but that's
because the role is not in `{admin, owner, platform_admin}`, not because
the permission flag is missing. Conversely, an admin with a role that
*does* have `admin` plus a stripped-down permission set still has full
admin access at the route layer.

The `resolvePermissions()` function in `roles.ts` does correctly compute
the effective permission set (custom > legacy fallback), but nothing
calls it on a request boundary. The permission system is currently a
self-contained UI display feature that has never been wired into
authorization.

Per the acceptance criteria in #1726: *"Custom roles — permissions
enforced at the route layer, not just UI. UI-only checks are P1 bypass
bugs (explicitly called out in acceptance criteria)."* This is a stricter
shape — there is **no** check (UI or otherwise) of permission flags. P1
is correct.

**Compliance lens:** SOC 2 CC6.3 (logical access — granular
authorization). A SOC 2 audit reviewing the admin RBAC matrix would find
that the role/permission UI promises segregation that the API does not
deliver.

**Remediation hint:** wire `checkPermission()` into the admin routes
that map cleanly onto a permission flag. Suggested mapping:
- `admin:users` → `admin.ts` (`/users`, `/users/{id}/*`,
  `/users/{id}/membership`, `/users/{id}/role`)
- `admin:connections` → `admin-connections.ts` (all routes)
- `admin:audit` → `admin-audit.ts`, `admin-audit-retention.ts`,
  `admin-action-retention.ts`
- `admin:roles` → `admin-roles.ts` (all routes)
- `admin:semantic` → `admin-semantic.ts`, `admin-semantic-improve.ts`
- `admin:settings` → `admin.ts` settings sub-routes,
  `admin-{branding,domains,email-provider,sandbox,residency,model-config}.ts`
- `query`, `query:raw_data` → enforced inside `executeSQL` already via
  `resolvePermissions`, but route-layer guard on `/api/v1/query` and
  `/api/v1/chat` would catch users whose role lacks `query`.

This will be a multi-PR remediation — the route-layer changes are wide.
Suggest doing it in one cluster across the admin surface so the
permission contract is consistent.

**Status:** P1 — issue to be filed.

---

### F-54 — Approval workflows bypassed for scheduled-task executions ⬆ **P1**

**Where:** `packages/api/src/lib/scheduler/executor.ts:41` calls
`executeAgentQuery(question, requestId)`. `agent-query.ts:43` then runs
the agent inside `withRequestContext({ requestId: id }, ...)` — no
`user` field. Inside `executeSQL` (`packages/api/src/lib/tools/sql.ts:1017`):

```ts
const checkReqCtx = getRequestContext();
const checkOrgId = checkReqCtx?.user?.activeOrganizationId;
approvalMatch = await Effect.runPromise(checkApprovalRequired(
  checkOrgId, classification.tablesAccessed, classification.columnsAccessed,
));
```

`checkOrgId` is `undefined` because no user is bound. The first line of
`checkApprovalRequired` (`ee/src/governance/approval.ts:412`):

```ts
if (!orgId || !hasInternalDB()) {
  return { required: false, matchedRules: [] };
}
```

short-circuits to "no approval required". The query executes with no
audit trail of an approval bypass.

**Repro path:** workspace admin creates an approval rule
`SELECT FROM customer_pii` requiring approval. They then create a
scheduled task with the question *"How many records does customer_pii
have, broken down by acquisition channel?"*. The task runs daily without
ever hitting the approval queue. Every other route that runs the same
agent (chat, /query) DOES enforce approval — only the scheduler path
silently bypasses.

This is the same shape as the F-13 cross-tenant-state-change pattern —
governance enforcement is per-call-site rather than centralized in the
agent, so the easy thing (skip context) and the safe thing (block on
no context) are inverted.

**Partial mitigation worth noting:** `sql.ts:1037-1047` does fail
closed when `approvalMatch.required === true` AND user identity is
missing — it returns a clear "approval required but the requester
identity could not be determined" error. The bug is not that the
hard-fail is wrong; it is that `approvalMatch.required` never becomes
true on the scheduler path because the orgId-less call to
`checkApprovalRequired` short-circuits at `approval.ts:412` before any
rule lookup runs. Readers should not infer the entire approval
pipeline is broken — only the orgId-less entry path is.

**Compliance lens:** SOC 2 CC6.1 / SOC 2 CC7.2 — change-management
controls. The approval workflow is the auditable boundary between
"user requested data" and "data was returned"; bypassing it via a
scheduled task removes the human reviewer from the loop.

**Remediation hint:** scheduled tasks are created by a user with
recorded `created_by`. The task row already carries the actor's user_id
+ org_id. The fix is to:

1. Resolve the task row's `created_by` user before invoking the agent.
2. Bind that user into `withRequestContext` so `checkOrgId` resolves
   correctly and approval rules apply.
3. When approval is required, persist the request to the queue and
   surface it in the task's run history as `delivery_status =
   "pending_approval"` rather than silently executing.
4. Consider whether scheduled tasks created by a user who has since lost
   permissions should be auto-paused (separate concern, but related).

A defensive secondary fix: in `executeSQL`, treat `orgId === undefined`
as a hard block when `hasInternalDB()` AND any approval rule exists for
the workspace. Currently the absence of orgId silently disables the
gate; the safer default is fail-closed.

**Status:** P1 — **shipped** (closes #1850). The scheduler executor now
resolves `task.ownerId` to a real `AtlasUser` via the new
`loadActorUser` helper in `lib/auth/actor.ts` and binds it through
`executeAgentQuery({ actor })` so `checkApprovalRequired` sees a real
`orgId` downstream. When an approval rule matches, the run is marked as
**failed** with a message naming the rule + queued request id (rather
than silently delivering results), and tasks whose creator no longer
exists fail fast instead of running anonymously. **Spec deviation:**
the original remediation called for surfacing this as
`delivery_status = "pending_approval"`. That requires adding
`pending_approval` to `DELIVERY_STATUSES` in
`@useatlas/types/scheduled-task` — a wire-format bump to a published
package, out of scope for this fix. The "failed run with a clear
approval-required message" route is unambiguous in run-history UI and
audit exports, and the queued approval request has its own row in
`approval_requests` for the admin to act on; a follow-up can introduce
the dedicated enum value when the next `@useatlas/types` minor lands.
The defensive `orgId === undefined + rules-exist → fail-closed`
belt-and-suspenders is implemented in `anyApprovalRuleEnabled` / the
new `identityMissing` flag on `ApprovalMatchResult`. Pinned regression
tests in `scheduler/__tests__/executor.test.ts` and the new
`lib/__tests__/agent-query.test.ts`.

---

### F-55 — Approval workflows bypassed for Slack / Teams / Discord agent invocations ⬆ **P2**

**Where:**
- The slash command path and the events / threaded follow-up path in
  `packages/api/src/api/routes/slack.ts` call `executeAgentQuery(text)`
  with no user context. (Line numbers shift across revisions; the call
  sites are bracketed by `processAsync` blocks in each handler.)
- `packages/api/src/api/routes/teams.ts` and `discord.ts` follow the
  same pattern (each forwards to the same agent helper without resolving
  the bot-platform user back to an Atlas user).

Same root cause as F-54 — the agent runs without `user` bound to
`RequestContext`, so `checkApprovalRequired(undefined, ...)`
short-circuits.

**Why this is P2 not P1:** the chat-platform integrations have a known
identity-mapping gap (Slack user IDs are not Atlas user IDs). Operators
who deploy Slack / Teams / Discord effectively grant the bot a
no-approval execution environment. This is a defensible *design* choice
when documented; it is a *bypass* when not. Today, no admin-facing
documentation, no admin-toggle, and no audit row records that approval
was skipped.

**Compliance lens:** same as F-54 — but the impact is mitigated by the
small surface (only orgs that install the chat integrations are
exposed).

**Remediation hint:** at minimum, persist a Slack-team-id → Atlas-org-id
mapping (already done for installation routing; `getBotToken(teamId)`
implies it) and bind the org as the agent's RequestContext orgId. With
no Atlas user bound, surface the user identity as `slack:<userId>` and
reject any approval-required query with a clear "approve via the Atlas
admin console" message in Slack. This keeps the bot useful for queries
that don't trip an approval rule and produces an audit trail for the
ones that do.

A simpler stop-gap: an admin setting `ATLAS_CHAT_PLATFORMS_BYPASS_APPROVAL`
defaulting to `false`, surfaced in the integrations admin UI, with a
clear warning that disabling approval for chat platforms reduces the
governance posture. Logging an `admin_action_log` row when the toggle
flips closes the audit gap.

**Status:** P2 — **shipped** (closes #1851). The Slack receiver
(`api/routes/slack.ts`) now resolves the workspace installation and binds
a synthetic `slack-bot:<teamId>:<userId>` actor — built by the new
`botActorUser()` helper — into `executeAgentQuery({ actor })` so the
approval gate fires for chat-platform queries. When a rule matches, the
slash-command path replaces the "Thinking…" message and the thread
follow-up posts a clear "approve via the Atlas admin console" notice
(with the matched rule name) instead of returning query results.
**Single-workspace env-token deployments** (no `installation.org_id`
because the bot token comes from `SLACK_BOT_TOKEN` env without a paired
DB row, or the DB row exists with `org_id = null`) fall through with no
actor bound — the inline comment in `slack.ts` documents this as
intentional, because there is no Atlas org to associate a rule with.
On those deployments, the defensive `identityMissing` path in
`approval.ts` only fires if rules exist somewhere in the DB; if not,
the bot keeps working unchanged. The audit doc earlier referenced
`routes/teams.ts` and `routes/discord.ts` "following the same pattern"
— those files only carry OAuth installation routes today and never
invoked `executeAgentQuery`, so nothing to fix there; the actor pattern
is in place for whenever a webhook receiver lands. Regression tests in
`api/__tests__/slack.test.ts` (5 new: slash + thread actor-binding,
slash + thread approval-rejection, no-org fallthrough). The
chat-platforms-bypass admin toggle stop-gap is **not** shipped — once
the actor is bound the gate works as designed, and a toggle to
re-disable it would re-introduce the governance gap this PR closes.
Operators who want chat-platform queries to skip approval can do so by
leaving the workspace's `approval_rules` table empty.

---

### F-56 — SSO enforcement does not gate `simple-key` or `byot` auth modes ⬆ **P2**

**Where:** `packages/api/src/lib/auth/middleware.ts:227-285`. The switch
on `mode` has SSO enforcement only in the `case "managed":` branch
(line 241). The `simple-key` and `byot` branches return immediately
without any SSO check:

```ts
case "simple-key":
  return validateApiKey(req);

case "managed":
  // ... validateManaged + checkSSOEnforcement ...

case "byot":
  return await (_byotOverride ?? validateBYOT)(req);
```

A workspace that has SSO enforcement enabled and is running in
`simple-key` or `byot` mode will allow API-key/JWT holders to bypass
Atlas's internal SSO enforcement entirely. The user identity surfaced
by `simple-key` (`api-key-<sha256-prefix>`) has no email domain, so even
if SSO checks did run they would no-op via `extractEmailDomain`
returning null — that path is the documented break-glass. The live gap
is `byot`.

`byot` mode is gated on `ATLAS_AUTH_JWKS_URL` being set
(`packages/api/src/lib/auth/detect.ts:76-77`) — a generic IdP signal
that fits **multi-tenant SaaS deployments using an external IdP**
(Auth0, Cognito, custom JWKS) just as well as self-hosted. The earlier
revision of this finding called BYOT "self-hosted only"; that's wrong.
Any deployment that runs Atlas behind an external IdP and ALSO has an
SSO enforcement record in `sso_providers` will see the enforcement
record silently no-op. In one sense the IdP itself is enforcing SSO
(JWKS validation implies a verified IdP-signed token), so Atlas's
internal table is somewhat redundant. The gap is the "I clicked the
'enforce SSO' toggle in the admin UI and assumed it gated my BYOT
JWTs" mismatch — the operator's mental model and the actual behaviour
diverge silently.

**Comment in code documents the simple-key carve-out only:**

```ts
// SSO enforcement: if the user's email domain has SSO enforced,
// block password/session auth and require SSO login instead.
// Break-glass bypass: simple-key auth (API key) is not affected.
```

No comment exists for `byot`. A BYOT JWT does carry the user's email
(per the BYOT contract), so the domain *would* match an SSO-enforced
workspace, and the enforcement *should* fire — but it doesn't because
the switch case skips the check.

**Why this is P2:** the SSO threat model assumes managed-mode
deployments, which is where the official Atlas SaaS deployment lives and
is what the SSO admin UI gates on. The `simple-key` carve-out is the
documented break-glass. The `byot` carve-out is the live gap, but its
real-world impact is bounded by the fact that a BYOT deployment is by
definition already delegating identity to an external IdP — the IdP is
enforcing SSO upstream, just not via Atlas's internal table. Not P1
because:
1. The official Atlas SaaS (managed mode) is unaffected.
2. The break-glass framing is defensible for `simple-key` — the API-key
   bypass is the intended escape hatch when SSO breaks (e.g. IdP outage
   during incident response).
3. BYOT operators who set Atlas's SSO enforcement record alongside an
   external IdP have a misconfigured stack rather than an exploitable
   bypass — but the misconfiguration is silent, which is what makes
   this P2 (admin UI promises something the backend doesn't deliver)
   rather than P3 (cosmetic).

**Compliance lens:** SOC 2 CC6.6 / ISO A.9.4.2 — system access controls.
A SOC 2 auditor reviewing the SSO enforcement claim would expect
documentation of any break-glass paths. Currently undocumented for
`byot`.

**Remediation hint:** two cleanly-separable changes:
1. **Documentation:** add an inline comment explaining the `byot`
   bypass intent and update the SSO admin UI to surface "API key access
   bypasses SSO enforcement" when an admin enables enforcement.
2. **Enforcement:** factor `checkSSOEnforcement` out of
   `case "managed":` into a wrapper that fires for any authenticated
   path with a resolved email domain. Add a `bypassSSO` flag on
   per-key / per-token grant if break-glass is needed, gated by an
   admin-action audit row. Default behaviour: SSO is enforced regardless
   of auth mode, with an explicit allow-list of bypass-eligible API keys.

**Status:** P2 — issue to be filed. Suggest pairing with F-59 (test
debt) so the bypass branches grow tests in the same PR.

---

### F-57 — Admin routes mutate SCIM-provisioned users without checking provisioning origin ⬆ **P2**

**Where:** every user-mutation handler in
`packages/api/src/api/routes/admin.ts` and `admin-roles.ts` operates on
the `member` / `user` table without consulting the
`account.providerId` ↔ `scimProvider` join that
`ee/src/auth/scim.ts:198-205` uses to identify SCIM-managed users:

All line numbers point to the `.openapi(...)` registration site:

| Handler | File | Line |
|---|---|---|
| `removeMembershipRoute` | `admin.ts` | 2081 |
| `deleteUserRoute` | `admin.ts` | 2151 |
| `changeUserRoleRoute` | `admin.ts` | 1894 |
| `revokeUserSessionsRoute` | `admin.ts` | 2213 |
| `banUserRoute` | `admin.ts` | 1986 |
| `assignRoleRoute` | `admin-roles.ts` | 466 |

The SCIM "source of truth" model is that the IdP (Okta, Azure AD, etc.)
owns the user lifecycle — when a user is removed from the SCIM group,
the next sync deactivates the Atlas user. Per the SCIM-with-RBAC
contract:
- Admin UI mutations on SCIM-provisioned users **should** be either
  blocked outright OR explicitly recorded as "manual override" with a
  warning that the change will be reverted by the next sync.
- Today, every admin mutation on a SCIM user proceeds silently. The
  next SCIM sync may revert role changes, may re-create deleted users
  via a follow-up `User` POST, or may surface the user in an
  inconsistent state (deleted in Atlas but still in the SCIM provider's
  user mirror).

**Repro path:** workspace admin demotes an Okta-provisioned admin
(`PATCH /admin/users/{id}/role` body `{role: "member"}`). The change
applies immediately to `member.role`. On the next SCIM sync, Okta's
group mapping promotes the user back to `admin`. The role flip is
recorded in `admin_action_log` as a successful change, which it was —
but the operator has no way to predict or learn that the change was
transient.

More severe variant: admin `DELETE /admin/users/{id}`, the user's
account row in Better Auth is removed. Next SCIM sync from the IdP
re-provisions the user with a new userId, orphaning the deleted user's
audit trail (different primary key) and breaking any per-user RLS that
references the old id.

**Why this is P2 and not P1:** the F-57 path requires the admin to
already be authorized to make the mutation. There is no privilege
escalation. The damage is data-integrity (orphaned references,
ping-pong with the IdP) and audit clarity (changes that don't stick).

**Remediation cost is non-trivial — flagged here so the issue isn't
mistaken for a one-line guard.** A grep of `packages/api/src/` and
`ee/src/` for `scim_provisioned`, `scimProvisioned`, or
`provisioned_via` returns zero hits — there is no marker column
distinguishing SCIM-provisioned users from others. The
`account.providerId` ↔ `scimProvider` join in `scim.ts:198-205` is the
only mechanism, and it's a runtime query rather than a schema flag.
Adding the SCIM-provenance check to the 6 user-mutation handlers
either (a) adds a query per mutation, or (b) requires a schema
migration to materialize a flag. Either path is doable; flagging it
here so the implementer doesn't underestimate scope.

**Compliance lens:** ISO A.9.2 — user access management. SCIM is the
declared source of truth; the API not enforcing it weakens the
auditable identity contract.

**Remediation hint:** add a helper
`isSCIMProvisioned(userId): Effect<boolean>` (mirroring the join in
`scim.ts:getSyncStatus`) and wire it into the user-mutation routes
above. Two policy modes worth surfacing as a workspace setting:
- **strict** (default for SCIM-enabled workspaces): block the mutation
  with a 409 + message explaining that SCIM owns this user.
- **override** (admin opts in per mutation): mutation proceeds, an
  `admin_action_log` row is emitted with `metadata.scim_override = true`
  and a warning is sent to the admin via UI banner.

Phase 4 already established the pattern of recording overrides in
`admin_action_log` with `status` + structured metadata; reuse the same
shape.

**Status:** P2 — issue to be filed.

---

### F-58 — Webhook receivers (Slack / Teams / Discord) bypass IP allowlist by design — undocumented (P3 → noted)

**Where:** the Slack `/commands`, `/events`, `/interactions` handlers
mount via `OpenAPIHono` without `adminAuth`/`standardAuth`/
`platformAdminAuth` middleware. The only middleware they get is
`withRequestId` via the parent route. Same for `teams.ts` and
`discord.ts` chat-platform handlers.

`rateLimitAndIPCheck` (the function that calls `checkIPAllowlist`) only
runs from `adminAuth` / `standardAuth` / `platformAdminAuth`. Webhook
receivers therefore never hit the allowlist.

**Why this is correct-by-design:** the webhook receivers verify HMAC
signatures from the originating platform (Slack:
`verifySlackSignature`; Teams: bot-framework token; Discord: signature
header). The originating IP is the third-party platform, not a user IP
that operators can or should allowlist.

**Why this is still worth documenting:** an operator who configures an
IP allowlist with the mental model "all access requires an allowlisted
IP" will be surprised to learn that the chat integrations carve out a
hole. The carve-out is invisible in admin UI today.

**Remediation hint:** in the integrations admin UI, when a workspace
has both an active IP allowlist and an active chat integration, surface
a banner: *"Chat integration messages are validated by signature, not
IP. Disable the integration to fully scope access to allowlisted IPs."*
No code change to the receivers themselves.

**Status:** P3 — noted, no separate issue. Roll into the IP allowlist
admin UI polish cycle (1.3.0 admin revamp final pass).

---

### F-59 — Test coverage gap: SSO enforcement bypass branches not exercised (P3 → noted)

**Where:** `packages/api/src/lib/auth/__tests__/middleware.test.ts`
covers `mode: managed` SSO enforcement at line 205-247 (block + 500 fail-
closed). No test covers:
- `mode: simple-key` skipping SSO enforcement (the F-56 bypass).
- `mode: byot` skipping SSO enforcement (also F-56).
- A `managed`-mode session backed by a Better Auth API key (hits SSO
  check via `auth.api.getSession`'s API-key resolution; is the most
  common cross-cut and is currently inferred-correct rather than
  asserted).

Per the prompt's framing — *"if a bypass isn't tested for, that's itself
a finding"* — these missing tests are the test-debt mirror of F-56.
Once F-56 is fixed (or its scope is explicitly affirmed), the tests
should land alongside.

**Remediation hint:** add three test cases mirroring the existing F-56
shape:
1. `mode: simple-key — SSO enforcement does NOT block API key auth (documents intentional break-glass)`
2. `mode: byot — SSO enforcement DOES block when domain matches (target behaviour after F-56)` *or* `mode: byot — SSO enforcement does NOT block (documents current behaviour pending F-56 fix)`
3. `mode: managed (API-key) — SSO enforcement DOES fire for Better Auth API key auth`

**Status:** P3 — noted. Folded into F-56 remediation PR.

---

### F-60 — `/api/v1/demo/chat` runs agent without `activeOrganizationId` — approval workflows skipped (P3 → noted)

**Where:** `packages/api/src/api/routes/demo.ts:399-435`. The demo chat
handler binds a demo `user` (synthesized via `createAtlasUser`) into
`withRequestContext({ requestId, user: demoUser })`, but the demo user
carries no `activeOrganizationId`. Inside `executeSQL`,
`getRequestContext()?.user?.activeOrganizationId` resolves to undefined,
which trips the same `checkApprovalRequired(undefined, ...)`
short-circuit as F-54 / F-55.

**Why this is P3 and not a real finding:** the demo workspace ships
fixed sample data (the SaaS demo dataset) and is firewalled from any
real workspace's data. Approval rules don't apply because there is no
sensitive data to gate. The demo handler is gated by `isDemoEnabled()`
+ a signed demo token + email rate-limiting (covered by Phase 1 review).

Worth noting for completeness so that future audits don't re-flag the
same path — and so that any future change that lets the demo handler
touch real workspace data picks up the explicit "no approval gate"
constraint as a known precondition.

**Status:** P3 — noted, no issue.

---

### Affirmative verifications

The cells in the bypass matrix marked "no" each correspond to a
correctly-wired enforcement path. Documenting the verification rationale
for each so future audits can short-circuit:

- **SSO enforcement on managed-mode auth** — `auth/middleware.ts:191-221`
  calls `checkSSOEnforcement` after `validateManaged` succeeds. Returns
  403 + `ssoRedirectUrl` to surface the IdP login URL. Fail-closed on
  errors (returns 500 not allow). Test coverage:
  `auth/__tests__/middleware.test.ts:205-247` (block + fail-closed).
  Verified: no bypass via password, magic link, OAuth (Google / GitHub /
  Microsoft), or session resume.
- **SSO enforcement on Better Auth API key** — the `apiKey()` plugin
  resolves the key to its owning user via `auth.api.getSession`, so the
  same `validateManaged` → `checkSSOEnforcement` path applies. Inferred
  from Better Auth docs + plugin source (the plugin populates
  `session.user` from the key's owner). Test debt: not directly asserted
  (see F-59).
- **IP allowlist on `adminAuth` / `platformAdminAuth` / `standardAuth`** —
  `routes/middleware.ts:117-156` calls `checkIPAllowlist(orgId, ip)`
  unconditionally inside `rateLimitAndIPCheck`. All three middlewares
  invoke this helper. Verified by reading the middleware bodies and
  cross-referencing the inner-app route registrations.
- **IP allowlist fail-closed on DB error** — `ee/src/auth/ip-allowlist.ts:334-346`
  uses `Effect.tryPromise` with a typed `catch` that **re-throws** rather
  than returning `{ allowed: true }` — DB outage blocks rather than
  permits. Comment explicitly cites CLAUDE.md: *"`catch { return false }`
  on a security check is a bug"*. Hardened correctly.
- **Approval enforcement on `/api/v1/chat`** — `chat.ts:309` binds
  `withRequestContext({ requestId, user: authResult.user, atlasMode })`
  before the agent runs. `executeSQL` reads the bound user, so
  `checkApprovalRequired` receives a valid orgId.
- **Approval enforcement on `/api/v1/query`** — `query.ts:200` follows
  the same `withRequestContext({ requestId, user: authResult.user })`
  pattern as chat. Verified.
- **Approval availability fail-open + creation hard-fail split** —
  `lib/tools/sql.ts:1009-1090` splits the approval check into two
  phases. Phase 1 (`checkApprovalRequired`) fails open (logs warn,
  proceeds without gate) when EE is unavailable. Phase 2
  (`createApprovalRequest` + `hasApprovedRequest`) fails closed (typed
  `QueryExecutionError`, blocks the query). Comment explicitly cites
  *"governance bypass is worse than a failed query"*. Correct posture.
- **Approval cache-hit cannot bypass approval** — `lib/tools/sql.ts:1094-1110`
  runs the cache check AFTER the approval check, so a cached result
  for a query that now requires approval will not short-circuit. The
  approval phase is upstream of the cache lookup.
- **Custom-role names cannot shadow built-in Atlas roles (F-10
  hardening)** — `ee/src/auth/roles.ts:36-38` builds
  `RESERVED_ATLAS_ROLE_NAMES` from `ATLAS_ROLES`, then checks both at
  `createRole` (line 364) and at `assignRole` (line 548). Belt-and-
  suspenders defense. Verified.
- **`requireEnterprise()` gates every EE CRUD function** — every
  `Effect.gen` in `ee/src/{auth,governance,audit,branding,platform,
  compliance,sla}/*.ts` starts with `yield* requireEnterpriseEffect("...")`.
  The two intentional exceptions (`findProviderByDomain`,
  `isSSOEnforced{,ForDomain}` in sso.ts; `getWorkspaceBrandingPublic`
  in branding) carry inline rationale comments. Verified:
  ```
  $ grep -nL "requireEnterprise" ee/src/{auth,governance,audit,branding,
    platform,compliance,sla}/*.ts | xargs grep -nE "^export"
  # only test files + the documented carve-outs
  ```
- **`ATLAS_DEPLOY_MODE=saas` falls back to `self-hosted` without EE** —
  `ee/src/deploy-mode.ts:31-33` and `deploy-mode.ts:36`. The frontend
  `deployMode` value comes from `getDeployMode()` which reads the
  resolved value. Verified by reading the source: no SaaS-only
  governance route bypasses this gate.
- **Stripe webhook signature verification** — `/api/auth/stripe/*` is
  handled by Better Auth's Stripe plugin (`packages/api/src/lib/auth/server.ts:491`
  conditionally registers when `STRIPE_SECRET_KEY` is present). The
  plugin uses `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`.
  Confirmed via Phase 5 audit (#1724) — no Atlas-side changes.
- **OAuth state CSRF + orgId binding for chat-platform installs** —
  `oauth-state.ts` 10-minute TTL + single-use DELETE-RETURNING.
  `slack.ts:743`, `teams.ts:194`, `discord.ts:202` reject installs that
  lack `orgId` when `deployMode === "saas"`. Phase 1 / F-04 fix carries
  forward.
- **Approval `expireStaleRequests` + `getPendingCount` are org-scoped** —
  `ee/src/governance/approval.ts:654` and `:687`. The `@security F-13`
  comment explicitly preserves the cross-tenant guard. Verified.
- **`reviewApprovalRequest` blocks self-approval** —
  `approval.ts:606-609`. Requester cannot approve their own request.
  Verified.

### Considered, not filed

- **Better Auth `/api/auth/sign-in/email` from outside an IP allowlist** —
  the auth catch-all is mounted without `adminAuth` / `standardAuth`,
  so a user from outside the allowlist can authenticate. On the next
  authenticated request, the allowlist fires and blocks them. This is
  the documented "logged in but can't use the API" state — not a
  bypass, just an audit-log surface that records a successful login
  followed by a 403 on the very next request. Worth surfacing in
  admin UI ("the following users authenticated from outside the
  allowlist") but not a bypass finding.
- **MCP server access** — the MCP server (stdio + SSE transport) is a
  separate runtime from the Hono app. It owns its own auth (bearer over
  SSE) and tool authorization. Not under Phase 7 scope; will be revisited
  during the MCP hardening pass.
- **Better Auth bearer plugin token revocation** — Phase 1 F-11
  identified that bearer + apiKey co-existence has no documented
  revocation flow. Re-reading in Phase 7: revocation is delegated to
  Better Auth's session and apiKey tables (delete the row → next
  request fails `getSession`). Documented behaviour, not a Phase 7
  finding. Tracked under #1733 / Phase 1 cleanup.
- **`getWorkspaceBrandingPublic` skips `requireEnterprise`** — by
  design (see comment in `ee/src/branding/white-label.ts:130-134`).
  Reads the public-safe branding fields only (logo, colors, hide-Atlas
  toggle). No PII or credentials surface here. Phase 5 covered this
  surface.
- **`isSSOEnforced` / `isSSOEnforcedForDomain` skip
  `requireEnterprise`** — by design; these are called during the login
  flow before the user has a session, and the enterprise gate happens
  at the admin toggle (`setSSOEnforcement`). Documented in source.
- **`findProviderByDomain` skips `requireEnterprise`** — same rationale
  as above; used in the login flow.
- **`resolvePermissions` skips `requireEnterprise`** — by design; used
  on every request and gracefully degrades to legacy role mapping when
  EE is off. (Pairs with F-53; once permissions are wired into routes,
  the legacy fallback is what protects self-hosted no-EE workspaces.)
- **`hasInternalDB()` short-circuits** — every EE function checks
  `if (!hasInternalDB()) return ...` after the enterprise gate. This is
  the standard pattern for self-hosted-no-DB compatibility. Not a
  bypass; verified throughout.
- **`adminAuthPreamble` on chat-platform OAuth install routes does not
  invoke IP allowlist** — Slack / Teams / Discord `/install` routes
  use `adminAuthPreamble` directly (which checks role) instead of the
  `adminAuth` middleware (which also does IP allowlist). An admin from
  outside the IP allowlist could initiate an OAuth install. Subsequent
  callbacks save the installation. Low risk because: (1) the install
  binds to the user's session orgId (F-04 hardening), (2) the
  callback consumes a single-use OAuth state nonce. But cosmetically
  inconsistent — worth folding into the admin-router unification when
  the `/install` flows next get touched. Not a P-finding because no
  privilege gain.

### Findings summary

| ID | Severity | Type | Surface | Compliance lens | Issue | Status |
|---|---|---|---|---|---|---|
| F-53 | P1 | Authorization gap | Custom-role permission flags never enforced at route layer | SOC 2 CC6.3 (granular authorization) | #1849 | open |
| F-54 | P1 | Governance bypass | Scheduled-task executor runs agent without user context → approval workflows skipped | SOC 2 CC6.1 / CC7.2 (change management) | #1850 | shipped |
| F-55 | P2 | Governance bypass | Slack / Teams / Discord agent invocations bypass approval workflows | SOC 2 CC6.1 / CC7.2 | #1851 | shipped |
| F-56 | P2 | SSO bypass | `simple-key` and `byot` auth modes skip SSO enforcement | SOC 2 CC6.6 / ISO A.9.4.2 | #1852 | open |
| F-57 | P2 | Identity-source bypass | Admin routes mutate SCIM-provisioned users without provisioning-origin check | ISO A.9.2 (user access management) | #1853 | open |
| F-58 | P3 | Doc / UX | Webhook receivers bypass IP allowlist by design — undocumented in admin UI | — | — | noted |
| F-59 | P3 | Test debt | No tests for `simple-key` / `byot` SSO bypass branches; API-key SSO check inferred-only | — | — | noted (folds into F-56) |
| F-60 | P3 | Verified by-design | `/api/v1/demo/chat` runs agent without user context — non-sensitive demo data | — | — | noted |

**Totals:** P0 = 0, P1 = 2 (F-53, F-54), P2 = 3 (F-55, F-56, F-57), P3 = 3 (F-58, F-59, F-60). Issue IDs filled in below as filed.

### Deliverables this PR

- **This audit section** — bypass matrix + 5 P1/P2 issue-bearing
  findings + 3 P3 noted-only findings + an affirmative-verification
  block listing each correctly-wired enforcement path.
- **5 GitHub issues filed** (linked in the table above) for every
  P1/P2 finding (none here are P0). Labels per finding: `security`,
  `bug` (live flaw) or `chore` (hardening), and `area: api`. Milestone:
  `1.2.3 — Security Sweep`.
- **Phase-7 checkbox flipped** in the tracker (#1718). This is the
  final phase — the audit portion of 1.2.3 closes with this PR.
- **No production code changes** — fixes ship as follow-up PRs per the
  phase-1/2/3/4/5 workflow.

**Suggested remediation ordering for the follow-up cluster:**

1. **F-54** first (P1, smallest blast radius). Scheduler executor
   binds task creator's user; `executeSQL` defends with fail-closed
   when orgId is undefined and approval rules exist.
2. **F-53** next (P1, biggest scope). Wire `checkPermission()` into
   the admin route surface. Multi-PR cluster — one PR per admin
   sub-router would keep diffs reviewable.
3. **F-57** (P2). Add `isSCIMProvisioned()` helper and gate the user-
   mutation routes in `admin.ts` + `admin-roles.ts`. Workspace setting
   chooses strict / override mode.
4. **F-55** (P2). Bind chat-platform team-id → org-id mapping into
   `executeAgentQuery` from Slack / Teams / Discord receivers; reject
   approval-required queries with a "approve via admin console"
   message. Or ship the `ATLAS_CHAT_PLATFORMS_BYPASS_APPROVAL`
   stop-gap.
5. **F-56 + F-59** (P2 + P3). Document the SSO/`byot` bypass; factor
   `checkSSOEnforcement` out of the managed-only branch; add the three
   missing test cases.

P3s (F-58, F-60) roll into 1.3.0 admin polish or stay in this audit
doc as noted-only.

---

## 1.2.3 Phase scorecard

| Phase | Title | Audit status | Findings (P0 / P1 / P2 / P3) | Issues filed | Notes |
|---|---|---|---|---|---|
| 1 | Auth config + middleware coverage | complete | 0 / 3 / 4 / 4 (post-Phase 1.5 rescoring) | #1727 – #1733 + deferred #1798 | F-02 upgraded to P0 during Phase 1.5 empirical validation |
| 2 | Org-scoping on reads + writes | complete | 3 / 0 / 4 / 2 | #1734 – #1737 + extras | 3 P0s fixed in-milestone |
| 3 | SQL validator edges + fuzz | complete | 0 / 1 / 2 / 2 | #1742 – #1746 | F-17 RLS header-forward fixed |
| 4 | Audit-log coverage on write routes | complete | 5 / 5 / 5 / 3 | #1777 – #1791 | 15 findings; 9 fixed in-milestone (PR #1797–#1809) |
| 5 | Secrets + error surfaces + plugin credentials | complete | 0 / 3 / 3 / 4 + 1 verified-clean | 6 P1/P2 issues filed | encryption-at-rest gap is the dominant pattern; no P0 |
| 6 | Rate limiting + DoS | complete | 0 / 1 / 4 / 4 + 11 verified-clean | #1844 – #1848 | F-73 is the only live finding; webhook plugin cluster (F-75 / F-76) is P2 hardening. Numbering jumps to F-73 because Phase 7 (parallel session) claimed F-53–F-60 first |
| 7 | Enterprise governance paths | complete | 0 / 2 / 3 / 3 | #1849 – #1853 | F-53 (custom-role permissions never enforced) is the dominant gap; F-54 (scheduler approval bypass) is the second |

**Cross-phase totals (phases 1–7):** P0 = 8, P1 = 15, P2 = 25, P3 = 22. No current P0 open; remediation for Phase 5 P1/P2 + Phase 6 P1/P2 + Phase 7 P1/P2 clustered into follow-up PRs after each audit lands. Finding-ID map: Phase 1 = F-01..F-12, Phase 2 = F-13..F-15, Phase 3 = F-16..F-21, Phase 4 = F-22..F-36, Phase 5 = F-37..F-52, Phase 7 = F-53..F-60 (parallel session), Phase 6 = F-73..F-92.
