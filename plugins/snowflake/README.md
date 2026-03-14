# @useatlas/snowflake

Snowflake datasource plugin wrapping the callback-based snowflake-sdk.

## Install

```bash
bun add @useatlas/snowflake snowflake-sdk
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { snowflakePlugin } from "@useatlas/snowflake";

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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
