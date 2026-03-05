# @atlas/plugin-snowflake-datasource

Snowflake datasource plugin wrapping the callback-based snowflake-sdk.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "snowflake-sdk": "^2.3.4" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { snowflakePlugin } from "@atlas/plugin-snowflake-datasource";

export default defineConfig({
  plugins: [snowflakePlugin({ url: "snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE" })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | Snowflake connection URL (`snowflake://`) |
| `maxConnections` | `number?` | `10` | Maximum pool connections (max 100) |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
