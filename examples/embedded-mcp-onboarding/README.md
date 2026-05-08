# Embedded Atlas MCP onboarding

Worked example for [#2079](https://github.com/AtlasDevHQ/atlas/issues/2079) —
how to embed Atlas's hosted-MCP onboarding flow inside your own Next.js
app using `@useatlas/react`'s `useMcpConnect` hook and `@useatlas/sdk`'s
`buildConfig` helper.

## What it shows

- A "Connect your AI agent" button that opens an OAuth 2.1 popup against
  the Atlas auth server.
- Dynamic Client Registration (no pre-registered `client_id` needed).
- PKCE + state anti-CSRF.
- A paste-ready Claude Desktop / Cursor / Continue / ChatGPT / generic
  config rendered after the user finishes signing in.

## Run it

From the repo root:

```bash
bun install
bun run --filter @atlas/embedded-mcp-onboarding-example dev
```

Then open <http://localhost:3000>.

By default the example points at `https://mcp.useatlas.dev`. Override
with:

```bash
NEXT_PUBLIC_ATLAS_API_URL=https://mcp.example.com bun run --filter @atlas/embedded-mcp-onboarding-example dev
```

## Files

- `src/app/page.tsx` — mounts `useMcpConnect`, renders the connect
  button, and shows the paste-ready config after success.
- `src/app/oauth/callback/page.tsx` — the popup target. Forwards the
  OAuth `code` + `state` (or `error`) back to the opener via
  `postMessage` and closes itself.

## Deploying behind your own auth

`useMcpConnect` works the same in popup or redirect mode:

```tsx
const { connect } = useMcpConnect({
  apiUrl: process.env.NEXT_PUBLIC_ATLAS_API_URL!,
  clientName: "My SaaS — Atlas",
  redirectUri: `${window.location.origin}/oauth/callback`,
  mode: "redirect", // or "popup"
});
```

In redirect mode you don't need a separate callback page — mount the
same hook on the page the OAuth server redirects to and it will detect
`?code` + `?state` and complete the exchange automatically.

## Out of scope

The example deliberately doesn't persist the access token. Production
embedders should treat the JWT as a credential and store it in the
user's session record (server-side); the React state above is for
demonstration only.
