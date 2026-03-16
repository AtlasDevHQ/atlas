/**
 * Bot Framework JWT verification.
 *
 * Verifies incoming requests are genuinely from Azure Bot Service by
 * validating the JWT in the Authorization header against Bot Framework's
 * OpenID-published JWKS endpoints.
 *
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { PluginLogger } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// OpenID metadata → JWKS endpoints
// ---------------------------------------------------------------------------

/**
 * Bot Framework OpenID metadata endpoint. Tokens from the Bot Connector
 * and Azure Bot Service are verified against keys published here.
 */
const BF_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/**
 * Azure AD v2.0 OpenID metadata (common tenant). Tokens from Teams
 * channel may use Azure AD issuers verified against these keys.
 */
const AAD_OPENID_URL =
  "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration";

// Cached JWKS resolvers — created lazily on first use
let bfJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let aadJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Fetch the jwks_uri from an OpenID metadata endpoint. */
async function fetchJwksUri(openIdUrl: string): Promise<string> {
  const resp = await fetch(openIdUrl, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    throw new Error(`OpenID metadata fetch failed: HTTP ${resp.status}`);
  }
  const metadata = (await resp.json()) as { jwks_uri?: string };
  if (!metadata.jwks_uri) {
    throw new Error("OpenID metadata missing jwks_uri");
  }
  return metadata.jwks_uri;
}

async function getBotFrameworkJWKS(): Promise<
  ReturnType<typeof createRemoteJWKSet>
> {
  if (!bfJWKS) {
    const jwksUri = await fetchJwksUri(BF_OPENID_URL);
    bfJWKS = createRemoteJWKSet(new URL(jwksUri));
  }
  return bfJWKS;
}

async function getAadJWKS(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!aadJWKS) {
    const jwksUri = await fetchJwksUri(AAD_OPENID_URL);
    aadJWKS = createRemoteJWKSet(new URL(jwksUri));
  }
  return aadJWKS;
}

// ---------------------------------------------------------------------------
// Known issuers
// ---------------------------------------------------------------------------

const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

/** Check whether an issuer is a recognized Azure AD issuer. */
function isAadIssuer(issuer: string): boolean {
  return (
    issuer.startsWith("https://sts.windows.net/") ||
    issuer.startsWith("https://login.microsoftonline.com/")
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { valid: true; claims: Record<string, unknown> }
  | { valid: false; error: string };

/**
 * Verify a Bot Framework JWT from the Authorization header.
 *
 * Checks the token against both Bot Framework and Azure AD JWKS endpoints,
 * validates the audience matches the app ID, and optionally restricts to
 * a specific Azure AD tenant.
 */
export async function verifyBotToken(
  authHeader: string | null,
  appId: string,
  tenantId?: string,
  log?: PluginLogger,
): Promise<VerifyResult> {
  if (!authHeader) {
    return { valid: false, error: "Missing Authorization header" };
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return { valid: false, error: "Invalid Authorization header format" };
  }

  const token = parts[1];

  // Try Bot Framework JWKS first, then Azure AD JWKS
  const jwksSources = [
    { name: "BotFramework", getter: getBotFrameworkJWKS },
    { name: "AzureAD", getter: getAadJWKS },
  ];

  for (const source of jwksSources) {
    try {
      const jwks = await source.getter();
      const { payload } = await jwtVerify(token, jwks, {
        audience: appId,
      });

      // Validate issuer
      const issuer = payload.iss ?? "";
      if (issuer !== BOT_FRAMEWORK_ISSUER && !isAadIssuer(issuer)) {
        continue; // Try next JWKS source
      }

      // Optional tenant restriction
      if (tenantId && payload.tid && payload.tid !== tenantId) {
        log?.warn(
          { expected: tenantId, got: payload.tid },
          "Token tenant ID mismatch",
        );
        return { valid: false, error: "Tenant ID mismatch" };
      }

      return { valid: true, claims: payload as Record<string, unknown> };
    } catch (err) {
      // JWSSignatureVerificationFailed or other jose errors — try next source
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        continue;
      }
      if (err instanceof joseErrors.JWTExpired) {
        return { valid: false, error: "Token expired" };
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        return {
          valid: false,
          error: `Token claim validation failed: ${err.message}`,
        };
      }
      // Network errors fetching JWKS — log and try next
      log?.warn(
        { source: source.name, err: err instanceof Error ? err.message : String(err) },
        "JWKS verification attempt failed",
      );
      continue;
    }
  }

  return { valid: false, error: "Token signature verification failed" };
}

/** Reset cached JWKS resolvers (for testing). */
export function resetJWKSCache(): void {
  bfJWKS = null;
  aadJWKS = null;
}
