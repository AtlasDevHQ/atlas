# @useatlas/webhook-action

Outbound webhook action plugin — POSTs a JSON payload to a configured destination with HMAC-SHA256 signing.

## Install

```bash
bun add @useatlas/webhook-action
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { webhookActionPlugin } from "@useatlas/webhook-action";

export default defineConfig({
  plugins: [
    webhookActionPlugin({
      url: "https://hooks.example.com/atlas",
      signing_secret: process.env.WEBHOOK_SIGNING_SECRET!,
      retry_policy: "exponential",
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | Destination URL — must be https |
| `signing_secret` | `string` | — | HMAC-SHA256 signing secret |
| `retry_policy` | `"none" \| "exponential"?` | `exponential` | Retry behavior on 5xx / network failure |
| `approvalMode` | `"auto" \| "manual" \| "admin-only"?` | `admin-only` | Approval mode for sends |

## Receiver-side verification

```ts
import crypto from "crypto";

function verify(signingSecret: string, body: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", signingSecret).update(body).digest("hex");
  // Constant-time compare guards against signature-probe timing attacks.
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

The signature ships in the `X-Atlas-Signature` request header — hex-encoded
HMAC-SHA256 over the raw request body. Rotate the signing secret by
re-installing the integration through `/admin/integrations`.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
