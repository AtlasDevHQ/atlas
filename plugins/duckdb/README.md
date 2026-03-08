# @useatlas/duckdb

DuckDB in-process datasource plugin.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "@duckdb/node-api": "^1.4.4-r.1" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { duckdbPlugin } from "@useatlas/duckdb";

export default defineConfig({
  plugins: [duckdbPlugin({ url: "duckdb://analytics.duckdb" })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | DuckDB URL (`duckdb://path` or `duckdb://:memory:`) |
| `readOnly` | `boolean?` | `true` for files | Open in read-only mode |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
