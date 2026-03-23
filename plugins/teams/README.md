# @useatlas/teams

> **Deprecated**: Use [`@useatlas/chat`](../chat/) with the Teams adapter instead.
> The Chat SDK bridge plugin provides the same Teams functionality plus
> multi-platform support (Slack, Discord, etc.) and built-in state management.

Microsoft Teams interaction plugin with Bot Framework messaging, @mention handling, and Adaptive Card responses.

## Migration to @useatlas/chat

```typescript
// Before (@useatlas/teams):
import { teamsPlugin } from "@useatlas/teams";

teamsPlugin({
  appId: process.env.TEAMS_APP_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
  tenantId: process.env.TEAMS_TENANT_ID,
  executeQuery: myQueryFunction,
})

// After (@useatlas/chat):
import { chatPlugin } from "@useatlas/chat";

chatPlugin({
  adapters: {
    teams: {
      appId: process.env.TEAMS_APP_ID!,
      appPassword: process.env.TEAMS_APP_PASSWORD!,
      tenantId: process.env.TEAMS_TENANT_ID,
    },
  },
  executeQuery: myQueryFunction,
  actions: myActionCallbacks,        // optional
  conversations: myConversations,    // optional
})
```

### Key changes

| Feature | @useatlas/teams | @useatlas/chat |
|---------|----------------|----------------|
| Webhook | `/messages` | `/webhooks/teams` (single endpoint) |
| Adaptive Cards | Hand-rolled builders | Automatic via Chat SDK adapter |
| State | None | Chat SDK state adapter (memory/PG/Redis) |
| Follow-ups | Single query per activity | Chat SDK subscription model |
| Multi-platform | Teams only | Teams, Slack, Discord, etc. |

## Legacy Usage

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

## Reference

- [Chat SDK plugin docs](https://docs.useatlas.dev/plugins/chat)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Teams setup guide](https://docs.useatlas.dev/plugins/interactions/teams)
