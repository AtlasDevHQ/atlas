# Verify MCP + CLI Signup (Staging-First)

Human-in-the-loop verification that the **two non-web front doors work end-to-end**: a brand-new account is **provisioned through MCP** (`start_trial` → DCR/PKCE connect → a real MCP tool call), the grace account is **claimed**, and then that same account is **driven from the v0.0.35 CLI** (device-flow login → workspace bind → a REST-backed command, plus a workspace **API key** for the unattended path). Together with `/verify-prod-signup` (the web funnel) this covers all three entry points for v0.1.0.

**Build it on staging, then promote to prod.** Staging is the soak environment and relaxes two gates: **`requireEmailVerification: false`** (`lib/env-profile.ts:194`) and **Turnstile runs Cloudflare's always-pass test secret** so any non-empty token string is accepted (verified 2026-06-29 — a garbage token provisioned an account). **Phase A (MCP signup) is fully scriptable on staging.**

> ✅ **The whole flow is fully automatable on staging — no browser, no human (verified end-to-end 2026-06-29).** The claim looks walled (an MCP `start_trial` account has a **server-side random throwaway password that's never returned**, the web `/signup` funnel **collides** `422 USER_ALREADY_EXISTS`, `resolve-region` returns `none` for a grace account, and the OTP is **hashed** in the DB) — but staging runs a **real Resend key** and **clamps every recipient to the sink `staging-mail@useatlas.dev`**, and Resend's `GET /emails` list + `GET /emails/{id}` expose the sent OTP body. So the claim is automatable via the **email-OTP sign-in** path: `start_trial` → trigger `send-verification-otp` → read the OTP from the Resend API → `sign-in/email-otp` → **session**. From the session, the real `atlas login` device-flow completes headlessly (claim `GET /api/auth/device?user_code=…` with the session cookie → `device/approve` → `device/token`). See the **Automation recipe** at the bottom for the exact, proven steps. (One caveat: the workspace **API-key mint is MFA-gated** — `mfa_enrollment_required` — so the unattended *API-key* path needs TOTP enrollment; the *session* path needs none.) Prod deltas are enumerated below.

**When to run:** after a `/release` that touches MCP onboarding (`packages/mcp/src/`), the CLI (`packages/cli/src/`), the device-flow / OAuth seam, or API-key minting; as a pre-launch "can a new user actually onboard via MCP and use the CLI" pass.

**Mode:** verification pass — **file every defect as a follow-up GH issue; do NOT fix inline.** Screenshot each browser step.

---

## The three surfaces and where they live

| Phase | Surface | Auth | Key files |
|-------|---------|------|-----------|
| A | **MCP signup** — `start_trial` (anonymous) | Turnstile token only (no-op on staging) | `packages/mcp/src/onboarding.ts`, `ee/src/onboarding/provision-trial.ts` |
| B | **MCP use** — connect + a real tool call | OAuth 2.1 bearer (DCR + PKCE, `mcp:read`/`mcp:write`) | `packages/mcp/src/hosted.ts`, `packages/api/src/lib/mcp/auth-md.ts` |
| C | **CLI setup + use** — login, bind, query, API key | Device-flow session **+** workspace API key | `packages/cli/src/commands/*`, `packages/api/src/api/routes/admin-workspace-keys.ts` |

The MCP onboarding contract is the canonical guidance the server itself serves at `packages/api/src/lib/mcp/auth-md.ts:155-226` — read it; this command operationalizes it.

---

## Prerequisites

- **Staging is on the intended build.** `api-staging` builds from `deploy/api/Dockerfile` and shares the prod config with a single `staging` residency arm (`deploy/api-staging/atlas.config.ts`). Confirm `GET https://api.staging.useatlas.dev/api/health` is `200` (it reports `status: "degraded"` with `datasource: MISSING_DATASOURCE_URL` **by design** — see the no-datasource caveat).
- **A business email you don't mind burning.** The shared Better-Auth signup hook rejects free-mail/disposable domains (`business_email`). **Plus-addressing is allowed on `useatlas.dev`** (it's an exempt domain — verified: `biz+tag@useatlas.dev` provisions fine), so you *can* use the `/verify-prod-signup`-style `matt+mcpverify@useatlas.dev`. No mail is read on staging (OTP off + the outbound clamp sinks everything), so the address only needs to be valid-shaped and unused. **One trial per email** — and a second `start_trial` on an already-registered email currently returns `internal_error` (see Phase A note), so use a fresh local-part per run until torn down.
- **Playwright MCP** (`mcp__playwright__browser_*`) — needed for the OAuth **claim/consent** (Phase B) and the **device approval** page (Phase C). **Not** needed for Turnstile on staging. Resize tall (`1280×1600`).
- **A local CLI** pointed at staging for the whole run:
  ```bash
  export ATLAS_API_URL=https://api.staging.useatlas.dev
  ```
  Credentials store per-base-URL in `~/.atlas/credentials` (`0600`), so a staging login never clobbers a prod one (`packages/cli/src/lib/credentials.ts:49,66`). Run the CLI via `bun run atlas -- <cmd>` from the repo, or a built `atlas` binary.
- **Staging surfaces:** web `https://app.staging.useatlas.dev`, API `https://api.staging.useatlas.dev`. MCP is mounted **on the API app** at `/mcp` — there is no separate MCP service; the onboarding endpoint is `https://api.staging.useatlas.dev/mcp/onboarding`. The `connectUrl` that `start_trial` returns already uses the API host on staging (no `mcp.staging.*` brand mirror is needed).

---

## Phase A — Provision through MCP (`start_trial`)

`start_trial` is the **only** capability on the unauthenticated onboarding endpoint (Streamable HTTP, `mcp-session-id` assigned by the server). It needs `email`, `orgName`, `turnstileToken` and returns `{ workspaceId, connectUrl, state }` (`onboarding.ts:230-384`). It runs **outside** the dispatch gate and is **SaaS-only**.

**The Streamable HTTP handshake matters** — you do *not* invent the session id; the server assigns it on `initialize` and you echo it back. Responses are SSE (`data: {…}`):

```bash
API=https://api.staging.useatlas.dev
# 1. initialize WITHOUT a session id → read the assigned id from the response header
H=$(mktemp)
curl -sS -D "$H" -o /dev/null "$API/mcp/onboarding" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify-mcp-cli","version":"0"}}}'
SID=$(grep -i mcp-session-id "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"

# 2. initialized notification (→ 202)
curl -sS -o /dev/null "$API/mcp/onboarding" -H "mcp-session-id: $SID" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. start_trial. On staging ANY non-empty turnstileToken is accepted.
curl -sS "$API/mcp/onboarding" -H "mcp-session-id: $SID" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"start_trial",
       "arguments":{"email":"matt+mcpverify@useatlas.dev","orgName":"Atlas MCP+CLI Verify","turnstileToken":"staging-noop"}}}' \
  | sed -n 's/^data: //p'
```

**Expect:** `structuredContent = { workspaceId, connectUrl, state: "grace" }` where `workspaceId` is a 32-char id (e.g. `aBqCy91NdX4Te8Ye7vhsN5psXJZIfX1a`) and `connectUrl = https://api.staging.useatlas.dev/mcp/<workspaceId>/sse`. **Record both.**

**Confirm the identity landed (session-free, authoritative):**
```bash
EH=$(printf '%s' 'matt+mcpverify@useatlas.dev' | sha256sum | cut -d' ' -f1)
curl -sS "$API/api/v1/auth/region-probe" -H 'content-type: application/json' -d "{\"emailHash\":\"$EH\"}"
# → {"exists":true}
```
> Note: `app.staging.useatlas.dev/api/login/resolve-region` returns `{"outcome":"none"}` for an **unclaimed grace** account even though it exists — the login front-door only routes *claimed* accounts. Use **region-probe**, not resolve-region, as the existence oracle for grace accounts.

**Negative gates (each creates no account — quick to assert; observed responses):**

| Input | Result |
|-------|--------|
| `turnstileToken: "   "` (empty/whitespace) | `validation_failed` — "A Cloudflare Turnstile token is required" (presence check, before verification) |
| `email: someone@gmail.com` | `validation_failed` — "Please sign up with your work email address" (business-email gate) |
| `email: biz+tag@useatlas.dev` | **succeeds** — `useatlas.dev` is plus-exempt (would be `validation_failed`/`plus_addressing` on a non-exempt customer domain) |
| second `start_trial`, same email | ⚠️ `internal_error` "Trial provisioning failed unexpectedly" — **expected `signup_failed`/`locked`, not a 500-shaped error. File this.** (`provision-trial.ts` duplicate-user path) |

**Phase A pass:** `start_trial` returns `state: "grace"` + `workspaceId` + `connectUrl`; region-probe → `exists:true`; the empty-token and free-mail negative gates fire.

---

## Phase B — Connect to MCP and run a real tool call

Prove the workspace is **usable over authenticated MCP**, not just a DB row. The connect contract (`auth-md.ts:189-204`) — discovery chain **verified working on staging**:

```bash
WS=<workspaceId>
# Unauth → 401 with the RFC 9728 pointer:
curl -sS -D - -o /dev/null "$API/mcp/$WS/sse" -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -i www-authenticate
# → www-authenticate: Bearer realm="Atlas MCP", resource_metadata="…/.well-known/oauth-protected-resource/mcp/<WS>"

curl -sS "$API/.well-known/oauth-protected-resource/mcp/$WS"
# → {"resource":"https://api.staging.useatlas.dev/mcp",
#    "authorization_servers":["https://api.staging.useatlas.dev/api/auth"],
#    "bearer_methods_supported":["header"],"scopes_supported":["mcp:read","mcp:write"]}
```

From there, the **token mint needs an authenticated session** — discover the auth server (metadata lives under the `/api/auth` issuer path, not the root `/.well-known/...`), run **Dynamic Client Registration**, then the **authorization-code + PKCE** flow for a token carrying ≥ `mcp:read` (add `mcp:write` for a mutating tool) bound to the `…/mcp` audience.

> ✅ **Proven end-to-end headless (2026-06-29).** The OAuth `authorize` step needs an authenticated session, obtained on staging via the **email-OTP claim** (Automation recipe step 5c). With the session cookie: DCR → PKCE `authorize` → `consent` (re-presenting the signed `oauth_query`) → token (with `resource=<api>/mcp`) yields an `mcp:read` bearer whose `aud` is `…/mcp`; the connect handshake then `200`s and `tools/call listEntities` returns a structured result. The exact calls + the two non-obvious gotchas (consent body must carry `oauth_query`; `resource` indicator required on authorize **and** token) are in the recipe.

- The grace account is **claimed first** by signing in — the throwaway password from `provision-trial.ts:197` is never used; **email-OTP sign-in** claims it (flips `emailVerified`, extends the trial). On staging the OTP is read from the Resend sink (recipe below); on prod the human reads the OTP email.
- Easiest driver: the **embedded onboarding hook** `useMcpConnect` (`examples/embedded-mcp-onboarding/`) pointed at the region `apiUrl` runs DCR + PKCE + token exchange and hands back the access token. Otherwise run the dance by hand against `/api/auth/oauth2/{register,authorize,token}`.
- **With the bearer, call a read tool** against `$API/mcp/<WS>/sse` (`Authorization: Bearer …`, fresh `initialize`→`initialized`→`tools/call` handshake). Use `listEntities` / `explore` as the auth+plumbing probe — they don't need a datasource. (`executeSQL` reaches the SQL validator but **fails at the data layer on staging** — see the no-datasource caveat; that's still a *pass for auth*.)

**Phase B pass:** the unauth 401 + discovery chain resolve as above; the minted bearer verifies (signature/issuer/**audience**/workspace-claim/`mcp:read` scope, `hosted.ts:388-462`); single staging region → no `421`; a read tool returns a structured result (or a structured *no-datasource* error — **not** `401`/`403`).

---

## Phase C — Set up and use the CLI with the same account

The account is now claimed (real password set in Phase B). Keep `ATLAS_API_URL=https://api.staging.useatlas.dev` exported.

1. **Device-flow login** (`atlas login`, RFC 8628; `commands/login.ts`, `lib/device-flow.ts`, client_id `atlas-cli`). The endpoint is **verified live**:
   ```bash
   curl -sS "$API/api/auth/device/code" -H 'content-type: application/json' -d '{"client_id":"atlas-cli"}'
   # → {"device_code":…,"user_code":"8KZL5Q4V","verification_uri":"https://api.staging.useatlas.dev/device",
   #    "verification_uri_complete":"https://api.staging.useatlas.dev/device?user_code=…","expires_in":1800,"interval":5}
   ```
   Run `atlas login`; open the printed `verification_uri` — **it's on the API host `api.staging.useatlas.dev/device`, not the web app** — sign in with the **claimed** credentials and approve the code. The CLI polls `/api/auth/device/token`, fetches the bound workspace via `/api/auth/get-session`, and writes the bearer to `~/.atlas/credentials` keyed by the staging base URL. (If `device/code` `404`s, CLI login is dead — file it.)
2. **Bind the workspace** (if >1): `atlas switch` or `atlas switch <workspaceId>` → `/api/auth/organization/{list,set-active}`, persists `workspaceId` (`commands/switch.ts`).
3. **Exercise a session-auth REST command** — `atlas entities` (`GET /api/v1/semantic/entities`). On staging this returns an **empty** set / warnings (no datasource) — pass signal is a **200 with a parseable body, not a `401`**.
4. **Mint a workspace API key** (unattended/CI path; admin role — a fresh trial's owner session can mint):
   ```bash
   TOKEN=$(jq -r '.sessions["https://api.staging.useatlas.dev"].token' ~/.atlas/credentials)
   curl -sS "$API/api/v1/admin/workspace-keys" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"name":"mcp-cli-verify","expiresInDays":7}'
   # → { key, id, name, orgId, role }   — `key` is shown ONCE
   ```
   (`admin-workspace-keys.ts:94`; key carries `{ orgId, role, claims }`. The #4110/#4115 hardening **scoped** this key — confirm `role` matches the minter and isn't over-broad.)
5. **Exercise the API-key path** — overrides any stored session, rides `x-api-key` (`lib/credential.ts:31-35,74-81`):
   ```bash
   ATLAS_API_KEY=<key> atlas sql "SELECT 1"     # POST /api/v1/execute-sql
   ```
   On staging (no datasource) this returns a structured **`no_workspace`/no-datasource/whitelist** error — **auth passed**; a `401`/`403` here is the failure.

**Phase C pass:** `atlas login` completes and stores a bearer; `atlas entities` → `200` (not `401`); the API-key mint returns a one-time `key` with a correctly-scoped `role`; `ATLAS_API_KEY=<key> atlas sql` authenticates (reaches the data layer, not `401`/`403`).

---

## The no-datasource caveat (why the *answer* criterion defers to prod)

Staging has **no default/demo datasource** — confirmed by `/api/health` (`datasource: MISSING_DATASOURCE_URL`); demo data is **PROD-only** (#3921, `reference_staging_no_default_datasource`). A fresh trial workspace has **no tables**, so on staging `executeSQL` (MCP), `atlas sql`, and `atlas query` **cannot return a real answer** — they fail at the data layer, **not** at auth. **The staging pass bar is auth + provisioning + plumbing**: every call must reach the data layer (a structured no-datasource error is the pass; a `401`/`403` is the fail).

To exercise the **full** data path on staging instead of deferring it, provision a datasource first with the admin CLI — `atlas datasource create <id>` (URL via stdin/`DATASOURCE_SECRET_ENV`, never a flag; `commands/datasource.ts`) then `atlas datasource profile <id>` — and *then* run the query commands. Otherwise the real-answer criterion is verified on the **prod** run (NovaMart demo present), as `/verify-prod-signup` does.

---

## Acceptance criteria (staging)

- [ ] **MCP signup:** `start_trial` returns `state: "grace"` + `workspaceId` + `connectUrl`; region-probe → `exists:true`
- [ ] **Negative gates fire:** empty token → `validation_failed`; free-mail → business-email `validation_failed`
- [ ] **Idempotency:** second `start_trial` on the same email is handled with an *actionable* error (today it's `internal_error` — **file the defect**, don't accept the 500-shape)
- [ ] **MCP connect:** unauth 401 → discovery chain resolves; DCR + PKCE yields a `mcp:read` bearer; a read tool returns a structured result (not `401`/`403`)
- [ ] **Claim sets a real credential:** after the OAuth claim, the account is loginable (Phase C proves this)
- [ ] **CLI login:** `device/code` returns a code + `verification_uri` on the API host; `atlas login` completes and stores a staging-scoped bearer; `atlas entities` → `200` (not `401`)
- [ ] **API key:** mint returns a one-time `key` with `role` scoped to the minter (#4110/#4115); `ATLAS_API_KEY=<key> atlas sql` authenticates (reaches the data layer)
- [ ] **Plumbing, not answers:** SQL/query calls reach the data layer; the real-answer criterion is explicitly **deferred to prod** (or run after `atlas datasource create`)
- [ ] Screenshot at each browser step (OAuth claim, device approval)
- [ ] Any defect filed as a follow-up issue (don't fix inline)

---

## Teardown (verified working — `railway ssh -e staging -s api-staging` + the purge SSOT)

The MCP-provisioned account is the **same shape** as a web-funnel trial (user + org + members, trial tier → **no Stripe customer**, so the Stripe step is a no-op). Tear it down with the **platform-admin purge SSOT** — **never hand-rolled `DELETE`s or `ops wipe`**. The staging services live in the **`staging` environment** of the `satisfied-creation` project (id `08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241`); `api-staging`'s `DATABASE_URL` already points at the staging internal DB (`staging-postgres`, reachable via its public proxy).

**1. Register an SSH key (one-time per session; bare `keys add` auto-detects `~/.ssh`):**
```bash
railway ssh keys add -n verify-mcp-cli-teardown      # ⚠ `keys add -k <path>` is broken; use bare auto-detect
railway ssh keys list                                 # note the Source path; the private key is that path w/o .pub
```

**2. Run the purge SSOT in-container.** Write `td.ts` (identical to the `/verify-prod-signup` runbook's script), base64 it over ssh, run from `/app/packages/api` (the `@atlas/api/*` self-ref only resolves there). `TD_EMAIL` selects the account; `EXEC=1` is the execute gate (dry-run otherwise):
```bash
KEY=~/.ssh/id_ed25519_personal                        # MUST match the .pub `keys add` registered (it auto-picks an arbitrary ~/.ssh/*.pub — use the one whose comment is your Railway account email; an `-i` mismatch → status:signup_required)
PROJ=08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241
B64=$(base64 -w0 td.ts)
RUN='echo '"$B64"' | base64 -d > /app/packages/api/td.ts && cd /app/packages/api && %s bun run td.ts; rm -f /app/packages/api/td.ts'
# DRY RUN — confirm EXACTLY ONE owned org, region=staging, stripe=none, BEFORE EXEC=1:
railway ssh --project "$PROJ" --environment staging --service api-staging -i "$KEY" "$(printf "$RUN" 'TD_EMAIL=matt+mcpverify@useatlas.dev')"
# EXECUTE:
railway ssh --project "$PROJ" --environment staging --service api-staging -i "$KEY" "$(printf "$RUN" 'TD_EMAIL=matt+mcpverify@useatlas.dev EXEC=1')"
```
A clean run prints `hardDelete rows 3` (user + member + organization) per owned org.

**3. Verify gone, then remove the key + local creds:**
```bash
EH=$(printf '%s' matt+mcpverify@useatlas.dev | sha256sum | cut -d' ' -f1)
curl -sS "$API/api/v1/auth/region-probe" -H 'content-type: application/json' -d "{\"emailHash\":\"$EH\"}"   # → {"exists":false}
railway ssh keys remove verify-mcp-cli-teardown       # positional arg, NOT --name
atlas logout                                          # clears the staging entry in ~/.atlas/credentials
```
⚠️ **Dry-run first, always** (exactly one owned org, region `staging`). **Never** `ops wipe`/`TRUNCATE` a region DB. region-probe `exists:false` is the authoritative gone-check (resolve-region is unreliable for grace accounts).

---

## Promoting to prod — the deltas

Once green on staging, the prod run (`api.useatlas.dev` + region edges) differs in four ways:

1. **Email OTP returns.** `requireEmailVerification: true` in prod — the **claim** step (Phase B) sends an 8-char OTP via Resend; a human reads it (same HITL hand-off as `/verify-prod-signup`). `start_trial` itself still needs no OTP.
2. **Turnstile becomes real.** Prod sets a live `TURNSTILE_SECRET_KEY`, so `start_trial`'s `turnstileToken` must be a genuine token — **harvest it via the browser** (load a page with the prod Turnstile widget, read `input[name="cf-turnstile-response"]` once solved). This is the one Phase-A friction that staging doesn't have.
3. **Demo data is present** → the real-answer criterion **runs** on prod: MCP `executeSQL` and `atlas query` should return an answer over NovaMart. (The criterion deferred on staging.)
4. **Three regions.** Pick a region at claim; the bearer audience + `connectUrl` are region-specific (`mcp{,-eu,-apac}.useatlas.dev`). Cross-region MCP misrouting must return **`421 misdirected_request`** with the correct regional URL (`hosted.ts:621-682`) — the MCP analogue of `/verify-prod-signup`'s edge matrix. Point the CLI at the matching edge (`ATLAS_API_URL=https://api-<region>.useatlas.dev`). Teardown via `railway ssh --service api{,-eu,-apac}` (region = picked).

(Plus-addressing on `useatlas.dev` works in **both** envs — it's an exempt domain — so `matt+…@useatlas.dev` is fine everywhere.)

---

## Automation recipe — fully headless on staging (proven end-to-end 2026-06-29)

No browser, no human. The OTP claim is solved by reading the Resend sink via the API. Get the staging Resend key (operator): `railway variables --project <id> --environment staging --service api-staging --kv` → `RESEND_API_KEY` (a real `re_…`). Then:

```
1.  start_trial (Phase A handshake)                      → workspaceId, state=grace
2.  POST /api/auth/email-otp/send-verification-otp        {email, type:"sign-in"}   → 200
3.  Poll Resend until the NEWEST email id changes:
      GET https://api.resend.com/emails?limit=1           (Bearer $RESEND_API_KEY)
      → match subject "Your Atlas verification code", to == staging-mail@useatlas.dev
      GET https://api.resend.com/emails/{id}              → extract OTP from .html
      (the OTP is the 8-char token in the styled monospace <p letter-spacing…> — auth/server.ts:1164)
4.  POST /api/auth/sign-in/email-otp  {email, otp}        → 200 + session cookie/token  (account now CLAIMED)
5a. Use the session — REST: Bearer <token> → /api/v1/{trial,me/preferences,tables} all 200;
    /api/v1/execute-sql → 503 connection_unavailable (no datasource = auth PASSED).
5b. Phase C — real `atlas login` device flow, headless:
      POST /api/auth/device/code           {client_id:"atlas-cli"}         → device_code, user_code
      GET  /api/auth/device?user_code=…    (cookie jar from step 4)        → 200   (claims the code)
      POST /api/auth/device/approve        {userCode}  + Origin header + cookie jar → {"success":true}
      POST /api/auth/device/token          {client_id, device_code, grant_type:urn:…device_code} → access_token
    Write ~/.atlas/credentials = {version:1,sessions:{"<api>":{token:<access_token>,workspaceId,createdAt}}}
      → `ATLAS_API_URL=<api> atlas entities`  → 200 (empty, no datasource)
      → `atlas sql "SELECT 1"`                → "Connection default not available in published mode" (auth PASSED)
5c. Phase B — authenticated MCP (DCR + PKCE + consent + resource-bound bearer):
      POST /api/auth/oauth2/register        {redirect_uris,token_endpoint_auth_method:"none",scope:"mcp:read"} → client_id (public, no secret)
      GET  /api/auth/oauth2/authorize       ?response_type=code&client_id&redirect_uri&scope=mcp:read
                                            &code_challenge(S256)&resource=<api>/mcp   (cookie jar) → 302 to /oauth2/consent?<SIGNED_Q>
      POST /api/auth/oauth2/consent         {accept:true, oauth_query:"?<SIGNED_Q>"}  (cookie jar) → {redirect:true,url:"…callback?code=…"}
      POST /api/auth/oauth2/token           grant_type=authorization_code, code, code_verifier, client_id, redirect_uri, resource=<api>/mcp → access_token (aud=<api>/mcp, scope=mcp:read)
      → MCP handshake on /mcp/<WS>/sse with `Authorization: Bearer`  → initialize 200, tools/list (14 tools),
        tools/call listEntities → {"count":0,"entities":[]}  (auth + dispatch PASSED; empty = no datasource)
```

Gotchas baked in above: `device/approve` needs an **`Origin` header** (else `MISSING_OR_NULL_ORIGIN`) **and** the prior `GET /device?user_code` claim (else "device code has not been claimed by a verifying session"); the OAuth **consent** must re-present the **signed `oauth_query`** (the full query string from the authorize 302, with its `ba_*` + `sig` params) in the POST body — and read the code from the response's **`.url`** field; the **`resource=<api>/mcp`** indicator (RFC 8707) is **required on BOTH authorize and token** or the bearer's `aud` won't match the MCP verifier (`hosted.ts` `resourceAudience()`) and the connect handshake returns no session; poll the **newest** Resend id (selecting "any id ≠ pre" grabs a *stale* OTP). The remaining CI work:

1. **Datasource fixture on staging** so data-path commands assert real answers instead of `503`/no-datasource (`atlas datasource create` against a throwaway Postgres, or a CI workspace exempt from #3921).
2. **Dedicated identities + auto-teardown** — `ci-mcp@useatlas.dev` with the in-container purge SSOT (above) after each run.
3. **Cadence:** post-`/release` or nightly soak, not per-PR.
4. **Prod** still needs a real OTP inbox (the Resend trick is staging-only — prod isn't clamped to a sink an operator can read via the send key). Plus Findings B/E below.

---

## Findings (live run 2026-06-29 — file as issues)

- **A. MCP `start_trial` → "claim your account on the web" has no working *web* claim path.** The throwaway password is never returned; `/signup` with the same email **collides** (`422 USER_ALREADY_EXISTS`) rather than offering a claim/set-password screen; `resolve-region` returns `none` for an unclaimed account. The account *is* claimable via **email-OTP sign-in** (proven), but a normal user following the "claim on the web" CTA to `/signup` hits a dead end. **Confirm the intended claim UX; the `/signup` path the `start_trial` message implies is broken.** *(Gates whether MCP onboarding converts.)*
- **B. Staging signup region picker routes account-creation to PROD APIs.** `app.staging.useatlas.dev` signup offers US/EU/APAC whose `apiUrl`s point at `api.useatlas.dev` (prod); picking one POSTs `sign-up/email` to prod → `net::ERR_FAILED`. The staging picker should offer only the single `staging` arm. #3948-class but a hard funnel break, not cosmetic.
- **C. Duplicate `start_trial` → `internal_error`** (500-shape) instead of a clean `signup_failed`/`locked` for an already-registered email (`provision-trial.ts` duplicate-user path).
- **D. Workspace API-key mint is MFA-gated** — a brand-new trial owner's session hits `mfa_enrollment_required` on `POST /api/v1/admin/workspace-keys` ("Two-factor authentication is required for admin accounts"). So the unattended **API-key** path needs TOTP/passkey enrollment first; the **session** path (device-flow `atlas login`) needs none. Expected by design, but document it — the CLI API-key story for a fresh account isn't "mint and go."
- **E. Stale comment fixed this session:** `lib/env-profile.ts:191` claimed "no Resend on staging — dummy key"; staging actually runs a **real** Resend key (`ATLAS_EMAIL_PROVIDER=resend`) clamped to the sink. Comment corrected.
- **F. (minor) Discovery/handshake nits baked into this doc:** Streamable HTTP assigns the `mcp-session-id` (self-generating → `unknown_session`); device approval URL is on the **API** host; `resolve-region` is unreliable for grace accounts (use region-probe).
