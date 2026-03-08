# @atlas/plugin-e2b-sandbox

E2B Firecracker microVM (managed) sandbox for the explore tool.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "e2b": ">=1.0.0" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { e2bSandboxPlugin } from "@atlas/plugin-e2b-sandbox";

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

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
