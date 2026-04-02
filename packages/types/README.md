# @useatlas/types

Shared TypeScript types for the [Atlas](https://www.useatlas.dev) text-to-SQL agent.

## Install

```bash
bun add @useatlas/types
```

## Usage

Import from the barrel or use deep imports for tree-shaking:

```typescript
import type { Conversation, AuthMode, DBType } from "@useatlas/types";

// Deep imports
import type { ChatErrorCode } from "@useatlas/types/errors";
import type { Recipient } from "@useatlas/types/scheduled-task";
import { parseChatError, authErrorMessage } from "@useatlas/types/errors";
```

## Modules

| Import path | Contents |
|-------------|----------|
| `@useatlas/types` | Barrel — re-exports everything below |
| `@useatlas/types/auth` | `AuthMode`, `AtlasRole`, `AtlasUser` |
| `@useatlas/types/conversation` | `Conversation`, `Message`, `ConversationWithMessages` |
| `@useatlas/types/connection` | `DBType`, `ConnectionHealth`, `ConnectionInfo`, `ConnectionDetail` |
| `@useatlas/types/action` | `ActionApprovalMode`, `ActionDisplayStatus`, `ActionToolResultShape` |
| `@useatlas/types/scheduled-task` | `ScheduledTask`, `Recipient`, `ScheduledTaskRun` |
| `@useatlas/types/errors` | `ChatErrorCode`, `ChatErrorInfo`, `parseChatError`, `authErrorMessage` |
| `@useatlas/types/semantic` | `Dimension`, `SemanticEntitySummary`, `SemanticEntityDetail` |
| `@useatlas/types/share` | `ShareLink` |

## License

MIT
