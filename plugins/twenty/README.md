# @useatlas/twenty

Atlas action plugin for [Twenty CRM](https://twenty.com). Ships two agent-callable actions:

- `upsertTwentyPerson` — upsert a Person by email with sticky first/last source attribution.
- `stampStripeCustomerId` — stamp `atlasStripeCustomerId` on a Person matching email (CONVERSION source). Use from a Stripe webhook handler.

## Required Twenty setup

Before deploy, three **custom fields** must be created on the `Person` object in Twenty:

| Field name              | Type    | Purpose                                                                                               |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `atlasFirstSource`      | Text    | Sticky first-touch attribution — set once on a Person, never overwritten thereafter (e.g. `DEMO`).    |
| `atlasLastSource`       | Text    | Most recent touch — overwritten on every dispatch (e.g. `DEMO`, `SIGNUP`, `SALES_FORM`, `CONVERSION`). |
| `atlasStripeCustomerId` | Text    | Stripe `customer.id` of a paying customer. Stamped by `stampStripeCustomerId` on conversion.          |

Create all three under **Settings → Data Model → Person → + Add Field** in the Twenty UI. The Atlas SaaS wiring (`/ee/src/saas-crm/`) runs a startup verification via the Twenty metadata GraphQL endpoint (`/metadata`) — if any field is missing, the layer logs an error with the exact create-instructions and disables itself; subsequent demo signups AND conversion stamps are no-ops (no dead outbox rows).

An optional fourth field `atlasIp` (Text) captures the client IP on demo gate submissions; absence is non-fatal.

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

The SaaS-side conversion stamping (`SaasCrm.stampConversion`) is invoked from the Stripe `onSubscriptionComplete` Better Auth hook in `packages/api/src/lib/auth/server.ts`. The hook retrieves the Stripe customer's email and enqueues a `stamp-conversion` row into `crm_outbox` for durable dispatch by the scheduler-backed flusher.

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
