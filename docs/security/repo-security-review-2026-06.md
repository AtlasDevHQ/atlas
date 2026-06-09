# Atlas Repository Security Review — June 2026

**Date:** 2026-06-09
**Scope:** Full repository — SQL execution pipeline, authentication/authorization, secrets & cryptography, sandbox/explore isolation, HTTP API surface (SSRF/CORS/CSRF/prompt-injection), frontend (XSS/embed), and CI/CD supply chain.
**Method:** Seven parallel read-only audits, one per attack surface. Findings below were confirmed against source; the two High findings were additionally re-verified by hand. No code was changed during the review.

## Executive summary

Atlas's security posture is **strong and defense-in-depth-oriented**. The core controls — the 4-layer SQL validator, AES-256-GCM credential encryption, timing-safe secret comparison, OAuth PKCE/state handling, the canonical SSRF guard, CORS allowlisting, CI OIDC publishing, and non-root hardened images — are well-built and frequently backed by regression tests.

No Critical issues were found. The two High findings are both **fail-open-on-misconfiguration** weaknesses rather than directly exploitable holes in a correctly-configured deployment, and one is materially mitigated by a forced-password-change flag. The recurring theme across the Mediums is that a *canonical, well-built guard exists* (SSRF validation, the SQL pipeline) but **a few surfaces bypass it** — the fixes are mostly about routing those surfaces through the existing guard.

### Findings by severity

| Severity | Count | Areas |
|----------|-------|-------|
| Critical | 0 | — |
| High | 2 | Sandbox sidecar fail-open auth; default admin password seeded without prod guard |
| Medium | 7 | 4× SQL pipeline (auto-LIMIT bypass, RLS); 3× API SSRF/prompt-injection |
| Low | 14 | Auth, frontend, SQL, secrets, CI/CD hardening |
| Informational | 6 | Documented tradeoffs and dev-only conveniences |

---

## High severity

### H-1 — Sandbox sidecar fails open when `SIDECAR_AUTH_TOKEN` is unset
**File:** `packages/sandbox-sidecar/src/server.ts:98-105` (`checkAuth` returns `null`/allow when `AUTH_TOKEN` is falsy)
**Confirmed by hand.** The sidecar executes arbitrary bash (`/exec` → `Bun.spawn([BASH_PATH, "-c", body.command])`) and arbitrary Python. When the token is unset, every request is allowed and there is no startup guard refusing to boot. The dev compose binds `8080:8080` on `0.0.0.0` and omits the token (independently flagged by the supply-chain audit).

**Exploit:** A sidecar reachable on a shared/internal network (or an exposed dev interface) with `SIDECAR_AUTH_TOKEN` accidentally unset accepts unauthenticated `POST /exec` from anyone who can reach the port — arbitrary code execution. The container holds no secrets, but the command/AST guards live on the API side, not in the sidecar, so this is a raw ACE surface.

**Fix:** Fail closed — refuse to boot (or reject every `/exec*`) when `SIDECAR_AUTH_TOKEN` is unset and a production/deploy-mode flag is set; bind to `127.0.0.1:8080` in the dev compose; require an explicit `SIDECAR_AUTH_DISABLE=1` opt-out for local dev.

### H-2 — Default admin password seeded on first boot in all environments
**File:** `packages/api/src/lib/auth/migrate.ts:199-235`, called unconditionally from `migrate.ts:131`
**Confirmed by hand.** `seedDevUser()` creates `admin@useatlas.dev` with the published password `atlas-dev` (`migrate.ts:218`) whenever the `user` table is empty. The only gate is `ATLAS_ADMIN_EMAIL` being set (which the quick-start docs tell every operator to set) plus zero existing users — there is **no `NODE_ENV`/deploy-mode guard**. The account is created `emailVerified = true`.

**Mitigation present:** the row is stamped `password_change_required = true` (`migrate.ts:231`), and `backfillPasswordChangeFlag` detects the still-default password. A forced password change stands between the seed and a usable session — so real-world severity depends on that flag being honored on **every** authenticated entry point.

**Exploit:** A production instance deployed with `ATLAS_ADMIN_EMAIL` set and an empty user table boots a platform-admin account with public credentials. Any path that doesn't enforce `password_change_required` (worth auditing across API/MCP) would be full platform-admin compromise.

**Fix:** Gate `seedDevUser` on `NODE_ENV !== "production"` / `ATLAS_DEPLOY_MODE !== "saas"`, or generate a random password and log it once instead of shipping a constant. **Action item:** confirm no API/MCP authenticated path bypasses `password_change_required`.

---

## Medium severity

### SQL pipeline (4 findings)

**M-1 — Auto-LIMIT bypass via trailing line comment** — `packages/api/src/lib/tools/sql.ts:1478, 1887`
**Confirmed by hand.** The row cap is appended as a same-line bare suffix: `querySql += \` LIMIT ${rowLimit}\``. `hasLimitClause` correctly strips comments and returns `false` for `SELECT * FROM t --`, so the cap is appended *after* the `--`, producing `SELECT * FROM t -- LIMIT 1000` — the LIMIT is swallowed by the comment and the query runs uncapped. Whitelist + RLS still apply, so this is a DoS / oversized-result vector, not arbitrary-table read.
**Fix:** Append on a new line (`querySql += \`\nLIMIT ${rowLimit}\``), or strip trailing comments before the append. One-line change in two places.

**M-2 — RLS string-literal breakout via backslash on MySQL** — `packages/api/src/lib/rls.ts:165, 176`
RLS claim values escape `'` (`replace(/'/g, "''")`) but never `\`. On MySQL (default, `NO_BACKSLASH_ESCAPES` off), a claim value containing `\` breaks out of the `'...'` literal. PostgreSQL with `standard_conforming_strings=on` is safe.
**Exploit:** When RLS is enabled against MySQL and any claim is attacker-influenceable (e.g. an email/username claim), a `\`-bearing value alters the injected WHERE — widening/disabling the filter or injecting SQL.
**Fix:** Escape backslashes for MySQL, set `NO_BACKSLASH_ESCAPES`, or bind RLS values as parameters rather than literal AST nodes.

**M-3 — RLS injection fails open when a policy-matched table isn't in the AST FROM-walk** — `packages/api/src/lib/rls.ts:303-304`
Policy relevance is computed from `parser.tableList`, but injection only filters tables found in the FROM/JOIN alias-map walk. If a matched table is referenced in a construct the walk models differently, `if (!alias) continue;` silently drops the filter — the query runs with no RLS condition for that table. There is no post-injection assertion that every matched filter was applied.
**Fix:** After injection, assert every resolved filter group was applied; reject (fail-closed) if any was skipped.

**M-4 — `validateProposal` test query bypasses the RLS + auto-LIMIT pipeline** — `packages/api/src/lib/tools/validate-proposal.ts:161-174`
The LLM-authored `testQuery` is checked with `validateSQL` (SELECT-only + whitelist) but executed via raw `db.query(payload.testQuery, 30000)` against `connections.getForOrg(orgId)`, skipping `applyRLSEffect` and auto-LIMIT. `validateSQL` is also called with `connectionId: undefined`, so dialect/whitelist resolve against the default datasource while execution targets the org connection — a validation-vs-execution mismatch.
**Fix:** Route the test query through `runUserQueryPipeline`, or apply RLS + LIMIT explicitly and pass the executing `connectionId` to `validateSQL`.

### API surface — SSRF & prompt injection (3 findings)

All three share a root cause: the canonical SSRF guard (`isSafeExternalUrl` / `guardedFetch` in `lib/sandbox/validate.ts` + `lib/openapi/egress-guard.ts`) is robust, but these surfaces don't route through it.

**M-5 — Workspace model `baseUrl` is not SSRF-validated** — `packages/api/src/api/routes/admin-model-config.ts:76,92`; `ee/src/platform/model-routing.ts:303-321,789-807`
`baseUrl` is validated only by `new URL()` + an http/https protocol check — `http://` and private/loopback/link-local hosts are allowed. `POST /api/v1/admin/model-config/test` then `fetch`es it, and the live agent passes it into `createOpenAI({ baseURL })`.
**Exploit:** A workspace admin (low-trust in multi-tenant SaaS) sets `baseUrl: "http://169.254.169.254/latest/meta-data/..."` and uses the test endpoint as an SSRF oracle against cloud metadata / internal services.
**Fix:** Refine `baseUrl` with `isSafeExternalUrl` in the schemas and route the test/agent fetches through `guardedFetch` (with the existing `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS` opt-out for self-hosted).

**M-6 — Scheduler webhook delivery uses a weak SSRF check and follows redirects** — `packages/api/src/lib/scheduler/delivery.ts:30-67,219-249`
`isBlockedUrl` is a regex denylist against the literal hostname only — no DNS resolution (a public name resolving to an internal IP passes), no CGNAT/IPv4-mapped/`*.internal` coverage, and the `fetch` follows redirects by default (a public URL 302-ing to `169.254.169.254` is followed). Admin-gated and sensitive headers are stripped, which limits blast radius.
**Fix:** Replace `isBlockedUrl` with `isSafeExternalUrl` at registration and use `guardedFetch` (manual redirect + per-hop re-validation) for delivery.

**M-7 — Prompt-injection → email exfiltration via unrestricted `sendEmail` recipient** — `packages/api/src/lib/tools/registry.ts:192-207`; `packages/api/src/lib/integrations/email-tool.ts:346-352`
`sendEmail` is in the agent's default registry with `to` accepting any email address (no allowlist). `executeSQL` results, semantic YAML, and REST datasource responses flow into the model context as untrusted content with no trust boundary.
**Exploit:** An attacker who can write a value into a queried table or connected REST API embeds an instruction to email the result set to `attacker@evil.com`; a user's question surfaces that row and the agent sends. Requires the Email integration to be installed for the workspace (the public demo path returns `no_workspace`); staging has an outbound clamp but production does not constrain recipients.
**Fix:** Gate agent-initiated `sendEmail` behind a recipient allowlist (workspace members / admin-configured domains) and/or require human-in-the-loop confirmation; mark tool results as untrusted in the system prompt.

---

## Low severity

**Auth**
- **L-1** — `adminAuth` lacks the SaaS `mode:"none"` fail-closed guard that `platformAdminAuth` has (`packages/api/src/api/routes/middleware.ts:297-306`). Not reachable under correct config, but the weaker tier is the unguarded one.
- **L-2** — BYOT empty `ATLAS_AUTH_AUDIENCE=""` silently disables audience validation (`packages/api/src/lib/auth/byot.ts:93-97`). Treat empty-string as a hard config error.

**SQL**
- **L-3** — Table-less SELECTs with side-effecting/file/network functions (`pg_read_file`, `dblink`, `BENCHMARK`) pass all four layers (`sql.ts:270-285,528-555`). Mitigated by read-only role + timeout; `dblink` writes over a separate connection so only role privileges stop it. Add a function-name denylist (defense-in-depth).
- **L-4** — Whitelist case-folding mismatch vs. quoted mixed-case identifiers — `FROM "Orders"` matches lowercased whitelist entry `orders` but resolves to a distinct table (`whitelist.ts:85-102`; `sql.ts:531`).
- **L-5** — DuckDB file/network function denylist gaps: `read_blob`, `read_ndjson`, `glob` not listed (`plugins/duckdb/src/validation.ts:17-18`).

**Secrets**
- **L-6** — Default `BETTER_AUTH_SECRET` in `.env.example:80` is not denylisted at boot; it doubles as the at-rest encryption key fallback (`encryption-keys.ts:161-164`). Hard-fail the known default in managed-auth/SaaS.

**Frontend**
- **L-7** — Public shared/embed/report surfaces render LLM markdown images without `disallowImages` — tracking-pixel/IP-leak (`shared/[token]/embed/view.tsx:77`, `shared/[token]/page.tsx:198`, `report/[token]/report-view.tsx:117,149`). Dashboards already protect against this; one-line prop per surface.
- **L-8** — Widget `ErrorBanner` posts error metadata to any parent frame with `targetOrigin: "*"` (`packages/react/src/components/chat/error-banner.tsx:79-90`). Scope payload to opaque codes.
- **L-9** — CSP `script-src` allows `'unsafe-inline'` + `'unsafe-eval'` (`packages/web/next.config.ts:85`). Documented tradeoff (Next hydration, Recharts); means a future XSS sink wouldn't be CSP-contained.

**CI/CD & deployment**
- **L-10** — `mcp-registry.yml:25-27` downloads `mcp-publisher` from a mutable `latest` URL with no checksum, in a job holding OIDC publish rights. Pin + verify SHA256.
- **L-11** — `load-test-mcp.yml:133-143` fetches the k6 apt key over plaintext keyserver (mitigated by fingerprint pinning).
- **L-12** — `deploy-validation.yml:272-276` runs the API container with `--network=host` (acceptable on ephemeral runners; hygiene).
- **L-13** — Dev sidecar binds `0.0.0.0:8080` with no auth token (`docker-compose.yml:38-41`) — see H-1.
- **L-14** — Default `atlas:atlas` DB creds bound to `0.0.0.0` in dev/e2e/template composes (`docker-compose.yml:14-17` et al.). Bind to `127.0.0.1`.

---

## Informational / documented tradeoffs

- **I-1** — `simple-key` auth defaults to `admin` role when `ATLAS_API_KEY_ROLE` is unset (`simple-key.ts:70-74`). Document `member` as the least-privilege default for non-admin integrations.
- **I-2** — Simple-key embed exposes the API key to the host page (`sessionStorage` + `data-api-key`). Documented simple-key model; use managed/cookie auth where it matters.
- **I-3** — AES-GCM uses a per-message random 96-bit IV; collision risk only at >~2^32 messages per key. Not realistically reachable. No action.
- **I-4** — No global request-body size limit found in the API middleware stack; relies on the upstream proxy. Confirm an edge limit exists.
- **I-5** — Python sandbox AST guard is bypassable by design (subclass-walk escapes); safe only because the container is the boundary. Don't rely on it anywhere the container isn't present.
- **I-6** — `model-freshness.yml` external catalog fetch is properly `env:`-bound (defended); checkout SHA inconsistency across workflows (hygiene).

---

## Defenses verified sound (highlights)

- **SQL validation core** — empty check → comment-stripped regex guard (string-literal-aware) → AST single-statement SELECT-only (unparseable = reject, not skip) → whitelist (CTE names excluded, schema-qualified, fail-closed). MySQL `/*! */` executable-comment unwrap; `INTO OUTFILE/DUMPFILE` blocked at regex + AST; parameterized queries bound via driver protocol; plugin-rewritten SQL re-validated and RLS injected *after* hooks. Per-dialect readonly enforcement (PG `default_transaction_read_only`, MySQL `SET SESSION TRANSACTION READ ONLY`, ClickHouse `readonly:1`, DuckDB `READ_ONLY`).
- **Auth** — timing-safe key comparison (SHA-256 + `timingSafeEqual`), PKCE S256-only, single-use TTL-bounded OAuth state, HTTPS-pinned token endpoints, closed verification-link open-redirect, IDOR-scoped OAuth client queries, brute-force limits enabled by default, `BETTER_AUTH_SECRET` ≥32 with no insecure default, first-signup admin promotion gated, SCIM provenance fail-closed, MFA-gated admin routers.
- **Secrets/crypto** — AES-256-GCM with random IV + verified auth tag, versioned rotatable keyset, plaintext-fallback raises a boot-time P0 (not silent), DB-only tenant credential resolution (no env fallback, structurally enforced), `fast-redact` logger redaction + error scrubbing, connection-string masking on all datasource responses, 5xx errors sanitized to a request-ID reference (no stack traces to clients), webhook signatures timing-safe everywhere.
- **Sandbox** — `ATLAS_SANDBOX_PRIORITY` Zod-validated, SaaS pins `vercel-sandbox` with `deny-all`, nsjail read-only binds + fresh net namespace + `nobody` + rlimits, sidecar container runs `nobody` with `chmod -R a-w /semantic`, robust SSRF primitive (`net.BlockList` CIDR coverage, IPv4-mapped/NAT64 handling, fail-closed), plugins are build-time code (not tenant-uploaded).
- **API** — exact-match CORS allowlist (credentials never with `*`), Turnstile fail-closed on missing secret, CSV formula-injection neutralization, MCP OAuth 2.1 with per-region audience binding, 168-bit share tokens, OpenAPI `guardedFetch` re-validates every redirect hop.
- **Frontend** — react-markdown with safe defaults (no `rehype-raw`, `javascript:` stripped), no `dangerouslySetInnerHTML` on dynamic data, all postMessage receivers origin-guarded, `X-Frame-Options: DENY` + `frame-ancestors 'self'`, no secrets in `NEXT_PUBLIC_*`, `rel="noopener"` on all `target=_blank`.
- **CI/CD** — no `pull_request_target`/`workflow_run`/`issue_comment` triggers, all third-party actions SHA-pinned, OIDC + npm provenance publishing (no static token) gated on a protected environment + tag-only triggers, minimal scoped `permissions:`, disciplined `env:`-binding of untrusted inputs, `--ignore-scripts` at image install, registry-only lockfile, 48h supply-chain quarantine, non-root digest-pinned runtime images, no docker-socket mounts.

---

## Recommended priority order

1. **H-1** — fail closed on missing sidecar token + bind dev sidecar to localhost.
2. **H-2** — guard `seedDevUser` on non-prod + audit `password_change_required` enforcement on all auth paths.
3. **M-1** — newline the auto-LIMIT append (one-line, high-value).
4. **M-5 / M-6** — route model `baseUrl` and scheduler webhooks through `isSafeExternalUrl` / `guardedFetch`.
5. **M-2 / M-3 / M-4** — RLS hardening (MySQL backslash escaping, fail-closed injection assertion, route `validateProposal` through the pipeline).
6. **M-7** — recipient allowlist / human-in-the-loop for agent `sendEmail`.
7. Low/Info items as hardening backlog.
