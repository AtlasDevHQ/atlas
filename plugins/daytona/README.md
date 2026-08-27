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
| `target` | `string?` | account default | Daytona region for created sandboxes (e.g. `us`, `eu`). Applies to **both** explore and Python |
| `pythonPackages` | `string[]` | pandas, numpy, matplotlib, scipy, scikit-learn, statsmodels | Installed once per Python sandbox. Set to `[]` when your image already bakes them in |

## Python execution

This plugin implements the SDK's optional Python surface, so a workspace that
selects Daytona runs **both** `explore` and `executePython` on its own Daytona
account, in the configured `target` region. A failure there is an error, not a
fallback to the Atlas platform sandbox.

**Egress:** Daytona sandboxes have outbound network access with no per-sandbox
host allowlist, so the host's per-request REST datasource egress bound is
**not** applied — the plugin declares `pythonEgressControl: "unsupported"` and
Atlas logs the gap. Use the Vercel Sandbox provider if a `deny-all` egress pin
is a requirement.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
