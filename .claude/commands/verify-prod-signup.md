# Verify Prod Signup (3-Region Residency)

Human-in-the-loop verification that a **real, end-to-end signup works through each data-residency region in PRODUCTION** — `us` / `eu` / `apac` — confirming the region step, residency routing, and the cold-start demo first-answer for a brand-new user. Drive it with the Playwright MCP browser; a human reads the email OTP at each region's OTP step.

**When to run:** after a `/release` lands on prod (so the funnel runs against current code), as a pre-launch "is anything broken for a new user" pass, and before cutting a milestone tag that touches signup / onboarding / residency. This is the runnable form of #3943.

**Why prod only:** the region step renders only on a **multi-region SaaS** deploy (EE `ResidencyResolver` with `residency.regions` configured). Local dev and staging are single-region (`"local"`), so the three-region routing path can only be exercised against prod.

**Mode:** verification pass — **file every defect as a follow-up GH issue; do NOT fix inline.** Capture a screenshot at each funnel step per region.

---

## Prerequisites

- **Prod release shipped.** Confirm the 5 prod services are on the intended tag SHA (`/deploy` or Railway `list_deployments`). Verifying against a stale build is worthless.
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

---

## Verification primitives (run in the authed browser via `browser_evaluate`)

All are same-origin-credentialed `fetch`es from `app.useatlas.dev` to the region API:

```js
// 1. Regions offered at /signup/region — expect ONLY real prod regions, default us.
await fetch('https://api.useatlas.dev/api/v1/onboarding/regions', { credentials: 'include' }).then(r => r.json())
// → { configured: true, defaultRegion: "us", availableRegions: [us, eu, apac] }   // staging present = defect (#3948)

// 2. assign-region response (read from the network log, POST .../assign-region) — the routing proof.
// → { workspaceId, region: "<picked>", assignedAt }   // region MUST equal the picked region

// 3. Workspace table whitelist — proves the workspace metadata routes to the picked region's DB
//    AND that the demo seed landed (should be the 13 NovaMart entities).
await fetch('https://api.useatlas.dev/api/v1/tables', { credentials: 'include' }).then(r => r.json())
// → 13 tables incl. order_items/products/categories/orders
```

**Routing assertion:** `assign-region.region === picked region` **and** `/api/v1/tables` resolves the 13 demo tables in-region. If `/api/v1/tables` lists a table but `executeSQL` rejects it as "not in the allowed list," that's the #3947 whitelist-scope mismatch — the schema-explorer whitelist and the query-time whitelist disagree.

---

## Per-region acceptance criteria

- [ ] Signup completes end-to-end through the real OTP gate, no dead-end at any step
- [ ] `/signup/region` shows all configured regions, default `us` pre-selected; picking the target → `assign-region` 200
- [ ] `assign-region.region` == picked region; `/api/v1/tables` resolves the 13 demo tables in-region (routing proof)
- [ ] Post-signup app loads and a **demo query returns an answer** in that region
- [ ] Screenshot captured at each funnel step
- [ ] Any defect filed as a follow-up issue (don't fix inline)

---

## Teardown (do this — surgically)

The 3 accounts are plain signups: **no Stripe customer**, a 14-day auto-expiring trial row, empty demo-only workspaces.

- **Default (safe): leave them to auto-expire.** Harmless; no billing artifacts.
- **Surgical delete (only if needed):** delete just the test org + user rows in each region DB (`ATLAS_REGION_US/EU/APAC_DB_URL`).
- **NEVER `bun run atlas -- ops wipe`** against a prod region DB — it TRUNCATEs every public table and would destroy real tenants.

---

## Known issues this flow surfaces (check whether still open before re-filing)

- **#3947** — demo first-answer dead-ends: `executeSQL` rejects whitelisted tables despite `/api/v1/tables` listing them (region-agnostic; **fails criterion 4**).
- **#3948** — `staging` region leaks into the prod region picker.
- **#3949** — demo-only signup gets a "connect your database" onboarding email (no demo-aware branch in the email sequence).

---

## Future: make it unattended (CI)

The only thing keeping this HITL is the **email OTP** — everything else is already scriptable (the Playwright drive + the three `fetch` assertions above). To run it in CI:

1. **Programmatic OTP read.** Give the test inbox an API (a Resend *inbound* route → webhook/store, or an IMAP/mailbox API for `useatlas.dev`) so the runner can poll for the 8-char code instead of a human. This is the single blocker.
2. **Dedicated test identities.** Pre-provisioned `ci+us@ / ci+eu@ / ci+apac@useatlas.dev` (business-domain) with automatic surgical teardown after each run.
3. **Cadence, not per-PR.** Run post-`/release` (a `staging-smoke`-style job gated on the prod promote) or nightly — not on every PR. It exercises live prod signup + Resend + residency routing, which is a soak check, not a unit gate.
4. **Assert, don't screenshot.** In CI the three primitives above are the pass/fail signal; keep screenshots as artifacts for triage only.
5. **No `executeSQL` LLM dependence in the gate.** Criterion 4 (demo answer) needs the agent; keep that as a separate `@llm`-tagged check so the routing assertions (1–3) stay deterministic and cheap.

Until (1) lands, this stays a human-in-the-loop ops command — run it by hand after each prod release.
