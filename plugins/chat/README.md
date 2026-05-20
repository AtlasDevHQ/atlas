# @useatlas/chat

Unified chat interaction plugin bridging [Chat SDK](https://github.com/vercel/chat) (vercel/chat) into the Atlas plugin system. Instead of maintaining separate per-platform plugins, this single plugin provides a bridge for Chat SDK adapters. Supports Slack, Teams, Discord, Google Chat, and Telegram; additional platforms will be added as Chat SDK adapters in follow-up issues.

## Install

```bash
bun add @useatlas/chat
```

## Usage

Adapter activation is driven by the **Plugin Catalog** (Atlas 1.5.2,
[#2650](https://github.com/AtlasDevHQ/atlas/issues/2650)) — operators
declare the chat Platforms they support in `atlas.config.ts:catalog`,
and the plugin's `AdapterRegistry` reads per-Platform credentials from
`process.env` at boot. See
[Plugin Catalog docs](https://docs.useatlas.dev/deployment/plugin-catalog)
for the full data model and seed semantics.

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { chatPlugin } from "@useatlas/chat";

export default defineConfig({
  // Operator declares which Platforms this deploy supports.
  catalog: [
    { slug: "slack", type: "chat", install_model: "oauth", enabled: true,
      saas_eligible: true },
    // 1.5.3 placeholders — visible to ops, not customer-installable yet.
    { slug: "telegram", type: "chat", install_model: "static-bot",
      enabled: false, saas_eligible: true },
  ],
  plugins: [
    chatPlugin({
      // The host passes the chat-type subset of the catalog through.
      catalog: [
        { slug: "slack", type: "chat", install_model: "oauth", enabled: true,
          saas_eligible: true },
      ],
      executeQuery: myQueryFunction,
      actions: myActionCallbacks,        // optional — approve/deny flows
      conversations: myConversationCBs,  // optional — host conversation persistence
    }),
  ],
});
```

### Per-Platform credentials (env vars)

In milestone 1.5.2 only Slack OAuth is wired. Required env vars:

| Var | Purpose |
|-----|---------|
| `SLACK_CLIENT_ID` | OAuth client ID from your Slack App Registration |
| `SLACK_CLIENT_SECRET` | OAuth client secret |
| `SLACK_SIGNING_SECRET` | 32-char hex from Slack app's Basic Information page |
| `SLACK_ENCRYPTION_KEY` | AES-256-GCM key (hex64 or base64-44) for at-rest bot-token storage |
| `SLACK_BOT_TOKEN` *(optional)* | Single-workspace mode only — omit for multi-workspace SaaS |

If any required var is missing, the AdapterRegistry logs a warn and
skips Slack. The plugin still boots; `healthCheck()` reports unhealthy
until the env wiring is fixed.

Non-Slack chat Platforms (Teams, Discord, Google Chat, Telegram,
WhatsApp) ship as `enabled: false` catalog placeholders in 1.5.2 and
wire up in 1.5.3 alongside `StaticBotInstallHandler`.

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `catalog` | `ChatCatalogEntry[]?` | — | Chat-type subset of the operator's `atlas.config.ts:catalog`. AdapterRegistry uses this to decide which adapters to instantiate. |
| `state` | `object?` | `{ backend: "memory" }` | State backend configuration (see below) |
| `executeQuery` | `function` | — | Callback to run the Atlas agent on a question |
| `executeQueryStream` | `function?` | — | Streaming variant — when set with `streaming.enabled: true`, responses stream incrementally |
| `checkRateLimit` | `function?` | — | Optional rate limiting callback |
| `scrubError` | `function?` | — | Optional error scrubbing callback |
| `actions` | `ActionCallbacks?` | — | Optional action framework callbacks (`approve`, `deny`, `get`) |
| `conversations` | `ConversationCallbacks?` | — | Optional host conversation persistence callbacks |
| `streaming` | `StreamingConfig?` | `{ enabled: true }` | Streaming response configuration |
| `proactive` | `ProactiveConfig?` | — | Enterprise proactive-listener wiring |
| `reactions` | `ReactionConfig?` | — | Status emoji reactions on user messages |
| `fileUpload` | `FileUploadConfig?` | — | CSV file-upload thresholds |
| `ephemeral` | `EphemeralConfig?` | — | Whether errors post as ephemeral |
| `slashCommandName` | `string?` | `"/atlas"` | Slash command registered with the Chat SDK |

Adapter activation requires (a) a `chat`-type entry in `catalog` with
`install_model: "oauth"` and `enabled: true`, AND (b) all required env
vars for that Platform.

### State Backend

The state backend controls how thread subscriptions, conversation history, and distributed locks are persisted. Three backends are available:

| Backend | Description | Persistence |
|---------|-------------|-------------|
| `memory` | In-memory (default). State lost on restart. | None |
| `pg` | PostgreSQL via Atlas internal DB (`DATABASE_URL`). | Full |
| `redis` | Redis (stub — not yet implemented). | — |

```typescript
chatPlugin({
  catalog: [
    { slug: "slack", type: "chat", install_model: "oauth", enabled: true,
      saas_eligible: true },
  ],
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
| `/webhooks/gchat` | POST | Google Chat webhook (handles @mentions, DMs, card clicks, Pub/Sub) |
| `/webhooks/telegram` | POST | Telegram Bot API webhook (handles messages, @mentions, commands, callback queries) |
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

This is the foundation plugin for the Chat SDK adoption (#757). It replaces `@useatlas/slack` (#759) and `@useatlas/teams` (#760), and supports Discord (#761), Google Chat (#762), and Telegram (#763). Additional platforms will be added as Chat SDK adapters.

## Reference

- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
