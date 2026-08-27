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
| `pythonPackages` | `string[]` | pandas, numpy, matplotlib, scipy, scikit-learn, statsmodels | Installed once per Python sandbox. Set to `[]` when your `template` already bakes them in |

## Python execution

This plugin implements the SDK's optional Python surface, so a workspace that
selects E2B runs **both** `explore` and `executePython` on its own E2B account.
A failure there is an error, not a fallback to the Atlas platform sandbox.

**Egress:** E2B exposes no per-sandbox host allowlist, so the host's
per-request REST datasource egress bound is **not** applied — the plugin
declares `pythonEgressControl: "unsupported"` and Atlas logs the gap. E2B BYOC
runs inside your own VPC, where egress is yours to bound at the network layer.
Use the Vercel Sandbox provider if a `deny-all` egress pin is a requirement.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
