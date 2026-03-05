# @atlas/plugin-email-action

Send email reports via the Resend API with domain allowlisting and approval controls.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "ai": "^6.0.97", "zod": "^4.3.6" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { emailPlugin } from "@atlas/plugin-email-action";

export default defineConfig({
  plugins: [
    emailPlugin({
      resendApiKey: process.env.RESEND_API_KEY!,
      allowedDomains: ["myco.com"],
      fromAddress: "Atlas <atlas@myco.com>",
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resendApiKey` | `string` | — | Resend API key |
| `allowedDomains` | `string[]?` | — | Only these recipient domains are permitted |
| `fromAddress` | `string?` | `Atlas <atlas@notifications.useatlas.dev>` | Sender address |
| `approvalMode` | `"auto" \| "manual" \| "admin-only"` | `admin-only` | Approval mode for email sends |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
