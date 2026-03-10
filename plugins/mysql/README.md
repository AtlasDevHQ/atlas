# @useatlas/mysql

MySQL datasource plugin using mysql2 pool adapter.

## Install

```bash
bun add @useatlas/mysql mysql2
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { mysqlPlugin } from "@useatlas/mysql";

export default defineConfig({
  plugins: [mysqlPlugin({ url: "mysql://user:pass@localhost:3306/mydb" })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | MySQL URL (`mysql://` or `mysql2://`) |
| `poolSize` | `number?` | `10` | Maximum pool connections (max 500) |
| `idleTimeoutMs` | `number?` | `30000` | Idle connection timeout in ms |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
