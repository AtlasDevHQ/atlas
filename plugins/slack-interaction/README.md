# @atlas/plugin-slack-interaction

Slack interaction plugin with slash commands, threaded conversations, Block Kit formatting, and OAuth multi-workspace support.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "hono": "^4.12.3", "zod": "^4.3.6" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { slackPlugin } from "@atlas/plugin-slack-interaction";

export default defineConfig({
  plugins: [
    slackPlugin({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      botToken: process.env.SLACK_BOT_TOKEN,
      executeQuery: myQueryFunction,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `signingSecret` | `string` | — | Slack signing secret for request verification |
| `botToken` | `string?` | — | Bot token for single-workspace mode |
| `clientId` | `string?` | — | Client ID for multi-workspace OAuth |
| `clientSecret` | `string?` | — | Client secret for multi-workspace OAuth |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |
| `checkRateLimit` | `function?` | — | Optional rate limiting callback |
| `conversations` | `object?` | — | Optional conversation persistence callbacks |
| `actions` | `object?` | — | Optional action framework callbacks |

Either `botToken` or `clientId` + `clientSecret` is required.

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
