# @useatlas/teams

Microsoft Teams interaction plugin with Bot Framework messaging, @mention handling, and Adaptive Card responses.

## Install

```bash
bun add @useatlas/teams jose
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { teamsPlugin } from "@useatlas/teams";

export default defineConfig({
  plugins: [
    teamsPlugin({
      appId: process.env.TEAMS_APP_ID!,
      appPassword: process.env.TEAMS_APP_PASSWORD!,
      executeQuery: myQueryFunction,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `appId` | `string` | — | Microsoft App ID from Azure Bot registration |
| `appPassword` | `string` | — | Microsoft App Password from Azure Bot registration |
| `tenantId` | `string?` | — | Optional: restrict to a specific Azure AD tenant |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |
| `checkRateLimit` | `function?` | — | Optional rate limiting callback |
| `scrubError` | `function?` | — | Optional error scrubbing callback |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Teams setup guide](https://docs.useatlas.dev/plugins/interactions/teams)
