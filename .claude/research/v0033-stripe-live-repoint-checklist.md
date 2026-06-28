# v0.0.33 — Stripe LIVE repoint checklist (human-only, at `/release`)

> The Structure B billing change ($39/$69/$149 + $20/seat at-cost credit + metered overage)
> is wired in **code + display + the sandbox**, but the **LIVE** Stripe account
> (`acct_1TJEQPEj5EeYolRp`) still has only the OLD **$29/$59/$99** base ladder and **no**
> metered overage prices. This is the owed repoint. **Execute by a human, never from an agent**
> (CLAUDE.md standing rule + [[reference_stripe_mcp_sandbox_access]]). Mirrors exactly what was
> done in the sandbox on 2026-06-28 (see `v0033-overage-soak-runbook-4003.md`).
>
> ⚠️ The MCP/CLI default profile is the LIVE account. For these LIVE writes that's intended —
> but **verify each command** targets `acct_1TJEQPEj5EeYolRp` and use the CLI with the live
> profile deliberately. Creating Price/Meter objects costs nothing; money moves only when a
> real customer subscribes/uses.

## Live tier products (already exist)
- Starter `prod_UI0jCnNdaxKDWP` · Pro `prod_UI0jqfd3YEWBNe` · Business `prod_UI0j9BPIg6eeyg`

## Step 1 — Create the 6 Structure B base prices (live)
`annual = monthly × 10` (~17% off; www FAQ + pricing page depend on this ratio).

```bash
# Starter $39/mo, $390/yr
stripe prices create --currency usd --unit-amount 3900   -d "product=prod_UI0jCnNdaxKDWP" -d "recurring[interval]=month" -d "lookup_key=starter_monthly"  -d "transfer_lookup_key=true" -d "metadata[plan_tier]=starter" -d "metadata[structure]=B"
stripe prices create --currency usd --unit-amount 39000  -d "product=prod_UI0jCnNdaxKDWP" -d "recurring[interval]=year"  -d "lookup_key=starter_annual"   -d "transfer_lookup_key=true" -d "metadata[plan_tier]=starter" -d "metadata[structure]=B"
# Pro $69/mo, $690/yr
stripe prices create --currency usd --unit-amount 6900   -d "product=prod_UI0jqfd3YEWBNe" -d "recurring[interval]=month" -d "lookup_key=pro_monthly"      -d "transfer_lookup_key=true" -d "metadata[plan_tier]=pro" -d "metadata[structure]=B"
stripe prices create --currency usd --unit-amount 69000  -d "product=prod_UI0jqfd3YEWBNe" -d "recurring[interval]=year"  -d "lookup_key=pro_annual"       -d "transfer_lookup_key=true" -d "metadata[plan_tier]=pro" -d "metadata[structure]=B"
# Business $149/mo, $1490/yr
stripe prices create --currency usd --unit-amount 14900  -d "product=prod_UI0j9BPIg6eeyg" -d "recurring[interval]=month" -d "lookup_key=business_monthly" -d "transfer_lookup_key=true" -d "metadata[plan_tier]=business" -d "metadata[structure]=B"
stripe prices create --currency usd --unit-amount 149000 -d "product=prod_UI0j9BPIg6eeyg" -d "recurring[interval]=year"  -d "lookup_key=business_annual"  -d "transfer_lookup_key=true" -d "metadata[plan_tier]=business" -d "metadata[structure]=B"
```
Capture the 6 returned `price_…` IDs.

## Step 2 — Create the live at-cost overage meter (CLI only — MCP can't do Billing Meters)
```bash
stripe post /v1/billing/meters \
  -d "display_name=Atlas at-cost usage overage (cents)" \
  -d "event_name=atlas_usage_overage_cents" \
  -d "default_aggregation[formula]=sum" \
  -d "customer_mapping[type]=by_id" \
  -d "customer_mapping[event_payload_key]=stripe_customer_id" \
  -d "value_settings[event_payload_key]=value"
```
Capture the `mtr_…` id.

## Step 3 — Create the 3 metered overage prices (live, 1¢/unit, referencing the meter)
```bash
M=<mtr_id_from_step_2>
stripe prices create --currency usd --unit-amount 1 -d "product=prod_UI0jCnNdaxKDWP" -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=$M" -d "lookup_key=starter_overage_cents"  -d "transfer_lookup_key=true"
stripe prices create --currency usd --unit-amount 1 -d "product=prod_UI0jqfd3YEWBNe" -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=$M" -d "lookup_key=pro_overage_cents"      -d "transfer_lookup_key=true"
stripe prices create --currency usd --unit-amount 1 -d "product=prod_UI0j9BPIg6eeyg" -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=$M" -d "lookup_key=business_overage_cents" -d "transfer_lookup_key=true"
```
Capture the 3 `price_…` IDs.

## Step 4 — Repoint prod env (ALL 3 regional API services)
Residency means three live API services each carry their own env: **`api`, `api-eu`, `api-apac`** (Railway project `satisfied-creation`, env `production`). Set all 9 vars on **each**:

```bash
for SVC in api api-eu api-apac; do
  railway variables --service "$SVC" --environment production \
    --set "STRIPE_STARTER_PRICE_ID=<starter_mo>"   --set "STRIPE_STARTER_ANNUAL_PRICE_ID=<starter_yr>" \
    --set "STRIPE_PRO_PRICE_ID=<pro_mo>"           --set "STRIPE_PRO_ANNUAL_PRICE_ID=<pro_yr>" \
    --set "STRIPE_BUSINESS_PRICE_ID=<business_mo>" --set "STRIPE_BUSINESS_ANNUAL_PRICE_ID=<business_yr>" \
    --set "STRIPE_STARTER_OVERAGE_PRICE_ID=<starter_ov>" --set "STRIPE_PRO_OVERAGE_PRICE_ID=<pro_ov>" --set "STRIPE_BUSINESS_OVERAGE_PRICE_ID=<business_ov>"
done
```
(Alternatively set them as platform settings via Admin → these are `getSettingAuto` keys, settings-over-env.) These are the SSOT keys `MONTHLY_PRICE_ID_ENV_VARS` + `OVERAGE_PRICE_ID_ENV_VAR_BY_TIER` (`config-validation.ts`); the boot guard `BillingConfigGuardLive` warns if any monthly/overage key is unset.

## Step 5 — Verify
- `getStripePlans()` resolves all three tiers at $39/$69/$149 (no tier silently omitted).
- A test checkout in each region charges the new base price + carries the metered overage item.
- Existing subscriptions stay on their old price (Stripe never migrates them) — acceptable; only new subs get Structure B.

## Notes
- Do this as part of `/release` for `v0.0.33`, after the tag's API is the deployed prod build (so `resolvePlanTierFromPriceId` recognizes both old + new IDs during the overlap).
- The old $29/$59/$99 prices stay active (existing subs) but lose their canonical lookup keys to the transfer; that's fine.
