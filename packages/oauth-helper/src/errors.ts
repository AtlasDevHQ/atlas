/**
 * Error class shared by every primitive in `@atlas/oauth-helper`.
 *
 * Codes intentionally overlap 1:1 with the consumer error codes in
 * `@useatlas/sdk` (`AtlasMcpErrorCode`) and `@useatlas/mcp`
 * (`HostedFlowErrorCode`), so each consumer's wrap-and-rethrow at the
 * boundary is a typed `code as ConsumerCode` cast — no string remap
 * table to maintain. When the helper grows a new code, both consumers
 * widen their union or translate it explicitly.
 */
export type OAuthHelperErrorCode =
  | "invalid_api_url"
  | "invalid_token_endpoint"
  | "discovery_failed"
  | "registration_failed"
  | "token_exchange_failed"
  | "issuer_mismatch"
  | "malformed_jwt"
  | "missing_workspace_claim";

export class OAuthHelperError extends Error {
  readonly code: OAuthHelperErrorCode;
  constructor(message: string, code: OAuthHelperErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthHelperError";
    this.code = code;
  }
}
