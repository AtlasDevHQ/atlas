# @useatlas/e2b

E2B Firecracker microVM (managed) sandbox for the explore tool.

## Install

```bash
bun add @useatlas/e2b e2b
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { e2bSandboxPlugin } from "@useatlas/e2b";

export default defineConfig({
  plugins: [e2bSandboxPlugin({ apiKey: process.env.E2B_API_KEY! })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | — | E2B API key |
| `template` | `string?` | default | Sandbox template ID |
| `timeoutSec` | `number` | `30` | Command timeout in seconds |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
