# @useatlas/nsjail

Linux namespace isolation via nsjail for the explore tool. No network, read-only filesystem, runs as nobody.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" }
}
```

Requires `nsjail` on PATH or configured via `nsjailPath`.

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { nsjailSandboxPlugin } from "@useatlas/nsjail";

export default defineConfig({
  plugins: [nsjailSandboxPlugin({ timeLimitSec: 15, memoryLimitMb: 512 })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `nsjailPath` | `string?` | auto-detect | Explicit path to nsjail binary |
| `timeLimitSec` | `number` | `10` | Per-command time limit in seconds |
| `memoryLimitMb` | `number` | `256` | Per-command memory limit in MB |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
