import type { AuthServerMetadata } from "./discover";
import { OAuthHelperError } from "./errors";
import { describeOAuthErrorBody, FETCH_TIMEOUT_MS } from "./_internal/http";

export interface RegisterParams {
  /** Where the auth server should send the user after consent. */
  redirectUri: string;
  /** Human-readable name registered via DCR — shown on the consent screen. */
  clientName: string;
  /** Scopes to request — joined with " " into the canonical space-delimited string. */
  scopes: ReadonlyArray<string>;
}

export interface RegisterOptions {
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Dynamic Client Registration (RFC 7591). Posts a public-client manifest
 * to the registration endpoint and returns the freshly-minted client_id.
 *
 * Public-client posture: `token_endpoint_auth_method: "none"` matches
 * both the SDK popup flow and the CLI loopback flow — the server enforces
 * PKCE on the token exchange instead.
 */
export async function register(
  metadata: AuthServerMetadata,
  params: RegisterParams,
  options?: RegisterOptions,
): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const body = {
    client_name: params.clientName,
    redirect_uris: [params.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: params.scopes.join(" "),
    token_endpoint_auth_method: "none",
  };
  let res: Response;
  try {
    res = await fetchImpl(metadata.registration_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthHelperError(
      `Dynamic Client Registration failed: ${msg}`,
      "registration_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await describeOAuthErrorBody(res);
    throw new OAuthHelperError(
      `Dynamic Client Registration returned ${res.status}${detail ? `: ${detail}` : ""}`,
      "registration_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new OAuthHelperError(
      `Dynamic Client Registration response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "registration_failed",
      { cause: err },
    );
  })) as Partial<{ client_id: string }>;
  if (typeof data.client_id !== "string" || data.client_id.length === 0) {
    throw new OAuthHelperError(
      `Dynamic Client Registration response missing client_id`,
      "registration_failed",
    );
  }
  return data.client_id;
}
