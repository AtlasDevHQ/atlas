# @useatlas/clickhouse

ClickHouse datasource plugin using the HTTP transport adapter.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "@clickhouse/client": ">=1.0.0" }
}
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

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
