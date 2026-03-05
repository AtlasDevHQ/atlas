# @useatlas/sdk

TypeScript SDK for the [Atlas](https://useatlas.dev) text-to-SQL agent API.

## Install

```bash
bun add @useatlas/sdk
```

## Quick Start

```typescript
import { createAtlasClient } from "@useatlas/sdk";

const atlas = createAtlasClient({
  baseUrl: "https://api.example.com",
  apiKey: "my-key",
});

const result = await atlas.query("How many users signed up last week?");
console.log(result.answer);
console.log(result.sql);    // SQL queries the agent executed
console.log(result.data);   // Raw query results ({ columns, rows }[])
```

## Authentication

Pass either `apiKey` (simple key auth) or `bearerToken` (BYOT / managed auth):

```typescript
// Simple API key
const atlas = createAtlasClient({ baseUrl: "...", apiKey: "my-key" });

// Bearer token (JWT from your auth provider)
const atlas = createAtlasClient({ baseUrl: "...", bearerToken: "eyJ..." });
```

## API Reference

### Query

| Method | Description |
|--------|-------------|
| `atlas.query(question, opts?)` | Run a synchronous query. Returns `{ answer, sql, data, steps, usage }` |
| `atlas.chat(messages, opts?)` | Start a streaming chat session. Returns a raw `Response` with SSE body (AI SDK Data Stream Protocol) |

### Conversations

| Method | Description |
|--------|-------------|
| `atlas.conversations.list(opts?)` | List conversations (paginated) |
| `atlas.conversations.get(id)` | Get a conversation with messages |
| `atlas.conversations.delete(id)` | Delete a conversation |
| `atlas.conversations.star(id)` | Star a conversation |
| `atlas.conversations.unstar(id)` | Unstar a conversation |

### Scheduled Tasks

| Method | Description |
|--------|-------------|
| `atlas.scheduledTasks.list(opts?)` | List scheduled tasks (paginated) |
| `atlas.scheduledTasks.get(id)` | Get a task with recent runs |
| `atlas.scheduledTasks.create(input)` | Create a scheduled task |
| `atlas.scheduledTasks.update(id, input)` | Update a scheduled task |
| `atlas.scheduledTasks.delete(id)` | Delete a scheduled task |
| `atlas.scheduledTasks.trigger(id)` | Trigger immediate execution |
| `atlas.scheduledTasks.listRuns(id, opts?)` | List past runs |

### Admin (requires admin role)

| Method | Description |
|--------|-------------|
| `atlas.admin.overview()` | Dashboard overview data |
| `atlas.admin.semantic.entities()` | List semantic layer entities |
| `atlas.admin.semantic.entity(name)` | Get entity detail |
| `atlas.admin.semantic.metrics()` | List metrics |
| `atlas.admin.semantic.glossary()` | Get glossary |
| `atlas.admin.semantic.catalog()` | Get catalog |
| `atlas.admin.semantic.stats()` | Aggregate semantic stats |
| `atlas.admin.connections()` | List datasource connections |
| `atlas.admin.testConnection(id)` | Test connection health |
| `atlas.admin.audit(opts?)` | Query audit log |
| `atlas.admin.auditStats()` | Aggregate audit stats |
| `atlas.admin.plugins()` | List installed plugins |
| `atlas.admin.pluginHealth(id)` | Check plugin health |

## Error Handling

All methods throw `AtlasError` on failure:

```typescript
import { AtlasError } from "@useatlas/sdk";

try {
  await atlas.query("...");
} catch (err) {
  if (err instanceof AtlasError) {
    console.error(err.code);    // e.g. "rate_limited", "auth_error"
    console.error(err.status);  // HTTP status code
    console.error(err.message); // Human-readable message

    if (err.code === "rate_limited") {
      // Retry after the suggested delay
      await sleep(err.retryAfterSeconds! * 1000);
    }
  }
}
```

## License

MIT
