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

**Egress:** the host's per-request REST datasource egress bound **is** applied,
so the plugin declares `pythonEgressControl: "enforced"`. Atlas's default for a
Python run is deny-all; when a REST datasource is active the bound narrows to
that datasource's hosts instead.

The plugin sets it with `sandbox.updateNetwork` (`allowInternetAccess: false`
for deny-all; `allowOut` paired with `denyOut: ["0.0.0.0/0"]` for an allowlist)
**after** `pythonPackages` are installed and **before** any agent code runs —
narrowing first would cut the sandbox off from PyPI.

⚠️ Requires the `e2b` SDK **>= 2.45.0**, the version this was verified against
and the peer range now requires. On a deployment whose SDK or backend refuses
the egress rules, `executePython` fails with a named error rather than running
unbounded; explore is unaffected. This bound is per sandbox and is in addition
to whatever your own VPC enforces on a BYOC deployment.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
