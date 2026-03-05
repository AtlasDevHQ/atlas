# @atlas/plugin-sidecar-sandbox

HTTP-isolated container sidecar for the explore tool. Communicates with a separate container running bash/coreutils.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" }
}
```

Requires a running sidecar service (see `packages/sandbox-sidecar/`).

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { sidecarSandboxPlugin } from "@atlas/plugin-sidecar-sandbox";

export default defineConfig({
  plugins: [sidecarSandboxPlugin({ url: "http://sandbox-sidecar:8080" })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | Sidecar service URL |
| `authToken` | `string?` | — | Optional shared auth token |
| `timeoutMs` | `number` | `10000` | Command timeout in ms |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
