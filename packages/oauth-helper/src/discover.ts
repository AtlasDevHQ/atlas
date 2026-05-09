import { OAuthHelperError } from "./errors";
import { FETCH_TIMEOUT_MS } from "./_internal/http";

/**
 * Subset of RFC 8414 server metadata Atlas's flow consumes. Better Auth's
 * discovery doc carries more fields (`userinfo_endpoint`,
 * `revocation_endpoint`, etc.); none of them are load-bearing for the
 * loopback / popup flows we drive from here, so the type stays narrow.
 */
export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  issuer: string;
}

export interface DiscoverOptions {
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Atlas pins its OAuth metadata under Better Auth's `/api/auth` mount.
 * `apiUrl` is the customer-visible API origin; the discovery doc is at
 * `${apiUrl}/.well-known/oauth-authorization-server/api/auth`.
 */
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server/api/auth";

export async function discover(
  apiUrl: string,
  options?: DiscoverOptions,
): Promise<AuthServerMetadata> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const url = `${apiUrl.replace(/\/+$/, "")}${DISCOVERY_PATH}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthHelperError(
      `Could not reach Atlas auth discovery at ${url}: ${msg}`,
      "discovery_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new OAuthHelperError(
      `Atlas auth discovery returned ${res.status} for ${url}`,
      "discovery_failed",
    );
  }
  const body = (await res.json().catch((err) => {
    throw new OAuthHelperError(
      `Atlas auth discovery body was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "discovery_failed",
      { cause: err },
    );
  })) as Partial<AuthServerMetadata>;

  if (
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.registration_endpoint !== "string" ||
    typeof body.issuer !== "string"
  ) {
    throw new OAuthHelperError(
      `Atlas auth discovery is missing one of: authorization_endpoint, token_endpoint, registration_endpoint, issuer`,
      "discovery_failed",
    );
  }
  return {
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    registration_endpoint: body.registration_endpoint,
    issuer: body.issuer,
  };
}
