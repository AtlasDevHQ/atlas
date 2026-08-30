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

**Egress:** the host's per-request REST datasource egress bound **is** applied,
so the plugin declares `pythonEgressControl: "enforced"`. Atlas's default for a
Python run is deny-all; when a REST datasource is active the bound narrows to
that datasource's hosts instead.

The plugin sets it with `sandbox.updateNetworkSettings` (`networkBlockAll` for
deny-all, `domainAllowList` for an allowlist) **after** `pythonPackages` are
installed and **before** any agent code runs. That ordering is deliberate:
Daytona documents its pre-approved essential-services lists (PyPI, npm, GitHub)
as no longer applying once a sandbox carries a custom allow list, so narrowing
first would break `pip install`.

⚠️ **Two Daytona-side requirements**, both of which fail the Python run rather
than silently downgrading it to an unbounded sandbox:

- Per-sandbox network overrides are a **Tier 3/Tier 4 organization** capability.
  A Tier 1/2 organization's API rejects the call, and `executePython` then fails
  with a named error. Explore is unaffected.
- `@daytonaio/sdk` **>= 0.201.0**, the version this was verified against and the
  peer range now requires.

Daytona caps a domain allow list at 20 entries; a request carrying more is
rejected rather than truncated.

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
