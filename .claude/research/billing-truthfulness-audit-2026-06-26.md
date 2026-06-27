# Billing & entitlements truthfulness audit — v0.1.0 launch gate

**Date:** 2026-06-26
**Trigger:** Disposition decision for #3515 (metered token overage). Decision: **keep in v0.1.0**, but expand the scope from "wire metered billing" to a launch-blocking milestone that guarantees **every tier/feature on www matches what `plans.ts` defines, what the code enforces per-tier, and what actually works end-to-end.**

Sources read:
- `apps/www/src/app/pricing/pricing-content.tsx` — advertised claims (TIERS + COMPARISON_SECTIONS + FAQS)
- `packages/api/src/lib/billing/plans.ts` — the limits/features SSOT
- `packages/api/src/lib/billing/enforcement.ts` — what is actually enforced at runtime
- `packages/api/src/api/routes/integrations.ts`, `integrations-discord.ts` — the `getWorkspaceEntitlement`/`isPlanEligible` per-tier gate (#2701)
- `ee/src/{auth,compliance,governance,audit,branding}/*` — EE feature gating (`isEnterpriseEnabled()`)

---

## TL;DR

- **Numeric limits are honest and enforced** (tokens, seats, connections, chat integrations). www ↔ plans.ts ↔ enforcement all line up. Query→token ratio is a clean ~20K tokens/query across all paid tiers.
- **The token overage story is currently honest** because #3422 amended the copy to describe the real hard cap. `overagePerMillionTokens: 1.0` sits in `plans.ts` but is **not charged** (display-only). #3515 metered billing would wire it (and reverse part of the #3422 copy amend).
- **The big gap:** the pricing page sells a **per-tier feature ladder** for ~10 EE security/compliance/hosting features as **Business-only**, but those features are gated at the **deployment level** (`isEnterpriseEnabled()`), **not per workspace tier**. There is no code that restricts SSO/SCIM/masking/approvals/backups/IP-allowlist/custom-roles/white-label/audit-retention to the Business tier. On the SaaS deployment they're reachable by any tier (modulo UI hiding, which is not an enforcement boundary).
- **One advertised feature is currently broken:** "Data residency (3 regions)" — #3967 / milestone 75 is fixing the fact that EU/APAC selections are ignored.

---

## Reconciliation matrix

### Numeric limits — ✓ CONSISTENT & ENFORCED

| Claim (www) | plans.ts | Enforced by | Verdict |
|---|---|---|---|
| Starter $29 | `starter.pricePerSeat: 29` | Stripe price IDs | ✓ |
| Pro $59 | `pro.pricePerSeat: 59` | " | ✓ |
| Business $99 | `business.pricePerSeat: 99` | " | ✓ |
| Starter ~100 q/seat/mo | `2_000_000` tok/seat | `checkPlanLimits`→`evaluateUsage` | ✓ (~20K tok/q) |
| Pro ~250 q/seat/mo | `5_000_000` | " | ✓ (~20K tok/q) |
| Business ~750 q/seat/mo | `15_000_000` | " | ✓ (~20K tok/q) |
| Starter 10 / Pro 25 / Business ∞ seats | `maxSeats 10/25/-1` | `checkResourceLimit("seats")` | ✓ |
| Starter 1 / Pro 3 / Business ∞ connections | `maxConnections 1/3/-1` | `checkResourceLimit("connections")` | ✓ |
| Starter 1 / Pro 3 / Business ∞ chat integrations | `maxChatIntegrations 1/3/-1` | `checkChatIntegrationLimitAndInstall` (atomic, #3001) | ✓ |
| Default model Haiku/Sonnet/Sonnet | `defaultModel` per tier | model resolution | ✓ |
| Trial = Starter limits, 14 days | `trial: 2M/10/1/1`, `TRIAL_DAYS 14` | enforcement + `provision-trial` | ✓ |
| Self-Hosted = unlimited (BYOK) | `free: all UNLIMITED` | enforcement skips `free` | ✓ |
| "Warn → 10% grace → pause" | 80% warn / 100–109% soft / 110% block | `classifyUsage` thresholds | ✓ |

### Per-tier feature gating — ⚠ MIXED

| Feature (www) | Sold as | Per-tier enforced? | Mechanism |
|---|---|---|---|
| Custom domain | Pro + Business | ✓ modeled (`features.customDomain`) — **but see note** | `PlanFeatures.customDomain` is set true for pro/business; need to confirm it's *consulted* to gate (grep shows it's only read for display) |
| Chat / action integrations | per tier (1/3/∞) | ✓ | `getWorkspaceEntitlement` + `isPlanEligible` (#2701) via marketplace `catalogMinPlan` |

### EE feature ladder — ✗ GAP (sold per-tier, gated per-deployment)

All sold as **Business-only** on /pricing. None gate on workspace tier — they gate on `isEnterpriseEnabled()` (deployment-level). Route files reference tier/entitlement **0 times**.

| Feature (www "Business") | EE module | Tier gate? |
|---|---|---|
| SSO (SAML + OIDC) | `ee/src/auth/*` | ✗ deployment-only |
| SCIM directory sync | `ee/src/auth/scim.ts` | ✗ |
| Custom roles & permissions | `ee/src/auth/roles.ts` | ✗ |
| IP allowlisting | `ee/src/auth/ip-allowlist.ts` | ✗ |
| Approval workflows | `ee/src/governance/approval.ts` | ✗ |
| Audit log retention policies | `ee/src/audit/retention.ts` | ✗ |
| PII detection & masking | `ee/src/compliance/masking.ts` | ✗ (`isEnterpriseEnabled()` only) |
| Automated backups | `ee/src/...` | ✗ |
| White-label branding | `ee/src/branding/white-label.ts` | ✗ |
| Data residency (3 regions) | `ee/src/platform/residency.ts` | ✗ modeled in `features.dataResidency` but **not consulted**; also **broken** (#3967) |

**Note on `PlanFeatures`:** the type models only `customDomain`, `sso`, `dataResidency`, `sla`. The other 7 Business features have **no representation in the plan model at all**. And even the 4 it models are only *read for display* — grep finds no call site that uses `features.sso`/`features.dataResidency` to *block* a non-Business workspace.

### Minor copy drifts — ⚠ TIDY

- **"All 8 integrations (6 chat + Linear + GitHub)"** (Business card) vs **"Chat integrations … All 6"** (comparison row). 8 vs 6 is defensible (Linear/GitHub are `action` pillar, don't consume a chat slot) but reads as a contradiction. Align the phrasing.
- **`plans.ts` header comment says "model-aware token budgets"** but the FAQ correctly says *"every token counts the same regardless of which model."* The budget is a **flat token count**, NOT model-aware. The comment is stale/aspirational. (#3515 workstream 1 — model-weighted accounting — is what would make "model-aware" literally true.)
- **`overagePerMillionTokens: 1.0`** present for starter/pro/business but not charged; `overagePerMillionTokens` wire field deliberately not rendered (#3422). Either wire it (#3515) or keep it dormant — don't leave it half-surfaced.

---

## Proposed milestone scope (3 workstreams)

This is bigger than #3515. Proposed: rename/retarget the milestone to **"Billing Truthfulness & Metered Overage"** (or fold into v0.1.0 directly), with #3515 as one of three workstreams.

### WS1 — Tier/feature truthfulness reconciliation (the new, launch-critical part)
Make the per-tier feature ladder real, or make the page honest. Decision per feature:
- **(a) Enforce per-tier:** add a per-tier entitlement gate to the EE feature routes (reuse the `getWorkspaceEntitlement`/`isPlanEligible` pattern from #2701, or add a `requireBusinessTier` middleware). Extend `PlanFeatures` to model all advertised features so the page renders from the SSOT.
- **(b) Re-tier the page:** if a feature is genuinely available to all paid tiers (deployment-gated), stop advertising it as Business-only.
- Add a **drift guard** (a test that diffs www claims ↔ `plans.ts` ↔ enforced gates) so the page can't silently drift again — analogous to the existing schema-drift / enterprise-gating drift checks.

### WS2 — Metered token overage (the original #3515)
- Model-weighted (output-equivalent) accounting — also makes "model-aware budget" true.
- Stripe Billing Meters API metered item, idempotent/reconcilable reporter.
- Soft-cap semantics replacing the 110% hard block + an **abuse ceiling** (runaway-agent guard) — required before launch so metered billing can't produce surprise bills.
- Re-align pricing/FAQ copy (reverses part of #3422).

### WS3 — End-to-end verification ("and it actually works")
- Staging Stripe test-mode soak for the metered path (#2905 is live).
- Per-tier entitlement E2E: prove a Starter workspace is blocked from a Business feature and a Business workspace is allowed.
- Confirm data residency works (depends on milestone 75 / #3967).

---

---

## ADDENDUM A — www feature-list freshness ("it's been a while")

Two parallel inventories: www **claims** ~158 feature-rows across pages; product **ships** ~75 distinct capabilities. The gap is mostly granularity, but there are real drifts.

### A1 — Shipped but NOT advertised (add / promote)
Capabilities that exist in the product but the marketing site under-sells or omits:
- **Durable / long-running turns** (ADR-0020, milestone v0.0.20) — a real differentiator, unmentioned.
- **Dashboard drafts + versioning + bound-mode editing** (chat-driven dashboard mutations with draft/approve) — unmentioned.
- **Plugin SDK + self-serve plugin registry** (`@useatlas/plugin-sdk`, `create-atlas-plugin`) — "extend anything" is hinted but the SDK story isn't told.
- **Datasource breadth** — ES/OpenSearch (v0.0.13), generic REST/OpenAPI, ClickHouse, DuckDB, Snowflake, BigQuery, Salesforce, Twenty, Obsidian. The page's counts don't reflect this.
- **MCP server prominence** — listEntities/describeEntity/searchGlossary/runMetric over MCP; agent-native is a strong wedge, under-promoted.
- **Semantic-layer admin editor** (on-platform entity/metric builder vs YAML-only).
- **React embeddable component + SDK** (`@useatlas/react`, `@useatlas/sdk`).

### A2 — Advertised but NOT (verified) live (soften / verify)
- **"6 chat platforms"** (`components/landing/comparison.tsx:28`) + **"All 8 integrations (6 chat + Linear + GitHub)"** (`pricing-content.tsx:126`). Only **Slack** is confirmed prod-live; Teams/Discord/Telegram/WhatsApp/Google Chat exist in code (`plugins/chat`) but their prod OAuth/live status must be verified before claiming "6 platforms." **Must-verify pre-launch.** Cross-check `docs/architecture/chat-plugin-atlas-contract.md` + prod OAuth registrations.
- **"Data residency (3 regions)"** — advertised on the Business tier but **currently broken** (#3967); only truthful once milestone 75 lands.

### A3 — Inconsistent / ambiguous counts (fix wording)
- **"21 plugins across 5 types"** (`comparison.tsx:54`) — only 4 plugin types are documented; reconcile the type count and the plugin count to reality.
- **"All 8 integrations (6 chat + Linear + GitHub)"** vs comparison row **"Chat integrations … All 6"** — 8 vs 6 reads as a contradiction. Pick one framing (chat-pillar vs all-pillar) and apply consistently.

### A4 — Correctly honest (no action)
- **SOC 2 Type II / ISO 27001** — DPA + privacy pages explicitly state Atlas does **not** hold either and they're "on the roadmap / aligned with controls." Legally careful. Leave as is.

**Verdict:** the www freshness work is a real WS — call it **WS4 — www feature-page refresh**: add A1, verify/soften A2, fix A3. Build it from the `plans.ts` + capability SSOT so it's drift-checkable alongside WS1.

---

## ADDENDUM B — core → EE boundary review ("anything to bump into EE?")

The governing rule (`docs/development/enterprise-gating.md`): anything that exists *specifically to make Atlas a hosted SaaS* or is commercial-differentiating belongs in `ee/src/`. Billing/metering is a deliberate **carve-out that stays in core** (gated by `STRIPE_SECRET_KEY`). The inversion is guarded by `scripts/check-ee-imports.sh` — **scoped only to `packages/api/src`.**

### B1 — Clean candidates (doc says EE, code lives in core)
- **Abuse prevention** (`lib/security/abuse.ts`, `abuse-instances.ts`, `lib/trial-abuse.ts`; routes `admin-abuse.ts`, `*-security-metrics.ts`). The doc lists "abuse prevention" verbatim as EE; the graduated multi-tenant warn→throttle→suspend response exists to protect the hosted platform. **Counter:** baseline rate-limiting is a security primitive a self-hoster reasonably wants and shouldn't be paywalled — so split *baseline (core)* from *multi-tenant graduated response (EE)* rather than moving wholesale.
- **Plugin marketplace plan-gated veneer** (`admin-marketplace.ts` catalog CRUD + `saas_eligible` filtering keyed on `deployMode === "saas"`; `plan-rank.ts`). "Plugin marketplace" is named verbatim as EE. **Counter:** the unified install pipeline (ADR-0007) is genuinely core; only the plan-gated *marketplace veneer* + `saas_eligible` is SaaS-commerce. Split finer, don't move the pipeline.

### B2 — Leave in core (intentional "core implements, EE gates")
- **Proactive chat** (`lib/proactive/`, 14 files) — fails closed without EE via `ProactiveGate.requireEnabled`; the gate Tag *is* the licensing boundary. Moving it is a large, risky lift for ~no license gain (already unreachable without EE).
- **Demo / lead-capture funnel** — already half-split (the Twenty dispatcher is EE in `ee/src/saas-crm/`; generic outbox + demo/contact entry points are deliberately core).

### B3 — Real boundary finding (decide pre-launch)
- **`@atlas/mcp` (AGPL core package) hard-depends on `@atlas/ee`** — `packages/mcp/package.json:27` `workspace:*`; imports `@atlas/ee/onboarding/provision-trial` (static) and `@atlas/ee/governance/approval` (dynamic). This is the one place a **core-licensed package directly depends on the commercial package**, and `check-ee-imports.sh` can't see it (it only watches `packages/api/src`). Likely intentional (MCP is the SaaS trial bootstrap), but it's a **license-cleanliness item** worth a conscious decision before the public launch surfaces the AGPL/commercial split to outside eyes: either route those MCP paths through a Context.Tag like core API does, or formally treat `@atlas/mcp`'s onboarding surface as SaaS-coupled (and extend the guard to cover it).

**Verdict:** the core→EE moves (B1) are worth doing but are **NOT launch-blockers** — recommend a separate, non-blocking **"EE boundary tidy"** track. The one launch-relevant item is **B3** (license cleanliness for the public AGPL/commercial story) — small, worth resolving before the tag.

---

## Open product decisions (need Matt)

1. **Per-feature disposition** for the 10 EE features: enforce per-tier (a) vs re-tier the page (b)? Likely a mix — e.g. SSO/SCIM/masking/approvals are classic "Business" gates worth enforcing; some may be fine deployment-wide.
2. **Abuse ceiling** for metered overage: hard cap on overage $ / tokens before a runaway agent is cut off.
3. **BYOT interaction** with overage: BYOT already bypasses token enforcement — confirm overage never accrues for BYOT.
4. **Does WS1 alone unblock launch, with WS2 (metered) following in a fast-follow tag?** WS1 is the truthfulness/legal risk; WS2 is revenue upside. Worth deciding whether the *whole* thing blocks the tag or just WS1.

---

## DECISION (2026-06-27) — Usage pricing model: platform fee + at-cost usage (Structure B)

Resolves open decisions #2 (abuse ceiling) and #3 (BYOT × overage), and **supersedes WS2's "metered overage at an advertised rate"** framing.

### The problem with the old framing

WS2 originally assumed token overage billed at a (marked-up) rate. Two things made that wrong:

- **The seeded numbers are dishonest *and* below cost.** `overagePerMillionTokens: 1.0` in `plans.ts` sits **~15× below** provider cost (~$15/Mtok output-equivalent). And Business's 15M included tokens ≈ **$225 of model spend for a $99 plan** — a token loss-leader. Included usage and overage are priced 6–14× apart and backwards.
- **We have no usage data to price against.** Atlas is pre-launch / validation phase. We cannot forecast customer usage, so any markup model is guesswork.

### The decision — Structure B (three independently-honest layers)

1. **Per-seat platform fee** (by tier) — where **all** margin lives; predictable, usage-independent.
2. **AI usage metered at provider cost, no markup** — one shared meter; Atlas does not profit on tokens.
3. **Feature ladder** (SSO/SCIM/residency/…) — the tier differentiator (already enforced via `FEATURE_ENTITLEMENTS`, #3986–88).

Each seat price **includes a usage credit sized _below_ the seat price**; the gap is the guaranteed margin floor. Example: **$39 seat − $20 included usage = $19/seat floor**, regardless of usage. Overage past the credit meters at the same provider cost.

**Why this is right for validation phase:** margin = the platform fee, independent of usage. The one number we *can't* know pre-launch (how much customers use) is the number we *don't profit on* — so we cannot mis-price it. The model is robust to the absence of usage data **by construction**.

### Calibration data (2026-06-27, read-only pull from prod region DBs)

`token_usage` + `usage_events`, US/EU/APAC:

- **Only ~11 authenticated turns exist** — one dogfooding workspace (US), Opus-heavy, May 16–Jun 2. EU/APAC empty. **Not representative** — zero signal on per-user monthly volume.
- **Turn shape is structural / reliable:** input-dominated (~50K input + ~40K cache-read when warm), output negligible (~1K, ~1–2% of tokens).
- **Real cost/turn (with caching):** Sonnet **~$0.20**, Opus **~$0.86–1.08**, Haiku **~$0.07** (extrapolated). Caching cuts warm Sonnet turns ~37%.
- **$20 of at-cost usage ≈ 300 Haiku / 100 Sonnet / 21 Opus turns / month.** Generous on the Haiku (Starter) default, comfortable on the Sonnet (Pro/Business) default. **Model default is a ~14× cost lever → keep Opus off the defaults.**

### Locked numbers (validation phase — recalibrate ~30d post-launch via the hot-reloadable setting)

- **Full ladder (decided 2026-06-27) — all self-serve, published, NO sales call:** **Starter $39 / Pro $69 / Business $149 per seat**, with a **flat $20/seat at-cost usage credit on every paid tier**. The credit pools per-seat (enforcement = `perSeat × seatCount`), so team size ladders the included pool automatically — no per-tier credit ladder, which keeps "bigger tier = bigger token bucket" framing permanently dead. Margin floors: **$19 / $49 / $129**. Entry $39 is hard-locked; $69 / $149 are the working recommendation (no market data — calibrate from real deals). **No solo tier**; a future **"Enterprise — Custom"** 4th tier is deferred to post-launch.
- **Business is deliberately self-serve, including SSO / SCIM / data residency** — the opposite of the industry norm of gating compliance behind a sales call. Rationale (Matt, 2026-06-27): "post-SaaS-sales-call era — everything should be doable by the buyer." This is a wedge, not just a price point. It's **executable today**: WS1 tier-gated entitlements (#3986–88) + residency routing (v0.0.31) mean a Business checkout auto-flips the SSO/SCIM/residency entitlements with no manual provisioning; IdP/SCIM config is admin self-serve.
- `overagePerMillionTokens` → the **provider-cost rate** (~$15/Mtok output-equivalent), sourced from `lib/token-pricing.ts` (cost SSOT), **uniform across tiers** — not a per-tier markup.
- `tokenBudgetPerSeat` derives from `includedUsageDollars / costRate`, so "included = $X of usage at cost" is literally true (add a parity guard).
- Abuse ceiling (`ATLAS_ABUSE_CEILING`, #3990) flips from "% of included token budget" → **per-seat dollar cap on at-cost spend**, operator-liftable.
- BYOT pays the platform fee, brings own keys, accrues **no** metered usage.

### Cost basis — RESOLVED (2026-06-27): `gateway.cost`, zero-markup, exact (no estimation)

Atlas resolves models through **Vercel AI Gateway**, which is **zero-markup** (provider list price, no per-token surcharge, even BYOK) and returns the **actual charged cost per request inline**: `providerMetadata.gateway.cost` (USD decimal string; also `gateway.marketCost`, `gateway.generationId`). The `/v1/report` API exposes `total_cost` / `market_cost` / `surcharge_cost` / `gateway_cost`; `/v1/credits` gives lifetime spend.

So **"at cost" is exact, not estimated.** Record `gateway.cost` per turn at `onFinish` (next to the existing `token_usage` write — small change + a `gateway_cost_usd` column) and draw the included credit + overage meter down against the **summed real dollars**. This supersedes the list-price rate constant for *billing* — `lib/token-pricing.ts` / TokenWeighting (#3989) stay for display/estimates + budget fallback only. Use `gateway.cost` (what Atlas actually pays); being zero-markup it equals `marketCost`.

**Bonus — free reconciliation oracle:** `/v1/report` + `/v1/credits` let us cross-check our metered sum against Vercel's own ledger, directly satisfying #3992's idempotent-reconcile requirement and the #4003 soak.

### Amends PRD #3984

"Re-pricing the tiers" moves **out of** Out-of-Scope — the entry tier dollar amount + the included-usage denomination now change. Feature-ladder, EE-boundary, and www-truthfulness workstreams unaffected.

### Issue re-map (milestone v0.0.33)

- **#3991** — was "metered Stripe prices *per tier*"; now **one shared at-cost metered usage price** + keep the per-tier seat subscription prices.
- **#3992** (`OverageMeter`) — reports usage **at provider cost** (not a markup); **fast-follow, not launch-blocking** (no early customer exhausts a $20 credit in week one). Also absorbs the abuse-ceiling → per-seat-dollar-cap change.
- **#3993** (copy) — "**platform fee + AI usage at provider cost, no markup; $20 included**", not "overage at the advertised rate".
- **Ships for validation:** honest packaging (seat fee in Stripe + at-cost rate in `plans.ts` + honest page). Live overage metering (#3992) is the fast-follow.
