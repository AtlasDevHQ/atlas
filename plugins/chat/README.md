# @useatlas/chat

Unified chat interaction plugin bridging [Chat SDK](https://github.com/vercel/chat) (vercel/chat) into the Atlas plugin system. Instead of maintaining separate per-platform plugins, this single plugin provides a bridge for Chat SDK adapters. Replaces `@useatlas/slack` for Slack support; additional platforms (Teams, Discord, etc.) will be added in follow-up issues.

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
          clientId: process.env.SLACK_CLIENT_ID,       // optional, for OAuth
          clientSecret: process.env.SLACK_CLIENT_SECRET, // optional, for OAuth
        },
      },
      executeQuery: myQueryFunction,
      actions: myActionCallbacks,        // optional — approve/deny flows
      conversations: myConversationCBs,  // optional — host conversation persistence
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `adapters.slack.botToken` | `string` | — | Slack bot token (`xoxb-...`) |
| `adapters.slack.signingSecret` | `string` | — | Slack signing secret for request verification |
| `adapters.slack.clientId` | `string?` | — | Client ID for multi-workspace OAuth |
| `adapters.slack.clientSecret` | `string?` | — | Client secret for multi-workspace OAuth |
| `state` | `object?` | `{ backend: "memory" }` | State backend configuration (see below) |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |
| `checkRateLimit` | `function?` | — | Optional rate limiting callback |
| `scrubError` | `function?` | — | Optional error scrubbing callback |
| `actions` | `ActionCallbacks?` | — | Optional action framework callbacks (`approve`, `deny`, `get`) |
| `conversations` | `ConversationCallbacks?` | — | Optional host conversation persistence callbacks |

At least one adapter must be configured.

### State Backend

The state backend controls how thread subscriptions, conversation history, and distributed locks are persisted. Three backends are available:

| Backend | Description | Persistence |
|---------|-------------|-------------|
| `memory` | In-memory (default). State lost on restart. | None |
| `pg` | PostgreSQL via Atlas internal DB (`DATABASE_URL`). | Full |
| `redis` | Redis (stub — not yet implemented). | — |

```typescript
chatPlugin({
  adapters: { slack: { ... } },
  state: {
    backend: "pg",        // "memory" | "pg" | "redis"
    tablePrefix: "chat_", // PG table prefix (default: "chat_")
  },
  executeQuery: myQueryFunction,
})
```

The PG backend creates three tables (`chat_subscriptions`, `chat_locks`, `chat_cache`) on first connection using `CREATE TABLE IF NOT EXISTS`. These use the `chat_` prefix by default to avoid conflicts with existing Atlas tables.

## How It Works

The plugin bridges Chat SDK events to Atlas:

1. **`onSlashCommand("/atlas")`** — User types `/atlas <question>` → posts "Thinking..." → subscribes thread → runs `executeQuery` → edits response with results → optionally posts ephemeral approval buttons
2. **`onNewMention`** — User @-mentions the bot → subscribes to thread → runs `executeQuery` → posts result as markdown → optionally posts approval buttons
3. **`onSubscribedMessage`** — Follow-up messages in subscribed threads → runs `executeQuery` with conversation history → posts result
4. **`onAction`** — Approval buttons clicked → calls `actions.approve()` or `actions.deny()` → edits original message with result status

### Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/webhooks/slack` | POST | Chat SDK webhook (handles slash commands, events, and interactions) |
| `/oauth/slack/install` | GET | OAuth install redirect (only when `clientId` configured) |
| `/oauth/slack/callback` | GET | OAuth callback (only when `clientId` configured) |

## Migrating from @useatlas/slack

See the [`@useatlas/slack` README](../slack/README.md) for a migration guide with a comparison table.

## Error Scrubbing

All error messages are scrubbed before sending to chat platforms. Built-in patterns redact:
- Connection strings (postgres://, mysql://, etc.)
- Stack traces and file paths
- API keys and tokens (Slack, GitHub, Bearer)

Provide a custom `scrubError` callback for additional scrubbing.

## Architecture

This is the foundation plugin for the Chat SDK adoption (#757). It replaces `@useatlas/slack` (#759) and will support additional platforms:
- Teams (#760), Discord (#761), Google Chat (#762), Telegram (#763), and more

## Reference

- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
