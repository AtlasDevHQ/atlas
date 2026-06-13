import { OAuthHelperError } from "./errors";
import { describeOAuthErrorBody, FETCH_TIMEOUT_MS } from "./_internal/http";
import { validateTokenEndpoint } from "./validate";

export interface ExchangeCodeParams {
  /** From discovery (or callback options). MUST be https — guarded internally. */
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  /**
   * RFC 8707 resource indicator — the protected resource the issued token
   * is bound to (e.g. `${apiUrl}/mcp`). When present it's sent as the
   * `resource` form field on the token request. Better Auth's
   * `@better-auth/oauth-provider` only mints a JWT-formatted access token
   * (vs an opaque one) when the token request carries a `resource`; the
   * MCP route's `verifyMcpBearer` requires the JWT shape. Omit it for
   * consumers that don't bind to a specific resource — the field is simply
   * not sent and the server falls back to its default token format.
   */
  resource?: string;
}

export interface ExchangeCodeOptions {
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * RFC 6749 §4.1.3 token-exchange shape, narrowed to what consumers
 * actually read. Unrecognised fields on the wire are dropped — callers
 * decode the JWT to reach issuer / workspace / azp claims.
 */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Exchange the authorization code for an access token (and optional
 * refresh token) at the token endpoint. The endpoint is re-validated as
 * https:// before the POST so a malicious DCR response advertising
 * `token_endpoint: "http://evil/token"` cannot smuggle the auth code +
 * PKCE verifier over plaintext — that hardening was added in
 * #2198 for the SDK and now applies to every consumer of this helper.
 */
export async function exchangeCode(
  params: ExchangeCodeParams,
  options?: ExchangeCodeOptions,
): Promise<TokenResponse> {
  // Run the https guard BEFORE resolving the fetch impl. The validation
  // is intrinsic to the helper's contract, not contingent on the wire
  // layer — a test passing a stub `fetchImpl` for an `http://evil`
  // endpoint should still get `invalid_token_endpoint`, not a synthetic
  // happy-path 200 from the stub.
  validateTokenEndpoint(params.tokenEndpoint);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  // RFC 8707 — bind the issued token to the requested resource. Appended
  // only when the caller supplies it so consumers that don't need
  // resource-scoped tokens keep the original request shape.
  if (params.resource !== undefined && params.resource.length > 0) {
    body.set("resource", params.resource);
  }
  let res: Response;
  try {
    res = await fetchImpl(params.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthHelperError(
      `Token exchange failed: ${msg}`,
      "token_exchange_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await describeOAuthErrorBody(res);
    throw new OAuthHelperError(
      `Token endpoint returned ${res.status}${detail ? `: ${detail}` : ""}`,
      "token_exchange_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new OAuthHelperError(
      `Token endpoint response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "token_exchange_failed",
      { cause: err },
    );
  })) as Partial<TokenResponse>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new OAuthHelperError(
      `Token endpoint response missing access_token`,
      "token_exchange_failed",
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    token_type: typeof data.token_type === "string" ? data.token_type : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}
