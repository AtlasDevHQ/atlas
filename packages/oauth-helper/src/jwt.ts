import { OAuthHelperError } from "./errors";

/**
 * Decode a JWT payload WITHOUT verifying the signature. Safe ONLY when
 * called from a flow that has already (a) validated the token endpoint
 * as https + verified TLS to the discovered issuer, and (b) calls
 * `enforceIssuer` on the decoded payload before trusting any other
 * claim. The hosted MCP endpoint re-verifies the signature on every
 * request via JWKS, so any tampering between here and there is rejected
 * server-side.
 *
 * Do NOT lift this helper out as a generic JWT decoder — without the
 * surrounding flow's TLS + issuer guarantees, "decode without verify"
 * is unsafe.
 */
export function decodeJwtPayload(jwtToken: string): Record<string, unknown> {
  const parts = jwtToken.split(".");
  if (parts.length !== 3) {
    throw new OAuthHelperError(
      `Access token is not a JWT (expected 3 parts, got ${parts.length})`,
      "malformed_jwt",
    );
  }
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new OAuthHelperError(
      `Could not decode JWT payload: ${err instanceof Error ? err.message : String(err)}`,
      "malformed_jwt",
      { cause: err },
    );
  }
}

/**
 * Defense-in-depth: if the discovered issuer doesn't match the JWT's
 * `iss` claim, the auth server returned a token "for" a different
 * issuer. That's either a server bug or a discovery-redirection attack;
 * either way, refuse to trust it.
 */
export function enforceIssuer(
  payload: Record<string, unknown>,
  expectedIssuer: string,
): void {
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new OAuthHelperError(
      `Access token has no \`iss\` claim — refusing to trust an unsigned-issuer token.`,
      "issuer_mismatch",
    );
  }
  if (iss !== expectedIssuer) {
    throw new OAuthHelperError(
      `Access token issuer mismatch: discovered \`${expectedIssuer}\`, token claims \`${iss}\`.`,
      "issuer_mismatch",
    );
  }
}
