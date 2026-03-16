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

// Cached JWKS resolvers with TTL — re-fetched periodically to handle key rotation.
// jose's createRemoteJWKSet handles individual key rotation (kid mismatch → refetch),
// but the OpenID metadata jwks_uri itself could change, so we re-resolve periodically.
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface JWKSCacheEntry {
  resolver: ReturnType<typeof createRemoteJWKSet>;
  fetchedAt: number;
}

let bfJWKS: JWKSCacheEntry | null = null;
let aadJWKS: JWKSCacheEntry | null = null;

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

function isCacheValid(entry: JWKSCacheEntry | null): entry is JWKSCacheEntry {
  return entry !== null && Date.now() - entry.fetchedAt < JWKS_CACHE_TTL_MS;
}

async function getBotFrameworkJWKS(): Promise<
  ReturnType<typeof createRemoteJWKSet>
> {
  if (!isCacheValid(bfJWKS)) {
    const jwksUri = await fetchJwksUri(BF_OPENID_URL);
    bfJWKS = { resolver: createRemoteJWKSet(new URL(jwksUri)), fetchedAt: Date.now() };
  }
  return bfJWKS.resolver;
}

async function getAadJWKS(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!isCacheValid(aadJWKS)) {
    const jwksUri = await fetchJwksUri(AAD_OPENID_URL);
    aadJWKS = { resolver: createRemoteJWKSet(new URL(jwksUri)), fetchedAt: Date.now() };
  }
  return aadJWKS.resolver;
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

      // Validate issuer — reject immediately if unrecognized after successful signature check
      const issuer = payload.iss ?? "";
      if (issuer !== BOT_FRAMEWORK_ISSUER && !isAadIssuer(issuer)) {
        return { valid: false, error: `Unrecognized token issuer: ${issuer}` };
      }

      // Tenant restriction — reject if tenantId is configured but token has wrong or missing tid
      if (tenantId) {
        if (!payload.tid) {
          log?.warn(
            { expected: tenantId },
            "Token missing tid claim but tenant restriction is configured",
          );
          return { valid: false, error: "Token missing tenant ID claim" };
        }
        if (payload.tid !== tenantId) {
          log?.warn(
            { expected: tenantId, got: payload.tid },
            "Token tenant ID mismatch",
          );
          return { valid: false, error: "Tenant ID mismatch" };
        }
      }

      return { valid: true, claims: payload as Record<string, unknown> };
    } catch (err) {
      // Signature mismatch or no matching key — try next JWKS source
      if (
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWKSNoMatchingKey
      ) {
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
      // Network errors fetching JWKS or unexpected errors — log and try next
      log?.warn(
        {
          source: source.name,
          errorType: err?.constructor?.name,
          err: err instanceof Error ? err.message : String(err),
        },
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
