# @useatlas/duckdb

DuckDB in-process datasource plugin.

## Install

```bash
bun add @useatlas/duckdb @duckdb/node-api
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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
