# @atlas/oauth-helper

Transport-agnostic OAuth 2.1 + Dynamic Client Registration (DCR) + PKCE primitives shared between `@useatlas/sdk` (programmatic browser flow, popup / redirect) and `@useatlas/mcp` (CLI loopback flow).

**Internal-only.** Not published to npm. Consumers vendor or bundle the source at build time:

- `@useatlas/sdk` bundles via `bun build` (the helper is not externalized).
- `@useatlas/mcp` vendors the source at `prepare` time into `plugins/mcp/src/_oauth-helper/` (see `plugins/mcp/scripts/vendor-oauth-helper.sh`).

## Surface

```ts
import {
  OAuthHelperError,
  discover,
  register,
  generatePkce,
  generateState,
  buildAuthorizationUrl,
  exchangeCode,
  validateIssuerUrl,
  validateTokenEndpoint,
  decodeJwtPayload,
  enforceIssuer,
} from "@atlas/oauth-helper";
```

Every primitive accepts a `fetchImpl` / `randomBytesImpl` test seam so callers can drive the flow deterministically without a network or CSPRNG.

## Why this exists

Pre-extraction, the SDK (`packages/sdk/src/mcp.ts`) and the CLI (`plugins/mcp/src/init/hosted.ts`) each carried a near-identical copy of: discovery, DCR, PKCE generation, authorization-URL construction, token exchange, JWT-payload decode, and issuer enforcement. The HTTPS-only token-endpoint hardening landed in #2198 in the SDK first, did not land in the CLI for several releases, and was the canonical example of "two implementations drift." Collapsing to one helper kills the drift class — every spec quirk and security fix lands in one place and benefits both consumers immediately.
