# @useatlas/twenty

Atlas action plugin for [Twenty CRM](https://twenty.com). Ships two agent-callable actions:

- `upsertTwentyPerson` — upsert a Person by email with sticky first/last source attribution.
- `stampStripeCustomerId` — stamp `atlasStripeCustomerId` on a Person matching email (CONVERSION source). Use from a Stripe webhook handler.

## Required Twenty setup

Before deploy, three **required** custom fields must be created on the `Person` object in Twenty. **All three are hard requirements** — if any is missing at boot, the Atlas SaaS wiring (`/ee/src/saas-crm/`) flips `SaasCrm.available` to `false` and every downstream demo / signup / conversion dispatch becomes a no-op (no dead outbox rows). The startup verification logs the exact missing-field list and create-instructions.

| Field name              | Type    | Required? | Purpose                                                                                               |
| ----------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `atlasFirstSource`      | Text    | **Yes**   | Sticky first-touch attribution — set once on a Person, never overwritten thereafter (e.g. `DEMO`).    |
| `atlasLastSource`       | Text    | **Yes**   | Most recent touch — overwritten on every dispatch (e.g. `DEMO`, `SIGNUP`, `SALES_FORM`, `CONVERSION`). |
| `atlasStripeCustomerId` | Text    | **Yes**   | Stripe `customer.id` of a paying customer. Stamped by `stampStripeCustomerId` on conversion.          |
| `atlasIp`               | Text    | No        | Client IP on demo gate submissions. Optional — absence is non-fatal (the field is written if present, silently skipped otherwise). |

Create the required fields under **Settings → Data Model → Person → + Add Field** in the Twenty UI. Verification runs once at boot via the Twenty metadata GraphQL endpoint (`/metadata`).

## Install (self-hoster)

Self-hosted operators have **two ways** to configure per-workspace Twenty credentials. Both are workspace-scoped — credentials live in `twenty_integrations` (or in your `atlas.config.ts` plugin block). The `TWENTY_API_KEY` environment variable is **NOT** consulted by any plugin install (see "What about `TWENTY_API_KEY`?" below).

### Option 1: Admin UI (recommended)

Navigate to **Admin → Integrations → Twenty** in your Atlas deployment and submit:

- **Base URL** — your Twenty instance hostname (e.g. `https://crm.example.com`). **Required, no default** — the form will NOT auto-fill `https://crm.useatlas.dev` (that's Atlas's own Twenty).
- **API key** — bearer token from Twenty → Settings → API & Webhooks.

The key is encrypted at rest in the `twenty_integrations` table (AES-256-GCM via Atlas's F-41 selective-field encryption). Deleting the row makes subsequent plugin actions fail with an actionable `TwentyCredentialError` until the row is restored — there is no env fallback.

### Option 2: `atlas.config.ts`

```bash
bun add @useatlas/twenty
```

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { twentyPlugin } from "@useatlas/twenty";

export default defineConfig({
  plugins: [
    twentyPlugin({
      // Operator-supplied secret threaded into the plugin config. Name
      // the env var after the workspace so multi-workspace deployments
      // stay readable. Atlas does NOT read TWENTY_API_KEY here — that
      // var is platform-only (see below).
      apiKey: process.env.MY_TWENTY_API_KEY!,
      baseUrl: "https://crm.example.com", // required — point at your own Twenty
    }),
  ],
});
```

The plugin exposes two agent tools:

- `upsertTwentyPerson` — takes `{ email, eventSource, firstName?, lastName?, atlasIp? }` and upserts the Person by `emails.primaryEmail`. The first/last source rule is enforced inside `TwentyClient.upsertPerson` — callers pass a single `eventSource`.
- `stampStripeCustomerId` — takes `{ email, stripeCustomerId }` and stamps `atlasStripeCustomerId` on the matching Person (creates a new Person with `atlasFirstSource = "CONVERSION"` if none exists). Self-hosters with their own Stripe + Twenty wiring can call this from their own webhook handler.

## What about `TWENTY_API_KEY`?

`TWENTY_API_KEY` (and optional `TWENTY_BASE_URL`) are **platform-only**: they configure Atlas's own SaaS lead-capture pipeline (`ee/src/saas-crm/`), which POSTs demo / sales-form / signup events into Atlas's CRM at `crm.useatlas.dev`.

No plugin install — customer workspace, or Atlas's own team workspace on `app.useatlas.dev` — reads from these env vars, even as a fallback. This split (#2850) prevents two leak scenarios structurally:

- A customer install with a missing apiKey cannot silently route writes through Atlas's operator key.
- A future change in `ee/src/saas-crm/` cannot accidentally read a customer workspace's `twenty_integrations` row.

The `scripts/check-twenty-resolver-imports.sh` CI gate enforces that only `ee/src/saas-crm/` may import `resolveOperatorCredentials` from this package.

## Atlas SaaS wiring

Atlas SaaS (`app.useatlas.dev`) does NOT register this plugin via `atlas.config.ts`. Instead, `/ee/src/saas-crm/` consumes `TwentyClient` directly through the `SaasCrm` Effect Tag with operator credentials resolved from `TWENTY_API_KEY` env. Self-hosters that want their workspaces to fire `upsertTwentyPerson` / `stampStripeCustomerId` from their own webhook handlers wire the actions themselves via this plugin's action API.

Atlas's own team workspace on `app.useatlas.dev`, when it needs Twenty as an action layer, installs the plugin via Admin → Integrations → Twenty just like any other workspace.

The SaaS-side conversion stamping (`SaasCrm.stampConversion`) fires only on **actual payment**, not at trial start. All paid plans ship with a 14-day `freeTrial`, so `onSubscriptionComplete` fires with `subscription.status === "trialing"` at checkout completion — stamping then would overcount unpaid trials as paid conversions in funnel queries. The two real "paid" signals, both wired in `packages/api/src/lib/auth/server.ts`:

1. **`onSubscriptionComplete`** — when `subscription.status === "active"` (a paid plan without a trial, or a trial that completed instantly).
2. **`onSubscriptionUpdate`** — when the underlying Stripe event is `customer.subscription.updated` and `previous_attributes.status === "trialing"` with current `status === "active"` (i.e. the customer just paid their first post-trial invoice).

Each path retrieves the Stripe customer's email and enqueues a `stamp-conversion` row into `crm_outbox` for durable dispatch by the scheduler-backed flusher.

## Config

| Field       | Type       | Default | Description                                                |
| ----------- | ---------- | ------- | ---------------------------------------------------------- |
| `apiKey`    | `string`   | —       | Bearer key from Twenty Settings → API & Webhooks (secret). |
| `baseUrl`   | `string`   | —       | Required Twenty REST base URL (e.g. `https://crm.example.com`). |
| `timeoutMs` | `number?`  | `10000` | Per-request timeout.                                       |

`apiKey` is marked `secret: true` for F-41 selective-field encryption when configured via the admin UI.

## API endpoints used

| Operation            | Method | URL                                                              |
| -------------------- | ------ | ---------------------------------------------------------------- |
| Find Person by email | GET    | `/rest/people?filter[emails.primaryEmail][eq]=<email>&limit=1`  |
| Create Person        | POST   | `/rest/people`                                                  |
| Update Person        | PATCH  | `/rest/people/<id>`                                             |
| Metadata probe       | POST   | `/metadata` (GraphQL — REST has no per-object fields endpoint)  |

Custom fields live INLINE on the Person record on both read and write — not under a `customFields` wrapper. Verified against Twenty's REST docs (companies PATCH writes `annualRecurringRevenue` as a top-level field).

## Testing rules — IMPORTANT

**Do NOT run integration tests against `crm.useatlas.dev` from CI.** The Atlas company Twenty instance carries real prospect data — accidental writes during a test loop would pollute the lead funnel. All `__tests__/` here use mocked fetch responses. The repo's `bun run test:others` target invokes only the fixture-based suites; there is no live-integration target by design.

Manual smoke-tests against the SaaS Twenty instance happen before each release of the SaaS-side wiring (`/ee/src/saas-crm/`) — not automated.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Twenty REST API](https://twenty.com/developers/section/rest-api)
- [Twenty metadata API](https://twenty.com/developers/section/api-and-webhooks/metadata-api)
