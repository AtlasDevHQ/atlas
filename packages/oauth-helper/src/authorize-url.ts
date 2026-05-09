export interface BuildAuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Joined with " " into the canonical space-delimited `scope` parameter. */
  scopes: ReadonlyArray<string>;
}

/**
 * Pure URL construction — no I/O. Returns the consent URL the user-agent
 * navigates to. The caller decides how to surface the URL (popup, tab,
 * loopback browser launch, terminal print) — this helper is transport-
 * agnostic.
 *
 * `code_challenge_method` is hardcoded to `S256`; OAuth 2.1 forbids the
 * `plain` method.
 */
export function buildAuthorizationUrl(params: BuildAuthorizationUrlParams): string {
  const search = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  const sep = params.authorizationEndpoint.includes("?") ? "&" : "?";
  return `${params.authorizationEndpoint}${sep}${search.toString()}`;
}
