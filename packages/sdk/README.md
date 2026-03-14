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
| `atlas.streamQuery(question, opts?)` | Stream a query as an async iterator of typed `StreamEvent`s |
| `atlas.chat(messages, opts?)` | Start a streaming chat session. Returns a raw `Response` with SSE body (AI SDK UI Message Stream Protocol) |

### Schema

| Method | Description |
|--------|-------------|
| `atlas.listTables()` | List all queryable tables with column details. Returns `{ tables: TableInfo[] }` |

```typescript
const { tables } = await atlas.listTables();
for (const t of tables) {
  console.log(`${t.table}: ${t.description}`);
  for (const col of t.columns) {
    console.log(`  ${col.name} (${col.type}) — ${col.description}`);
  }
}
```

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

## Streaming

Use `streamQuery()` to receive typed events as the agent works:

```typescript
import type { StreamEvent } from "@useatlas/sdk";

for await (const event of atlas.streamQuery("How many users signed up last week?")) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.content);
      break;
    case "tool-call":
      console.log(`Calling ${event.name}`, event.args);
      break;
    case "tool-result":
      console.log(`${event.name} returned`, event.result);
      break;
    case "result":
      console.table(event.rows); // convenience: { columns, rows } from executeSQL
      break;
    case "error":
      console.error(event.message);
      break;
    case "parse-error":
      console.warn("Malformed SSE frame", event.raw);
      break;
    case "finish":
      console.log(`\nDone (${event.reason})`);
      break;
  }
}
```

### Connection Drops & Partial Results

`streamQuery()` uses a one-shot SSE connection over `fetch`. If the connection drops mid-stream:

- Events already yielded **are still valid** — the async generator delivers each event to your `for await` loop before advancing, so any `text`, `result`, or `tool-result` events you've already processed are safe to keep.
- The generator throws an `AtlasError` with code `network_error` and a message starting with `"Stream interrupted: ..."`.
- There is no automatic reconnect or resume — start a new `streamQuery()` call to retry.

```typescript
import { AtlasError } from "@useatlas/sdk";

const collected: string[] = [];

try {
  for await (const event of atlas.streamQuery("Revenue by region")) {
    if (event.type === "text") collected.push(event.content);
    if (event.type === "result") console.table(event.rows);
  }
} catch (err) {
  if (err instanceof AtlasError && err.code === "network_error") {
    console.warn("Stream dropped — partial text:", collected.join(""));
    // Decide whether to retry or use the partial data you have
  } else {
    throw err;
  }
}
```

### Cancellation

Pass an `AbortSignal` to cancel the stream. The signal aborts the underlying reader, and an `AbortError` is thrown from the `for await` loop. Events yielded before cancellation are already consumed by your code.

```typescript
const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10_000);

try {
  for await (const event of atlas.streamQuery("...", { signal: controller.signal })) {
    if (event.type === "text") process.stdout.write(event.content);
  }
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    console.log("Stream cancelled");
  }
}
```

### Stream Event Types

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `content` | Text chunk from the agent |
| `tool-call` | `toolCallId`, `name`, `args` | Agent is calling a tool |
| `tool-result` | `toolCallId`, `name`, `result` | Tool returned a result |
| `result` | `columns`, `rows` | Convenience event extracted from `tool-result` when `executeSQL` returns data. Both `tool-result` and `result` are emitted. |
| `error` | `message` | Error during streaming |
| `parse-error` | `raw`, `error` | Client-side: an SSE frame contained invalid JSON. The raw data is preserved for debugging. |
| `finish` | `reason` | Stream completed |

## Error Handling

All methods throw `AtlasError` on failure. See the full [Error Codes Reference](https://docs.useatlas.dev/reference/error-codes) for every error code, HTTP status, retry guidance, and a complete retry-with-backoff example.

```typescript
import { AtlasError } from "@useatlas/sdk";

try {
  await atlas.query("...");
} catch (err) {
  if (err instanceof AtlasError) {
    console.error(err.code);     // e.g. "rate_limited", "auth_error"
    console.error(err.status);   // HTTP status code
    console.error(err.message);  // Human-readable message
    console.error(err.retryable); // true if retrying may help
  }
}
```

### `AtlasError` Properties

| Property | Type | Description |
|----------|------|-------------|
| `code` | `AtlasErrorCode` | Error code (e.g. `rate_limited`, `network_error`) |
| `status` | `number` | HTTP status code (0 for client-side errors like `network_error`) |
| `message` | `string` | Human-readable description |
| `retryable` | `boolean` | Whether retrying the same request may succeed |
| `retryAfterSeconds` | `number \| undefined` | Server-suggested delay — only populated for `rate_limited` errors with a `Retry-After` header. **Always guard against `undefined`** |

### Retry with Backoff

Use `retryable` for generic retry logic. For `rate_limited`, prefer the server-suggested delay when available, falling back to exponential backoff:

```typescript
import { AtlasError } from "@useatlas/sdk";

try {
  await atlas.query("...");
} catch (err) {
  if (!(err instanceof AtlasError) || !err.retryable) throw err;

  // Use server delay if available, otherwise exponential backoff
  const delay = err.retryAfterSeconds != null
    ? err.retryAfterSeconds * 1000
    : 5000;
  await new Promise((r) => setTimeout(r, delay));
  await atlas.query("...");
}
```

## License

MIT
