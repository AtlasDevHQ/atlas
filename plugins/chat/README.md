# @useatlas/chat

Unified chat interaction plugin bridging [Chat SDK](https://github.com/vercel/chat) (vercel/chat) into the Atlas plugin system. Instead of maintaining separate per-platform plugins, this single plugin handles Slack, Teams, Discord, and more through Chat SDK adapters.

## Install

```bash
bun add @useatlas/chat
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { chatPlugin } from "@useatlas/chat";

export default defineConfig({
  plugins: [
    chatPlugin({
      adapters: {
        slack: {
          botToken: process.env.SLACK_BOT_TOKEN!,
          signingSecret: process.env.SLACK_SIGNING_SECRET!,
        },
      },
      executeQuery: myQueryFunction,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `adapters.slack` | `object?` | — | Slack adapter credentials (`botToken`, `signingSecret`) |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |
| `checkRateLimit` | `function?` | — | Optional rate limiting callback |
| `scrubError` | `function?` | — | Optional error scrubbing callback |

At least one adapter must be configured.

## How It Works

The plugin bridges Chat SDK events to Atlas:

1. **`onNewMention`** — User @-mentions the bot → subscribes to thread → runs `executeQuery` → posts result as markdown
2. **`onSubscribedMessage`** — Follow-up messages in subscribed threads → runs `executeQuery` with conversation history → posts result

Webhook routes are mounted at `/webhooks/slack` (under the plugin route prefix). The Chat SDK handles platform-specific details: signature verification, event parsing, and message formatting.

## Error Scrubbing

All error messages are scrubbed before sending to chat platforms. Built-in patterns redact:
- Connection strings (postgres://, mysql://, etc.)
- Stack traces and file paths
- API keys and tokens (Slack, GitHub, Bearer)

Provide a custom `scrubError` callback for additional scrubbing.

## Architecture

This is the foundation plugin for the Chat SDK adoption (#757). Downstream issues add:
- State adapter integration with Atlas internal DB (#772)
- Platform migrations: Slack (#759), Teams (#760)
- New platforms: Discord (#761), Google Chat (#762), Telegram (#763), and more

## Reference

- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
