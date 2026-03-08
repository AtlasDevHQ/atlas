# @atlas/plugin-salesforce-datasource

Salesforce datasource plugin for Atlas. Wraps Salesforce SOQL access via [jsforce](https://jsforce.github.io/), providing read-only querying of Salesforce objects through a dedicated `querySalesforce` tool.

Unlike SQL-based datasource plugins, this plugin uses SOQL (Salesforce Object Query Language) and includes its own validation pipeline.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "jsforce": "^3.10.14" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { salesforcePlugin } from "@atlas/plugin-salesforce-datasource";

export default defineConfig({
  plugins: [
    salesforcePlugin({
      url: "salesforce://user:pass@login.salesforce.com?token=SECURITY_TOKEN",
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | Salesforce connection URL (must start with `salesforce://`) |

### URL format

```
salesforce://username:password@login.salesforce.com?token=SECURITY_TOKEN&clientId=ID&clientSecret=SECRET
```

| Component | Description |
|-----------|-------------|
| `username` | Salesforce username |
| `password` | Salesforce password |
| `hostname` | Login URL (required; use `login.salesforce.com` for production, `test.salesforce.com` for sandboxes) |
| `token` | Security token (query param, optional) |
| `clientId` | Connected App client ID (query param, optional) |
| `clientSecret` | Connected App client secret (query param, optional) |

## Environment variables

Set credentials via environment variables and reference them in your config:

```typescript
salesforcePlugin({
  url: process.env.SALESFORCE_URL!,
})
```

## SOQL notes

- SOQL is **not SQL** — it queries Salesforce objects, not database tables
- No `JOIN` — use relationship queries (e.g. `SELECT Account.Name FROM Contact`)
- No `SELECT *` — always list specific fields
- Date literals: `TODAY`, `LAST_WEEK`, `LAST_N_DAYS:30`, etc.
- The plugin registers a `querySalesforce` tool (use it instead of `executeSQL`)

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
