# @useatlas/email

Send email reports via the Resend API with domain allowlisting and approval controls.

## Install

```bash
bun add @useatlas/email
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { emailPlugin } from "@useatlas/email";

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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
