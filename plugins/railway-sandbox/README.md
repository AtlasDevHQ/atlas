# @useatlas/railway-sandbox

Ephemeral Railway microVM isolation via the Railway Sandboxes SDK.

> **⚠ Security caveat — read before adopting.** Railway Sandboxes offer only
> `ISOLATED` (outbound internet via NAT) and `PRIVATE` (private network +
> outbound internet) network modes — **neither blocks outbound egress**. A
> compromised or malicious explore command can phone home, which makes this a
> strictly weaker isolation posture than a deny-all backend (e.g. Vercel
> Sandbox with `networkPolicy: "deny-all"`). This plugin always creates
> sandboxes in `ISOLATED` mode (never `PRIVATE`), reports
> `security.networkIsolation: false` honestly, and is suitable for
> **single-tenant / self-hosted** deployments that accept the trade-off. It is
> **not suitable for multi-tenant SaaS** until Railway ships a no-egress mode
> ([#3231](https://github.com/AtlasDevHQ/atlas/issues/3231)).

## Install

```bash
bun add @useatlas/railway-sandbox railway
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { railwaySandboxPlugin } from "@useatlas/railway-sandbox";

// On Railway, RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID are picked up
// automatically by the SDK:
export default defineConfig({
  plugins: [railwaySandboxPlugin({})],
});

// Or pass credentials explicitly:
export default defineConfig({
  plugins: [
    railwaySandboxPlugin({
      token: process.env.RAILWAY_API_TOKEN!,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID!,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | `string?` | `RAILWAY_API_TOKEN` env | Railway API token |
| `environmentId` | `string?` | `RAILWAY_ENVIRONMENT_ID` env | Environment to create sandboxes in |
| `idleTimeoutMinutes` | `number` | `10` | Idle backstop (1–120). Railway destroys the sandbox after this much idle time even if `close()` never runs |
| `timeoutSec` | `number` | `30` | Command timeout in seconds |

## Behavior notes

- **Lifecycle.** The sandbox is destroyed eagerly when the cached backend is
  evicted (`close()` → `destroy()`); `idleTimeoutMinutes` is the billing
  backstop for leaked sandboxes. Health checks create + destroy a sandbox with
  a 1-minute backstop.
- **File upload.** The Railway SDK has no bulk file API ("use exec or SSH"),
  so the semantic tree is uploaded as base64 inside batched `exec` commands.
  Symlinks escaping the semantic root are skipped, matching the other sandbox
  backends.
- **Per-environment sandbox cap.** Railway caps sandboxes per environment —
  10 (Trial/Free), 50 (Hobby), 100 (Pro/Enterprise); only `CREATING`/`RUNNING`
  count. Atlas caches one explore backend per semantic root (per org), so more
  concurrently-active orgs than the cap will fail `create()` — the error
  message surfaces the cap and the remedy (destroy idle sandboxes, wait for
  idle timeouts, or upgrade the plan).
- **Beta SDK.** Railway Sandboxes are in Priority Boarding; the SDK "may
  change in breaking ways between releases". Soak in staging before relying on
  it.

## Reference

- [Railway Sandboxes docs](https://docs.railway.com/sandboxes)
- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
