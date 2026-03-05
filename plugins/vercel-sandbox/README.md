# @atlas/plugin-vercel-sandbox

Firecracker microVM isolation via @vercel/sandbox with deny-all network policy.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "@vercel/sandbox": ">=0.1.0" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { vercelSandboxPlugin } from "@atlas/plugin-vercel-sandbox";

// On Vercel (auto-detected OIDC):
export default defineConfig({
  plugins: [vercelSandboxPlugin({})],
});

// Off Vercel (access token):
export default defineConfig({
  plugins: [vercelSandboxPlugin({ accessToken: "...", teamId: "team_..." })],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accessToken` | `string?` | — | Access token for non-Vercel environments |
| `teamId` | `string?` | — | Required when using access token |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
