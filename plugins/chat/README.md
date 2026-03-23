# @useatlas/chat

Unified chat interaction plugin bridging [Chat SDK](https://github.com/vercel/chat) (vercel/chat) into the Atlas plugin system. Instead of maintaining separate per-platform plugins, this single plugin provides a bridge for Chat SDK adapters. Supports Slack, Teams, and Discord; additional platforms (Google Chat, Telegram, etc.) will be added in follow-up issues.

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
        teams: {
          appId: process.env.TEAMS_APP_ID!,
          appPassword: process.env.TEAMS_APP_PASSWORD!,
          tenantId: process.env.TEAMS_TENANT_ID,       // optional, for tenant restriction
        },
        discord: {
          botToken: process.env.DISCORD_BOT_TOKEN!,
          applicationId: process.env.DISCORD_APPLICATION_ID!,
          publicKey: process.env.DISCORD_PUBLIC_KEY!,
          mentionRoleIds: [],                          // optional, role IDs that trigger mentions
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
| `adapters.teams.appId` | `string` | — | Microsoft App ID from Azure Bot registration |
| `adapters.teams.appPassword` | `string` | — | Microsoft App Password from Azure Bot registration |
| `adapters.teams.tenantId` | `string?` | — | Optional: restrict to a specific Microsoft Entra ID tenant |
| `adapters.discord.botToken` | `string` | — | Discord bot token |
| `adapters.discord.applicationId` | `string` | — | Discord application ID |
| `adapters.discord.publicKey` | `string` | — | Application public key for Ed25519 webhook signature verification |
| `adapters.discord.mentionRoleIds` | `string[]?` | — | Optional: role IDs that trigger mention handlers |
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
| `/webhooks/slack` | POST | Slack Chat SDK webhook (handles slash commands, events, and interactions) |
| `/webhooks/teams` | POST | Teams Chat SDK webhook (handles Bot Framework activities) |
| `/webhooks/discord` | POST | Discord Interactions endpoint (handles slash commands, mentions, and buttons) |
| `/oauth/slack/install` | GET | Slack OAuth install redirect (only when `clientId` configured) |
| `/oauth/slack/callback` | GET | Slack OAuth callback (only when `clientId` configured) |

## Migrating from @useatlas/slack or @useatlas/teams

See the [`@useatlas/slack` README](../slack/README.md) or [`@useatlas/teams` README](../teams/README.md) for migration guides with comparison tables.

## Error Scrubbing

All error messages are scrubbed before sending to chat platforms. Built-in patterns redact:
- Connection strings (postgres://, mysql://, etc.)
- Stack traces and file paths
- API keys and tokens (Slack, GitHub, Bearer)

Provide a custom `scrubError` callback for additional scrubbing.

## Architecture

This is the foundation plugin for the Chat SDK adoption (#757). It replaces `@useatlas/slack` (#759) and `@useatlas/teams` (#760), and supports Discord (#761). Additional platforms:
- Google Chat (#762), Telegram (#763), and more

## Reference

- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
