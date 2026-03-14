# @useatlas/daytona

Cloud-hosted sandbox isolation via the Daytona SDK.

## Install

```bash
bun add @useatlas/daytona @daytonaio/sdk
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { daytonaSandboxPlugin } from "@useatlas/daytona";

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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
