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

```bash
bun add @useatlas/twenty
```

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { twentyPlugin } from "@useatlas/twenty";

export default defineConfig({
  plugins: [
    twentyPlugin({
      apiKey: process.env.TWENTY_API_KEY!,
      baseUrl: "https://crm.example.com", // required — point at your own Twenty
    }),
  ],
});
```

The plugin exposes two agent tools:

- `upsertTwentyPerson` — takes `{ email, eventSource, firstName?, lastName?, atlasIp? }` and upserts the Person by `emails.primaryEmail`. The first/last source rule is enforced inside `TwentyClient.upsertPerson` — callers pass a single `eventSource`.
- `stampStripeCustomerId` — takes `{ email, stripeCustomerId }` and stamps `atlasStripeCustomerId` on the matching Person (creates a new Person with `atlasFirstSource = "CONVERSION"` if none exists). Self-hosters with their own Stripe + Twenty wiring can call this from their own webhook handler.

## Atlas SaaS wiring

Atlas SaaS (`app.useatlas.dev`) does NOT register this plugin via `atlas.config.ts`. Instead, `/ee/src/saas-crm/` consumes `TwentyClient` directly through the `SaasCrm` Effect Tag. Self-hosters that want demo / signup / conversion dispatch into Twenty wire the actions themselves via this plugin's action API.

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
