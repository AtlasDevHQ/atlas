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

## Endpoint

```
POST /webhook/:channelId
```

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

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
