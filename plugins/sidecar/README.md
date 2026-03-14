# @useatlas/sidecar

HTTP-isolated container sidecar for the explore tool. Communicates with a separate container running bash/coreutils.

## Install

```bash
bun add @useatlas/sidecar
```

Requires a running sidecar service (see `packages/sandbox-sidecar/`).

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { sidecarSandboxPlugin } from "@useatlas/sidecar";

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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
