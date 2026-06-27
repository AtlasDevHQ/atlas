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

## Per-region acceptance criteria

- [ ] Signup completes end-to-end through the real OTP gate, no dead-end at any step
- [ ] `/signup/region` shows all configured regions, default `us` pre-selected; picking the target → `assign-region` 200
- [ ] `assign-region.region` == picked region; `/api/v1/tables` resolves the 13 demo tables in-region (routing proof)
- [ ] **Cross-region edge matrix (ADR-0024 / #3967):** the workspace's own region edge `200`s; **both** other region edges `401` (identity row lives only in-region; a foreign-edge `200` is the residency violation)
- [ ] **Returning-user login routes to the home region:** after sign-out, `resolve-region` for the workspace's email → `{ outcome: "single", region: <home> }`
- [ ] **Raw probe is region-local:** the per-region `region-probe` reports `exists: true` only in the home region
- [ ] **Multi-region chooser:** an email signed up in two regions → `resolve-region` → `{ outcome: "multiple", regions: [...] }`
- [ ] Post-signup app loads and a **demo query returns an answer** in that region
- [ ] Screenshot captured at each funnel step
- [ ] Any defect filed as a follow-up issue (don't fix inline)

---

## Teardown (do this — surgically, via the CLI)

The verify accounts are real prod identities (user + org + members; a Stripe customer — note that a trial signup's customer lands on the **user** row, not the org, see #4011). Tear them down with the dedicated operator tool — **never by hand-rolled SQL or `ops wipe`**:

```bash
# DRY RUN first (default — lists exactly what would go, deletes nothing):
bun run atlas -- ops teardown-verify-accounts --region eu --email matt+eu@useatlas.dev
# EXECUTE (double-gated, like ops wipe): cancels Stripe + soft-deletes + hard-deletes
#   the org and its now-orphaned user, reusing the platform-admin purge SSOT:
ATLAS_TEARDOWN_OK=1 bun run atlas -- ops teardown-verify-accounts \
  --region eu --email matt+eu@useatlas.dev --confirm
# Repeat per region (--region us/eu/apac selects ATLAS_REGION_<R>_DB_URL). The shared
# matt+multi@ chooser account exists in two regions — tear it down in EACH.
```

- **DRY RUN by default; EXECUTE needs `ATLAS_TEARDOWN_OK=1` + `--confirm`** (the same double-gate as `ops wipe`). Non-plus-addressed emails are refused unless `--force` — a guard against fat-fingering a real customer's address into a prod teardown.
- **One region DB per invocation.** `--region` resolves `ATLAS_REGION_<R>_DB_URL`; there is **no `DATABASE_URL` fallback** (the wrong-DB footgun).
- **Mislocated-account residue check (ADR-0024 / #3967):** the pre-fix verify runs created EU/APAC accounts *in the US DB*. Prove they're gone — a DRY RUN of the US DB against the EU/APAC emails must resolve **zero** orgs:
  ```bash
  bun run atlas -- ops teardown-verify-accounts --region us \
    --email matt+eu@useatlas.dev,matt+apac@useatlas.dev   # expect: 0 workspace(s)
  ```
- **NEVER `bun run atlas -- ops wipe`** against a prod region DB — it TRUNCATEs every public table and would destroy real tenants.

---

## Known issues this flow surfaces (check whether still open before re-filing)

- **#3967** — EU/APAC residency selection ignored (workspace + identity provisioned/served from US). **Fixed by the #3969–#3974 cluster (ADR-0024); the residency-invariant assertions above are its regression gate** — a foreign-edge `200` or a mis-routed login means the regression is back. File a re-open, not a new issue.
- **#3947** — demo first-answer dead-ends: `executeSQL` rejects whitelisted tables despite `/api/v1/tables` listing them (region-agnostic; **fails criterion 4**).
- **#3948** — `staging` region leaks into the prod region picker.
- **#3949** — demo-only signup gets a "connect your database" onboarding email (no demo-aware branch in the email sequence).

---

## Future: make it unattended (CI)

The only thing keeping this HITL is the **email OTP** — everything else is already scriptable (the Playwright drive + the three `fetch` assertions above). To run it in CI:

1. **Programmatic OTP read.** Give the test inbox an API (a Resend *inbound* route → webhook/store, or an IMAP/mailbox API for `useatlas.dev`) so the runner can poll for the 8-char code instead of a human. This is the single blocker.
2. **Dedicated test identities.** Pre-provisioned `ci+us@ / ci+eu@ / ci+apac@useatlas.dev` (business-domain) with automatic surgical teardown after each run via `atlas ops teardown-verify-accounts --region <R> --email <ci+R@…> --confirm` (`ATLAS_TEARDOWN_OK=1`).
3. **Cadence, not per-PR.** Run post-`/release` (a `staging-smoke`-style job gated on the prod promote) or nightly — not on every PR. It exercises live prod signup + Resend + residency routing, which is a soak check, not a unit gate.
4. **Assert, don't screenshot.** In CI the routing + residency primitives above (1–7) are the pass/fail signal; the cross-region edge matrix (4), `resolve-region` (5), and raw probe (7) are session-light and deterministic. Keep screenshots as artifacts for triage only.
5. **No `executeSQL` LLM dependence in the gate.** Criterion 4 (demo answer) needs the agent; keep that as a separate `@llm`-tagged check so the routing assertions (1–3) stay deterministic and cheap.

Until (1) lands, this stays a human-in-the-loop ops command — run it by hand after each prod release.
