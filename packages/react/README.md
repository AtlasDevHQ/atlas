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

## Headless Hooks

For fully custom UIs, use the hooks entry point. Tool renderer types are also available here:

```tsx
import { AtlasProvider, useAtlasChat } from "@useatlas/react/hooks";
import type { ToolRendererProps, SQLToolResult } from "@useatlas/react/hooks";
```

See the [hooks documentation](https://docs.useatlas.dev) for details.
