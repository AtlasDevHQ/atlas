# @useatlas/clickhouse

ClickHouse datasource plugin using the HTTP transport adapter.

## Install

```bash
bun add @useatlas/clickhouse @clickhouse/client
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { clickhousePlugin } from "@useatlas/clickhouse";

export default defineConfig({
  plugins: [clickhousePlugin({ url: "clickhouse://localhost:8123/default" })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | ClickHouse URL (`clickhouse://` or `clickhouses://`) |
| `database` | `string?` | from URL | Database name override |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
