# @useatlas/webhook

Webhook interaction plugin for Atlas — accept inbound HTTP requests with a query, run the Atlas agent, and return structured results. Designed for Zapier, Make, and n8n integrations.

## Install

```bash
bun add @useatlas/webhook
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { webhookPlugin } from "@useatlas/webhook";

export default defineConfig({
  plugins: [
    webhookPlugin({
      channels: [
        {
          channelId: "zapier-prod",
          authType: "api-key",
          secret: process.env.WEBHOOK_SECRET!,
          responseFormat: "json",
          rateLimitRpm: 60,
          concurrencyLimit: 3,
        },
      ],
      executeQuery: myQueryFunction,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `channels` | `WebhookChannel[]` | — | Array of webhook channel configurations |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |

### Channel Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `channelId` | `string` | — | Unique identifier for this webhook channel |
| `authType` | `"api-key" \| "hmac"` | — | Authentication method |
| `secret` | `string` | — | API key or HMAC secret |
| `responseFormat` | `"json" \| "text"` | `"json"` | Response format |
| `callbackUrl` | `string?` | — | Optional async callback URL |
| `rateLimitRpm` | `number?` | `60` | Per-channel requests-per-minute cap. Excess returns `429` |
| `concurrencyLimit` | `number?` | `3` | Per-channel concurrent in-flight cap. Excess returns `429` |
| `requireTimestamp` | `boolean?` | `false` | api-key channels: require `X-Webhook-Timestamp` and enforce a 5-minute window |

## Endpoint

```
POST /webhook/:channelId
```

### Request headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-Webhook-Secret` | api-key channels | Channel secret |
| `X-Webhook-Signature` | hmac channels | Hex-encoded HMAC-SHA256 of `${timestamp}:${body}` using the channel secret |
| `X-Webhook-Timestamp` | hmac channels (and api-key channels with `requireTimestamp`) | Unix seconds; rejected outside ±300s of server time |

### HMAC signing

The signing input is `${timestamp}:${body}` (NOT just the body). The plugin
rejects requests outside a 5-minute window, and blocks in-window replays of
the same `(channelId, signature)` pair. This is the same shape Slack uses
for its inbound webhooks.

```bash
TS=$(date +%s)
BODY='{"query":"How many active users last month?"}'
SIG=$(printf "%s:%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST https://atlas.example.com/api/plugins/webhook-interaction/webhook/zapier \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIG" \
  -H "X-Webhook-Timestamp: $TS" \
  -d "$BODY"
```

### Legacy soft-fail

`@useatlas/webhook` v0.0.7 changed the HMAC wire format to include a
timestamp. Operators who can't update upstream senders immediately can set
`ATLAS_WEBHOOK_REPLAY_LEGACY=true` for a brief soak window. In legacy mode:

- Missing `X-Webhook-Timestamp` is allowed; HMAC is verified against the
  body alone (the pre-v0.0.7 contract).
- A warning log is emitted on every legacy-mode acceptance so the absence
  is observable.
- A timestamp that IS provided is still validated — only the missing case
  soft-fails. A stale or future-dated timestamp still 401s.
- Replay-cache protection only applies to requests that include a timestamp
  (legacy upstream senders aren't covered).

Plan to flip the env var off within one week of upgrading. Default is
fail-closed (strict mode).

### Request

```json
{
  "query": "How many active users last month?",
  "context": { "source": "zapier" },
  "callbackUrl": "https://example.com/callback"
}
```

### Response (sync)

```json
{
  "success": true,
  "result": {
    "answer": "42 active users",
    "sql": ["SELECT COUNT(*) FROM users WHERE active = true"],
    "columns": ["count"],
    "rows": [{ "count": 42 }]
  }
}
```

### Response (async — when callbackUrl is set)

```json
{ "accepted": true, "requestId": "uuid" }
```

### Error responses

| Status | Meaning |
|--------|---------|
| `400` | Missing/empty `query`, invalid JSON, or invalid `callbackUrl` |
| `401` | Auth/signature/timestamp/replay-cache rejection |
| `404` | Unknown `channelId` |
| `429` | Per-channel rate limit or concurrency cap hit; `Retry-After` header set |
| `500` | Agent query execution failed |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
