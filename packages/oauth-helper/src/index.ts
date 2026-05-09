/**
 * `@atlas/oauth-helper` — transport-agnostic OAuth 2.1 + DCR + PKCE
 * primitives shared by `@useatlas/sdk` (programmatic browser flow) and
 * `@useatlas/mcp` (CLI loopback flow).
 *
 * Internal-only — see README. Consumers vendor or bundle the source.
 *
 * ── Re-export safety note ────────────────────────────────────────────
 *
 * `decodeJwtPayload` is re-exported below for convenience but it
 * skips signature verification. It is safe ONLY inside a flow that has
 * already validated the token endpoint as `https://` and that calls
 * `enforceIssuer` on the result before reading any other claim. Do NOT
 * call it as a generic JWT decoder — see `./jwt.ts` for the full
 * contract.
 */

export { OAuthHelperError, type OAuthHelperErrorCode } from "./errors";
export { type Bearer } from "./brands";
export { discover, type AuthServerMetadata, type DiscoverOptions } from "./discover";
export { register, type RegisterParams, type RegisterOptions } from "./register";
export {
  generatePkce,
  generateState,
  type PkceCodeChallenge,
  type RandomBytesOptions,
} from "./pkce";
export {
  buildAuthorizationUrl,
  type BuildAuthorizationUrlParams,
} from "./authorize-url";
export {
  exchangeCode,
  type ExchangeCodeParams,
  type ExchangeCodeOptions,
  type TokenResponse,
} from "./exchange";
export { validateIssuerUrl, validateTokenEndpoint } from "./validate";
export { decodeJwtPayload, enforceIssuer } from "./jwt";
