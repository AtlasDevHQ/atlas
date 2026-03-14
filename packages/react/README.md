# @useatlas/react

Embeddable Atlas chat UI for React applications.

## Installation

```bash
bun add @useatlas/react
```

## Usage

```tsx
import { AtlasChat } from "@useatlas/react";
import "@useatlas/react/styles.css";

function App() {
  return <AtlasChat apiUrl="https://api.example.com" apiKey="your-key" />;
}
```

## Custom Tool Renderers

Override how SQL results, charts, explore output, and Python results render inside the widget using the `toolRenderers` prop. This example assumes you have already imported the styles as shown above.

```tsx
import { AtlasChat, type ToolRendererProps, type SQLToolResult } from "@useatlas/react";

function MySQLRenderer({ result, isLoading }: ToolRendererProps<SQLToolResult | null>) {
  if (isLoading || !result) return <div>Running query...</div>;
  if (!result.success) return <div>Query failed: {result.error}</div>;

  return (
    <div>
      <h3>Results ({result.rows.length} rows)</h3>
      <table>
        <thead>
          <tr>{result.columns.map((col) => <th key={col}>{col}</th>)}</tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {result.columns.map((col) => <td key={col}>{String(row[col] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  return (
    <AtlasChat
      apiUrl="https://api.example.com"
      apiKey="your-key"
      toolRenderers={{
        executeSQL: MySQLRenderer,
      }}
    />
  );
}
```

### Available tool names

| Tool Name       | Result Type         | Description                  |
| --------------- | ------------------- | ---------------------------- |
| `executeSQL`    | `SQLToolResult`     | SQL query results with columns and rows |
| `explore`       | `ExploreToolResult` | Semantic layer exploration output (string) |
| `executePython` | `PythonToolResult`  | Python execution results with optional charts and tables |

Custom renderers for any tool name are supported — just add the tool name as a key in the `toolRenderers` map. Tools without a custom renderer use the built-in defaults.

### Renderer props

Every renderer receives `ToolRendererProps<T>`:

| Prop        | Type                       | Description                              |
| ----------- | -------------------------- | ---------------------------------------- |
| `toolName`  | `string`                   | Name of the tool being rendered          |
| `args`      | `Record<string, unknown>`  | Input arguments passed to the tool       |
| `result`    | `T`                        | Tool output. Built-in tool types include `\| null` for the loading state |
| `isLoading` | `boolean`                  | Whether the tool invocation is in progress |

## Error Handling

The widget handles errors at three levels — render errors (error boundary), API/network errors (error banner), and widget-level errors (postMessage). Each is automatic; you only need to listen if you want to react in your host application.

### Error States

| Error | What the user sees | Auto-recovery |
|-------|-------------------|---------------|
| API unreachable | "Unable to connect to Atlas." with a retry button | No — user must retry |
| Auth failure | Auth-mode-specific message (e.g. "Your session has expired.") | No — requires re-auth |
| Offline | "You appear to be offline." | Yes — auto-retries when `navigator.onLine` restores |
| Rate limited | "Too many requests." with countdown timer | Yes — auto-retries after countdown |
| Server error (5xx) | "Something went wrong on our end." with retry button | No — user must retry |
| Render crash | "Something went wrong." with a try-again button (error boundary) | No — user must click retry |

### Listening for Errors via postMessage

When embedded as an iframe, the widget emits `atlas:error` messages to the parent window on every error:

```javascript
window.addEventListener("message", (event) => {
  if (event.origin !== "https://your-atlas-api.example.com") return;

  if (event.data?.type === "atlas:error") {
    const { code, message, detail, retryable } = event.data.error;
    // code: "api_unreachable" | "auth_failure" | "rate_limited_http" | "offline" | "server_error" | ChatErrorCode
    // retryable: true for transient errors, false for permanent ones
    console.error(`[Atlas] ${code}: ${message}`);
  }
});
```

### Listening for Errors via the Programmatic API

When using the script tag loader, use `Atlas.on("error", ...)`:

```javascript
Atlas.on("error", (detail) => {
  // detail: { code?: string, message?: string }
  console.error("Widget error:", detail.code, detail.message);
});
```

### Auth Token Refresh

When a managed auth session expires mid-conversation, the widget shows "Your session has expired. Please sign in again." For iframe embeds using external tokens (BYOT mode), refresh the token via postMessage:

```javascript
// When your app refreshes a token, push it to the widget
function onTokenRefresh(newToken) {
  const iframe = document.querySelector("iframe");
  iframe.contentWindow.postMessage(
    { type: "auth", token: newToken },
    "https://your-atlas-api.example.com",
  );
}
```

For the script tag loader:

```javascript
Atlas.setAuthToken(newToken);
```

### CSP Configuration

If your site uses a Content Security Policy, add the Atlas API domain to these directives:

```
Content-Security-Policy:
  script-src 'self' https://your-atlas-api.example.com;
  frame-src 'self' https://your-atlas-api.example.com;
  connect-src 'self' https://your-atlas-api.example.com;
```

See the [Embedding Widget guide](https://docs.useatlas.dev/guides/embedding-widget#content-security-policy-csp) for full CSP details.

## Headless Hooks

For fully custom UIs, use the hooks entry point. Tool renderer types are also available here:

```tsx
import { AtlasProvider, useAtlasChat } from "@useatlas/react/hooks";
import type { ToolRendererProps, SQLToolResult } from "@useatlas/react/hooks";
```

See the [hooks documentation](https://docs.useatlas.dev/reference/react) for details.
