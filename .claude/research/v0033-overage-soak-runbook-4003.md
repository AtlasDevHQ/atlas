# v0.0.33 — Metered overage staging soak runbook (#4003, WS3 HITL)

> Operator aid for [#4003](https://github.com/AtlasDevHQ/atlas/issues/4003). Soak the
> metered at-cost overage path against **Stripe test-mode on staging** before it touches
> live revenue. Companion to the billing audit `billing-truthfulness-audit-2026-06-26.md`
> and umbrella [#3984](https://github.com/AtlasDevHQ/atlas/issues/3984).
>
> **Status:** unblocked — #3991 (register the test-mode metered price + capture the price ID)
> is closed. Everything below is code-complete on `main`; this is the observe-and-confirm pass.

## What you're verifying (the four ACs)

1. Overage **accrues** past the soft cap (100% of the included credit) on staging.
2. Meter events are reported **idempotently** and the ledger **reconciles** with Stripe.
3. The **abuse ceiling** cuts off (429) as configured.
4. Results recorded; any defects filed as follow-ups.

## How the path works (so you know what to watch)

- **Included credit:** $20/seat of at-cost (provider-cost, zero-markup) AI usage per period.
- **Soft cap:** `METERED_THRESHOLD = 100` (% of credit). At ≥100%, `classifyUsage` flips
  `OverageStatus` → `"metered"` and enforcement appends *"You are in overage: $X.XX so far
  this period."* (`lib/billing/enforcement.ts`).
- **Spend policy** (`ATLAS_SPEND_POLICY` setting): `continue` (default — keep serving at
  cost, bounded by the abuse ceiling) vs `cutoff` (hard-block at the credit; overage → 429).
- **Abuse ceiling** (`ATLAS_ABUSE_CEILING` setting): percent of credit; default **500**
  (5× credit = $100/seat). 100%→ceiling served at cost; at/above → **429**. `0`/empty =
  pure metering (no cutoff). Floored above 100% so it can never block all overage.
- **Reporter:** `OverageMeter` (`lib/billing/overage-meter.ts`) flushes each paid
  workspace's cumulative period overage (in **cents**) to Stripe Billing Meters as a
  `meter_event` on meter `atlas_usage_overage_cents` (`OVERAGE_METER_EVENT_NAME`). The
  per-tier metered price is `unit_amount = 1` (1¢/unit), so `cents × $0.01 = at-cost $`.
- **Idempotency / reconciliation:** ledger table `overage_meter_reports` holds the
  cumulative `reported_cost_cents` per (org, period); each tick reports only the **delta**
  with a deterministic `meter_event` identifier (`buildOverageEventIdentifier(org, periodStart,
  reportedSoFar)`), so the same delta reported twice bills **once**.
- **Cadence:** the reporter is a periodic fiber, `OVERAGE_REPORT_INTERVAL_MS = 1h`, plus an
  eager boot tick. It needs only `STRIPE_SECRET_KEY` + internal DB (NOT the webhook secret),
  and **excludes BYOT + non-paid tiers (free/trial/locked) + zero-credit** workspaces.

## Preconditions

- [ ] api/app.staging.useatlas.dev up + green (deploy mode `saas`, prod-fidelity).
- [ ] Stripe **test-mode** secret key set on api-staging; per-tier overage price IDs present
      (`STRIPE_STARTER_OVERAGE_PRICE_ID` / `STRIPE_PRO_OVERAGE_PRICE_ID` /
      `STRIPE_BUSINESS_OVERAGE_PRICE_ID` — platform settings, env fallback). Confirm via the
      boot guard (no missing-overage-price warning) or Admin → Platform Settings.
- [ ] A **paid, non-BYOT** test workspace on staging with an active test-mode subscription
      (use the staging throwaway-account flow: business-email gate + OTP clamp; subscribe via
      Stripe test-mode checkout). Pick **starter** (cheapest credit) to cross the cap fastest.
- [ ] Stripe test-mode dashboard / MCP access for the staging account (Meters → `atlas_usage_overage_cents`).

## Phase 1 — accrual past the soft cap

Crossing 100% of a $20/seat at-cost credit takes real token volume. Two levers to make it feasible:
- Temporarily **lower the abuse ceiling** (`ATLAS_ABUSE_CEILING`) so you can also test Phase 3
  in the same run, and/or
- Drive a **scripted query loop** (repeated chat turns; a heavier model burns the credit faster).

1. [ ] Note the workspace's starting period usage (Admin → Usage, or `getCurrentPeriodUsage`).
2. [ ] Drive chat turns until cumulative at-cost spend crosses **100%** of the credit.
3. [ ] **Verify:** usage status flips to `metered`; the in-overage **$X.XX** surface shows on
       the billing/usage page; requests keep serving (spend policy `continue`).

> Ask me to write the query-loop driver if you want it scripted against the staging API.

## Phase 2 — idempotent reporting + reconciliation

1. [ ] Wait for the hourly tick **or** restart api-staging to force the eager boot tick.
2. [ ] **Ledger:** `SELECT org_id, period_start, reported_cost_cents, last_event_identifier
       FROM overage_meter_reports WHERE org_id = '<ws>'` — one row per period, monotonic cents.
3. [ ] **Stripe:** the `atlas_usage_overage_cents` meter shows a cumulative value matching
       `reported_cost_cents` (× $0.01 = the at-cost $).
4. [ ] **Idempotency:** force a second tick with **no new usage** (restart again) → ledger
       unchanged, no new meter event (delta = 0). Then add a little usage → exactly the new
       delta is reported, not the cumulative total twice.

## Phase 3 — abuse ceiling cutoff

1. [ ] Set `ATLAS_ABUSE_CEILING` to a low percent (e.g. `150`) for the test workspace.
2. [ ] Drive usage past that ceiling.
3. [ ] **Verify:** requests are blocked with **429** at/above the ceiling (not before);
       below it they still serve. Restore the ceiling after.
4. [ ] (Optional) Set `ATLAS_SPEND_POLICY = cutoff` and confirm overage hard-blocks at 100%.

## Phase 4 — BYOT never accrues

1. [ ] Flip the workspace to BYOT (its own provider key) and drive usage.
2. [ ] **Verify:** no metered accrual, no `overage_meter_reports` advance, no meter event.

## Phase 5 — record + file

- [ ] Record outcomes (pass/fail per AC) as a comment on #4003 — include the ledger row,
      the Stripe meter value, and the cents↔$ reconciliation.
- [ ] File any defect as a follow-up issue linked to #4003 / #3984 (bug + area: api/deploy).

## Phase 6 — app-driven reporter soak ✅ DONE 2026-06-28 (both Stripe contract + deployed reporter)

**Stripe contract (CLI):** the meter accepts Atlas's exact `meter_event`, dedups on `identifier` (dup rejected), aggregates to exactly the unique cents ($14.00 at 1¢/unit). Atlas sends exactly that shape (`overage-meter.ts:408`).

**Deployed reporter (in-container, PASSED):** ran the real `reportWorkspaceOverage` in api-staging against the real `overage_meter_reports` ledger + sandbox Stripe → `{"r1":"reported","led1":3000,"r2":"skipped","led2":3000}` (AC1 accrual + AC2 ledger idempotency, real runtime). AC3 (abuse-ceiling 429) is the separate enforcement path — unit-tested, not soaked.

Harness `internal/soak-overage-reporter.ts` (gitignored) injects synthetic usage ($50 vs $20 credit → 3000¢) via `deps`, keeps the real ledger fns; writes only ONE throwaway `overage_meter_reports` row. **Must run inside packages/api** in-container (self-reference resolves `@atlas/api/*`; `node_modules/@atlas` doesn't exist). The staging internal DB is private-network-only → in-container only. `railway ssh` needs a registered key (`railway ssh keys github`, or generate + `railway ssh keys add -k ~/.ssh/<key>.pub`; remove after). To re-run:
```bash
CUST=$(stripe customers create --project-name "atlas devhq sandbox" -d name=soak -d email=soak@example.com | jq -r .id)
ORG="soak-4003-$(date +%s)"; PERIOD=$(date -u +%Y-%m-01T00:00:00.000Z)
B64=$(base64 -w0 internal/soak-overage-reporter.ts)
# NOTE: cd /app/packages/api (NOT /tmp) so bun resolves @atlas/api via package self-reference.
railway ssh -i ~/.ssh/<key> -s api-staging -e staging -- "cd /app/packages/api && echo $B64 | base64 -d > soak-tmp.ts && SOAK_CUST=$CUST SOAK_ORG=$ORG SOAK_PERIOD=$PERIOD bun soak-tmp.ts; rm -f soak-tmp.ts"
# expect {"r1":"reported","led1":3000,"r2":"skipped","led2":3000}. Cleanup: delete the
# overage_meter_reports row (in-container bun, same cd) + `stripe delete /v1/customers/$CUST` + remove the SSH key.
```

## Then (separate, human-only)

The **live-mode** Stripe meter/price repoint + the `/release` that cuts `v0.0.33` are
explicitly **not** agent actions (never touch the live Stripe account from an agent). This soak
de-risks that step; it does not perform it. Full live recipe: `v0033-stripe-live-repoint-checklist.md`.
