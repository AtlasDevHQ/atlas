# @atlas/plugin-mysql-datasource

MySQL datasource plugin using mysql2 pool adapter.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "mysql2": "^3.18.0" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { mysqlPlugin } from "@atlas/plugin-mysql-datasource";

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

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
