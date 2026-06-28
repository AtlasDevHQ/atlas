# Verify Prod Signup (3-Region Residency)

Human-in-the-loop verification that a **real, end-to-end signup works through each data-residency region in PRODUCTION** — `us` / `eu` / `apac` — confirming the region step, residency routing, and the cold-start demo first-answer for a brand-new user. Drive it with the Playwright MCP browser; a human reads the email OTP at each region's OTP step.

**When to run:** after a `/release` lands on prod (so the funnel runs against current code), as a pre-launch "is anything broken for a new user" pass, and before cutting a milestone tag that touches signup / onboarding / residency. This is the runnable form of #3943.

**Why prod only:** the region step renders only on a **multi-region SaaS** deploy (EE `ResidencyResolver` with `residency.regions` configured). Local dev and staging are single-region (`"local"`), so the three-region routing path can only be exercised against prod.

**Mode:** verification pass — **file every defect as a follow-up GH issue; do NOT fix inline.** Capture a screenshot at each funnel step per region.

---

## Prerequisites

- **Prod release shipped.** Confirm the 4 tag-gated prod services (`api`, `api-eu`, `api-apac`, `web`) are on the intended tag SHA (`/deploy` or Railway `list_deployments`). Verifying against a stale build is worthless. (`docs` and `www` deploy direct-from-`main` and aren't part of the tag gate.)
- **A business-domain inbox you can read in real time.** Prod's env-profile sets `requireEmailVerification: true` — signup sends an **8-character OTP** via Resend (10-min expiry), **no bypass**. The business-email gate (`packages/api/src/lib/auth/business-email.ts`) rejects free-mail (gmail/outlook/proton/…) and disposable domains.
  - Use plus-addressing on a business domain so all OTPs land in one inbox and each region is a distinct user (→ fresh trial, not the `locked` churn tier): **`matt+us@useatlas.dev` / `matt+eu@…` / `matt+apac@…`**.
- **Playwright MCP** connected (`mcp__playwright__browser_*`). Resize the viewport tall (e.g. `1280×1600`) — the region step's Continue button sits below the fold on a short viewport and won't scroll into view.
- Prod surfaces: web `https://app.useatlas.dev`, region APIs `https://api{,-eu,-apac}.useatlas.dev`.

---

## Flow (repeat per region: us → eu → apac)

Start each region from a clean session: if already signed in, open the user menu → **Sign out**, then go to `/signup`.

1. **Account** — `https://app.useatlas.dev/signup`. Fill Name / Work email (`matt+<region>@useatlas.dev`) / Password. Screenshot. Click **Create account** → sends the OTP.
2. **OTP (HITL hand-off)** — screenshot the "Enter your code" step, then **stop and ask the human for the 8-char code** from the inbox. Type it in; it auto-submits on the 8th char.
3. **Workspace** — name it (`Atlas <REGION> Verify`); the slug auto-fills. Screenshot. Continue.
4. **Region** — screenshot. Assert the picker shows **all configured regions with `us` pre-selected as Default**. For `us`, continue with the default; for `eu`/`apac`, **click the target region** (it shows pressed + a checkmark) then Continue.
   - ⚠️ Cross-check `GET /api/v1/onboarding/regions` (below) — it should return **only** the real prod regions. A `staging` region leaking into prod is a defect (see #3948).
5. **Connect** — choose **Explore demo data** → "Use NovaMart (E-commerce) demo dataset". (The funnel won't advance unless `assign-region` returned 200.) Screenshot.
6. **Success** — screenshot. Confirm the dataset-derived starter prompts render (#3935) and the 14-day trial banner shows.
7. **First answer** — click a starter prompt → app opens with it pre-filled (dismiss the guided tour if it appears) → Send. Wait ~25s, snapshot. **A correct answer with a result table is the pass.** A "Table X is not in the allowed list" error is a fail (see #3947).
8. **Residency invariants** — before signing out, run primitives 4 & 7 (cross-region edge matrix + raw probe) from the authed app; then sign out and run primitive 5 (login routing). Screenshot each result.

**After all three regions** — for the multi-region chooser (primitive 6), sign up the **same** email (`matt+multi@useatlas.dev`) in **two** regions (e.g. us then eu), then run `resolve-region` once and confirm `outcome: "multiple"`. Tear `matt+multi@` down in **both** regions during teardown.

---

## Verification primitives (run in the authed browser via `browser_evaluate`)

All are credentialed `fetch`es from `app.useatlas.dev` to the region API — substitute the per-region host below, don't hard-code `api.useatlas.dev`. Under ADR-0024 §5 the session cookie is **host-only** (not a parent-`.useatlas.dev` cookie), so it is sent **only** to the workspace's own region host: a credentialed fetch to `api-<region>` carries it (→ `200`), and a fetch to any other region edge carries no cookie (→ `401`). That non-portability is exactly what primitive 4 below asserts.

```js
// Region API base — pick the host for the region under test. eu/apac MUST use their own
// host, or the routing proof below silently hits the US instance and falsely passes.
const API = { us: 'https://api.useatlas.dev', eu: 'https://api-eu.useatlas.dev', apac: 'https://api-apac.useatlas.dev' }[region];

// 1. Regions offered at /signup/region — expect ONLY real prod regions, default us.
//    Global pre-assignment config served by the web app's default API, so this one stays on api.useatlas.dev.
await fetch('https://api.useatlas.dev/api/v1/onboarding/regions', { credentials: 'include' }).then(r => r.json())
// → { configured: true, defaultRegion: "us", availableRegions: [us, eu, apac] }   // staging present = defect (#3948)

// 2. assign-region response (read from the network log, POST .../assign-region) — the routing proof.
// → { workspaceId, region: "<picked>", assignedAt }   // region MUST equal the picked region

// 3. Workspace table whitelist — proves the workspace metadata routes to the picked region's DB
//    AND that the demo seed landed (should be the 13 NovaMart entities). Hits the region's OWN API
//    (api-eu / api-apac for eu/apac) — querying api.useatlas.dev for an eu/apac workspace proves nothing.
await fetch(`${API}/api/v1/tables`, { credentials: 'include' }).then(r => r.json())
// → 13 tables incl. order_items/products/categories/orders
```

**Routing assertion:** `assign-region.region === picked region` **and** `/api/v1/tables` resolves the 13 demo tables in-region. If `/api/v1/tables` lists a table but `executeSQL` rejects it as "not in the allowed list," that's the #3947 whitelist-scope mismatch — the schema-explorer whitelist and the query-time whitelist disagree.

---

## ADR-0024 residency-invariant assertions (the #3967 regression gate)

The primitives above prove the picker *recorded* the region and the demo seed *landed in-region*. They do **not** prove the deeper [ADR-0024](../../docs/adr/0024-regional-identity-isolation.md) invariant that #3967 was filed for: **the identity itself is regional** — an EU/APAC workspace has *no row in the US DB*, and `api.useatlas.dev` genuinely `401`s it. Run these per region; an unexpected `200` from a foreign region's edge is the residency violation returning.

```js
// The full region→edge map. Under ADR-0024 §5 the session cookie is HOST-ONLY:
// an eu session token is sent ONLY to api-eu, never to api.useatlas.dev or api-apac.
const EDGES = { us: 'https://api.useatlas.dev', eu: 'https://api-eu.useatlas.dev', apac: 'https://api-apac.useatlas.dev' };

// 4. CROSS-REGION EDGE MATRIX (the core #3967 invariant). From the authed app
//    after the signup, hit every region edge. EXACTLY the workspace's own region
//    must 200; the OTHER two must 401 (no identity row there + host-only cookie
//    never transits them). A 200 from a foreign edge = the residency violation.
for (const [r, host] of Object.entries(EDGES)) {
  const status = (await fetch(`${host}/api/v1/tables`, { credentials: 'include' })).status;
  // r === region → 200 (13 tables) ;  r !== region → 401   (200 on a foreign edge = FAIL, #3967)
}

// 5. RETURNING-USER LOGIN ROUTING (ADR-0024 §3, #3973). Sign out first (zero
//    session). The login front-door lives on the WEB app (app.useatlas.dev),
//    NOT a regional API, and resolves email→region before any session exists.
await fetch('https://app.useatlas.dev/api/login/resolve-region', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `matt+${region}@useatlas.dev` }),
}).then(r => r.json())
// → { outcome: "single", region: "<region>", apiUrl: EDGES[region] }
//   (apiUrl is the region's edge: api-eu/api-apac for eu/apac, but the bare
//    api.useatlas.dev for us — it has no `-us` suffix.)

// 6. MULTI-REGION CHOOSER (ADR-0024 §6 — same email = two accounts). Requires a
//    SHARED email signed up in ≥2 regions: do an extra signup of matt+multi@useatlas.dev
//    in BOTH us and eu, then resolve it. Two hits → the chooser, not a silent pick.
await fetch('https://app.useatlas.dev/api/login/resolve-region', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'matt+multi@useatlas.dev' }),
}).then(r => r.json())
// → { outcome: "multiple", regions: [ { region: "us", apiUrl, label }, { region: "eu", … } ] }

// 7. RAW REGION PROBE (the front-door's per-region oracle, ADR-0024 §3). Deterministic
//    existence check that doesn't depend on a session — hash the email (sha256 of the
//    lower-cased address, 64-hex) and POST it to each region's probe. `exists` is true
//    in EXACTLY the region(s) the email is registered in. Proves identity locality directly.
const emailHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`matt+${region}@useatlas.dev`.toLowerCase())))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
for (const [r, host] of Object.entries(EDGES)) {
  const { exists } = await fetch(`${host}/api/v1/auth/region-probe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailHash }),
  }).then(res => res.json());
  // exists === (r === region)   — true only in the home region, false everywhere else
}
```

**Residency assertion (gates #3967):** for a workspace in region `R`, edge `api-R` `200`s and BOTH other edges `401` (primitive 4); `resolve-region` routes the returning login to `R` (5); the raw probe reports `exists` in `R` only (7); and an email present in two regions surfaces `outcome: "multiple"` (6). Any foreign-edge `200`, or `resolve-region` pointing at the wrong region, is the residency regression.

---

## Post-signup session durability (the #4018 regression gate)

The residency primitives prove the *region* is right. They do **not** prove the
brand-new signup lands in a **working app**: #4018 was a separate session/auth
defect where, straight after "Open Atlas", every authed call `401`'d and a reload
bounced to `/login`, and even after a manual login the **first chat send** `401`'d
"session expired". Run this **immediately after the signup completes (before any
manual sign-out/login)**, from the authed app, against the workspace's **own**
region edge. It asserts the app's own credential path — the **host-only session
cookie**, with **no** `Authorization` header (exactly how the app's REST layer
authenticates) — works for both the bootstrap GETs and a chat `POST`.

```js
// Home-region edge for the workspace under test (eu/apac use their own host).
const API = { us: 'https://api.useatlas.dev', eu: 'https://api-eu.useatlas.dev', apac: 'https://api-apac.useatlas.dev' }[region];

// 8a. BOOTSTRAP GETS — cookie-only (NO Authorization header), exactly like the
//     app's REST path (useAdminFetch). Every one must 200 right after signup.
for (const path of ['/api/v1/trial', '/api/v1/mode', '/api/v1/conversations',
                    '/api/v1/tables', '/api/v1/me/preferences', '/api/v1/me/connection-groups']) {
  const status = (await fetch(`${API}${path}`, { credentials: 'include' })).status;
  // EVERY path → 200. Any 401 = the #4018 durable-session regression (the
  // signup/OTP handoff isn't establishing the cookie the app reads).
}

// 8b. CHAT POST AUTHENTICATES VIA THE COOKIE. Send an empty body so the agent
//     never runs — we're probing AUTH, not a turn. Crucially send NO bearer:
//     the chat transport must ride the same cookie as REST (a stale in-memory
//     `atlas-api-key` bearer used to override the cookie → 401 "session expired").
const chatStatus = (await fetch(`${API}/api/v1/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  credentials: 'include', body: '{}',
})).status;
// → 422 (body validation) or 2xx — auth PASSED. 401 = the #4018 chat-transport regression.
```

**Session-durability assertion (gates #4018):** straight after signup, every
bootstrap GET in 8a `200`s and the chat `POST` in 8b is **not** `401` (a `422`
validation is the pass — auth cleared, body didn't). A `401` from any 8a path, or
a `401` from 8b, is the durable-session / chat-transport regression returning.

---

## Per-region acceptance criteria

- [ ] Signup completes end-to-end through the real OTP gate, no dead-end at any step
- [ ] `/signup/region` shows all configured regions, default `us` pre-selected; picking the target → `assign-region` 200
- [ ] `assign-region.region` == picked region; `/api/v1/tables` resolves the 13 demo tables in-region (routing proof)
- [ ] **Cross-region edge matrix (ADR-0024 / #3967):** the workspace's own region edge `200`s; **both** other region edges `401` (identity row lives only in-region; a foreign-edge `200` is the residency violation)
- [ ] **Returning-user login routes to the home region:** after sign-out, `resolve-region` for the workspace's email → `{ outcome: "single", region: <home> }`
- [ ] **Raw probe is region-local:** the per-region `region-probe` reports `exists: true` only in the home region
- [ ] **Multi-region chooser:** an email signed up in two regions → `resolve-region` → `{ outcome: "multiple", regions: [...] }`
- [ ] **Post-signup session durable (#4018):** straight after "Open Atlas", the bootstrap GETs (primitive 8a) all `200` and the chat `POST` (8b) is not `401`; a reload stays authenticated (no bounce to `/login`)
- [ ] Post-signup app loads and a **demo query returns an answer** in that region
- [ ] Screenshot captured at each funnel step
- [ ] Any defect filed as a follow-up issue (don't fix inline)

---

## Teardown (do this — surgically, in-container via `railway ssh`)

The verify accounts are real prod identities (user + org + members). A *trial* signup that never reaches checkout mints **no Stripe customer** — org-scoped billing (#4014) stopped creating the user-level `createCustomerOnSignUp` customer, so `org.stripeCustomerId` is `none` and the Stripe teardown step is a no-op (only an account that actually checked out has a `cus_…` to purge). Tear accounts down with the **platform-admin purge SSOT** (`purgeStripeBillingForWorkspace` → `updateWorkspaceStatus("deleted")` → `hardDeleteWorkspace`), **never by hand-rolled `DELETE`s or `ops wipe`**.

### ⚠️ The region DBs are internal-only — you cannot run `atlas-operator` locally

The published `atlas-operator ops teardown-verify-accounts --region <R>` command resolves `ATLAS_REGION_<R>_DB_URL`, **but those URLs aren't reachable from a laptop**: the region internal Postgres (`us-int-postgres`/`eu-int-postgres`/`apac-int-postgres`) has no public TCP proxy (its `DATABASE_PUBLIC_URL` is an empty/broken shared-scope ref), and the API image doesn't bundle the `atlas-operator` binary or the `packages/cli` source. So the working path is to run the **same `packages/api` SSOT in-container** via `railway ssh`, where `DATABASE_URL` already points at that region's internal DB (and `STRIPE_SECRET_KEY` is present, US-only).

**Step 1 — register an SSH key with Railway (one-time per session; `gen → add → remove`).** The CLI registers via your authenticated session (no browser). ⚠️ `keys add -k <path>` is broken ("Key not found" for any path) — use **bare `keys add` (auto-detect)**, which scans `~/.ssh` and registers the first key it finds. Bare `railway ssh` with no registered key returns `status:signup_required` with a browser URL — registering via `keys add` is what avoids that.

```bash
railway ssh keys add -n atlas-teardown            # auto-detects ~/.ssh/id_ed25519*, registers via CLI
railway ssh keys list                             # confirm; note the Source: path it picked
# smoke test — confirm you land in the right region container:
railway ssh --service api -i ~/.ssh/<picked-key> \
  "node -e 'console.log(new URL(process.env.DATABASE_URL).host, !!process.env.STRIPE_SECRET_KEY)'"
```

`--service api` is the **US** region container; the EU/APAC API services are separate Railway services (use `railway ssh --service <eu-api-service>` / `<apac-api-service>` — `railway ssh keys`/list is account-level so the key works for all).

**Step 2 — run the teardown SSOT in-container.** Write a small script that imports the SSOT, base64 it over the ssh command, and run it from **`/app/packages/api`** (the `@atlas/api/*` self-reference only resolves inside the package dir — running from `/tmp` fails with `Cannot find module`). The script (`TD_EMAIL` selects the account; `EXEC=1` is the execute gate, dry-run otherwise):

```ts
// td.ts — DRY RUN unless EXEC=1. Reuses the platform-admin purge SSOT.
import { internalQuery, updateWorkspaceStatus, hardDeleteWorkspace, closeInternalDB } from "@atlas/api/lib/db/internal";
import { purgeStripeBillingForWorkspace } from "@atlas/api/lib/billing/workspace-teardown";
const EMAIL = (process.env.TD_EMAIL || "").toLowerCase(), EXEC = process.env.EXEC === "1";
const rows = await internalQuery(`SELECT u.id AS "userId", m.role AS "memberRole", o.id AS "orgId",
  o.name AS "orgName", o.region, o.workspace_status AS "ws", o."stripeCustomerId" AS "sc"
  FROM "user" u LEFT JOIN member m ON m."userId"=u.id LEFT JOIN organization o ON o.id=m."organizationId"
  WHERE lower(u.email)=$1`, [EMAIL]);
console.log("MODE", EXEC ? "EXECUTE" : "DRY RUN", "rows", rows.length);
for (const o of rows.filter(r => r.orgId && r.memberRole === "owner")) {
  console.log(`ORG ${o.orgId} "${o.orgName}" region=${o.region} status=${o.ws} stripe=${o.sc || "none"}`);
  if (!EXEC) continue;
  console.log("  stripe", JSON.stringify((await purgeStripeBillingForWorkspace(o.orgId, o.sc)).actions));
  console.log("  soft", await updateWorkspaceStatus(o.orgId, "deleted"));
  const p = await hardDeleteWorkspace(o.orgId);
  console.log("  hardDelete rows", Object.values(p).reduce((s, n) => s + n, 0));
}
await closeInternalDB().catch(() => {});
process.exit(0);
```

```bash
KEY=~/.ssh/<picked-key>; B64=$(base64 -w0 td.ts)
RUN='echo '"$B64"' | base64 -d > /app/packages/api/td.ts && cd /app/packages/api && %s bun run td.ts; rm -f /app/packages/api/td.ts'
# DRY RUN (confirm exactly one owned org, correct region, expected stripe):
railway ssh --service api -i "$KEY" "$(printf "$RUN" 'TD_EMAIL=matt+us@useatlas.dev')"
# EXECUTE:
railway ssh --service api -i "$KEY" "$(printf "$RUN" 'TD_EMAIL=matt+us@useatlas.dev EXEC=1')"
```

**Step 3 — verify gone, then remove the key.** Both probes are session-free:

```bash
H=$(printf '%s' matt+us@useatlas.dev | sha256sum | cut -d' ' -f1)
curl -s https://api.useatlas.dev/api/v1/auth/region-probe -H 'content-type: application/json' -d "{\"emailHash\":\"$H\"}"   # → {"exists":false}
curl -s https://app.useatlas.dev/api/login/resolve-region -H 'content-type: application/json' -d '{"email":"matt+us@useatlas.dev"}'  # → {"outcome":"none"}
railway ssh keys remove atlas-teardown            # positional arg, NOT --name
```

- **Run the dry run first, always.** Confirm it resolves **exactly one owned org**, the **right region**, and the expected Stripe state before setting `EXEC=1`. The `matt+multi@` chooser account exists in **two** regions — tear it down in **each** (ssh into each region's API service).
- **Mislocated-account residue check (ADR-0024 / #3967):** the pre-fix verify runs created EU/APAC accounts *in the US DB*. Prove they're gone — a DRY RUN against the **US** container for the EU/APAC emails (`TD_EMAIL=matt+eu@useatlas.dev`, etc.) must resolve **zero** owned orgs.
- **NEVER run `ops wipe` (or a bare `TRUNCATE`) against a region DB** — it destroys every tenant. The SSOT above only touches the resolved org's rows.
- The local `atlas-operator -- ops teardown-verify-accounts --region <R> --email <addr>` form is still the canonical tool **if** you have a reachable path to the region DB (e.g. a temporary `railway` TCP proxy on the int-postgres, removed after) — same double-gate (`ATLAS_TEARDOWN_OK=1` + `--confirm`), no `DATABASE_URL` fallback.

---

## Known issues this flow surfaces (check whether still open before re-filing)

- **#3967** — EU/APAC residency selection ignored (workspace + identity provisioned/served from US). **Fixed by the #3969–#3974 cluster (ADR-0024); the residency-invariant assertions above are its regression gate** — a foreign-edge `200` or a mis-routed login means the regression is back. File a re-open, not a new issue.
- **#3947** — demo first-answer dead-ends: `executeSQL` rejects whitelisted tables despite `/api/v1/tables` listing them (region-agnostic; **fails criterion 4**).
- **#3948** — `staging` region leaks into the prod region picker.
- **#3949** — demo-only signup gets a "connect your database" onboarding email (no demo-aware branch in the email sequence).
- **#4018** — brand-new signup lands in a broken app: post-signup session not durable (every authed call `401`s, reload → `/login`) and the first chat send `401`s "session expired". **Regression gate is primitive 8** above — run it right after signup. Fixed by hydrating the session after OTP verify + a hard-nav "Open Atlas" (durable cookie) and making the chat transport cookie-only in managed mode (no stale bearer).
- **#4086** — ⚠️ **OPEN (regression of #4018, caught on `v0.0.33`):** post-signup the funnel dead-ends at **Connect** — `POST /api/v1/onboarding/use-demo` and *every* `/api/v1/*` call `401` "Not signed in", while `/api/auth/*` (org-create) succeeds. Root cause: `email-otp/verify-email` returns `set-auth-token` (bearer) with **no `Set-Cookie`**, but the `/api/v1` REST layer is cookie-only — so no session cookie exists on the API host (a credentialed same-site fetch `401`s, violating ADR-0024 §5). Region-agnostic. Primitive 8 is its gate. Until fixed, the demo first-answer + the authed residency primitives (4, 6) can't run; the session-light primitives (1, 5, 7) still pass.

---

## Future: make it unattended (CI)

The only thing keeping this HITL is the **email OTP** — everything else is already scriptable (the Playwright drive + the three `fetch` assertions above). To run it in CI:

1. **Programmatic OTP read.** Give the test inbox an API (a Resend *inbound* route → webhook/store, or an IMAP/mailbox API for `useatlas.dev`) so the runner can poll for the 8-char code instead of a human. This is the single blocker.
2. **Dedicated test identities.** Pre-provisioned `ci+us@ / ci+eu@ / ci+apac@useatlas.dev` (business-domain) with automatic surgical teardown after each run via `atlas-operator ops teardown-verify-accounts --region <R> --email <ci+R@…> --confirm` (`ATLAS_TEARDOWN_OK=1`).
3. **Cadence, not per-PR.** Run post-`/release` (a `staging-smoke`-style job gated on the prod promote) or nightly — not on every PR. It exercises live prod signup + Resend + residency routing, which is a soak check, not a unit gate.
4. **Assert, don't screenshot.** In CI the routing + residency primitives above (1–7) are the pass/fail signal; the cross-region edge matrix (4), `resolve-region` (5), and raw probe (7) are session-light and deterministic. Keep screenshots as artifacts for triage only.
5. **No `executeSQL` LLM dependence in the gate.** Criterion 4 (demo answer) needs the agent; keep that as a separate `@llm`-tagged check so the routing assertions (1–3) stay deterministic and cheap.

Until (1) lands, this stays a human-in-the-loop ops command — run it by hand after each prod release.
