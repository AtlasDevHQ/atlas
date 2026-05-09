/**
 * `@atlas/oauth-helper` — transport-agnostic OAuth 2.1 + DCR + PKCE
 * primitives shared by `@useatlas/sdk` (programmatic browser flow) and
 * `@useatlas/mcp` (CLI loopback flow).
 *
 * Internal-only — see README. Consumers vendor or bundle the source.
 */

export { OAuthHelperError, type OAuthHelperErrorCode } from "./errors";
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
