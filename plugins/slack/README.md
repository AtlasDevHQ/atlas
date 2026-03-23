# @useatlas/slack

> **Deprecated**: Use [`@useatlas/chat`](../chat/) with the Slack adapter instead.
> The Chat SDK bridge plugin provides the same Slack functionality plus
> multi-platform support (Teams, Discord, etc.) and built-in state management.

Slack interaction plugin with slash commands, threaded conversations, Block Kit formatting, and OAuth multi-workspace support.

## Migration to @useatlas/chat

```typescript
// Before (@useatlas/slack):
import { slackPlugin } from "@useatlas/slack";

slackPlugin({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  botToken: process.env.SLACK_BOT_TOKEN,
  executeQuery: myQueryFunction,
})

// After (@useatlas/chat):
import { chatPlugin } from "@useatlas/chat";

chatPlugin({
  adapters: {
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      clientId: process.env.SLACK_CLIENT_ID,       // optional
      clientSecret: process.env.SLACK_CLIENT_SECRET, // optional
    },
  },
  executeQuery: myQueryFunction,
  actions: myActionCallbacks,        // optional
  conversations: myConversations,    // optional
})
```

### Key changes

| Feature | @useatlas/slack | @useatlas/chat |
|---------|----------------|----------------|
| Webhook | `/commands`, `/events`, `/interactions` | `/webhooks/slack` (single endpoint) |
| OAuth | `/install`, `/callback` | `/oauth/slack/install`, `/oauth/slack/callback` |
| Block Kit | Hand-rolled builders | Automatic via Chat SDK adapter |
| State | Custom DB tables | Chat SDK state adapter (memory/PG/Redis) |
| Follow-ups | Manual thread mapping | Chat SDK subscription model |
| Multi-platform | Slack only | Slack, Teams, Discord, etc. |

## Legacy Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { slackPlugin } from "@useatlas/slack";

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

## Reference

- [Chat SDK plugin docs](https://docs.useatlas.dev/plugins/chat)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
