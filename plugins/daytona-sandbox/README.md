# @atlas/plugin-daytona-sandbox

Cloud-hosted sandbox isolation via the Daytona SDK.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "@daytonaio/sdk": ">=0.1.0" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { daytonaSandboxPlugin } from "@atlas/plugin-daytona-sandbox";

export default defineConfig({
  plugins: [daytonaSandboxPlugin({ apiKey: process.env.DAYTONA_API_KEY! })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | — | Daytona API key |
| `apiUrl` | `string?` | cloud endpoint | Daytona API URL override |
| `timeoutSec` | `number` | `30` | Command timeout in seconds |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
