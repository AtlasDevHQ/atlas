/**
 * Enterprise SSO provider management.
 *
 * CRUD for per-organization SAML/OIDC identity providers,
 * domain-based auto-provisioning, and DNS TXT domain ownership
 * verification. Every CRUD function calls `requireEnterprise("sso")`
 * — unlicensed deployments get a clear error. Validation helpers
 * and domain-matching functions do not require a license.
 */

import { Effect } from "effect";
import { EEError } from "../lib/errors";
import { generateVerificationToken, verifyDnsTxt } from "../lib/domain-verification";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
  encryptUrl,
  decryptUrl,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  SSOProvider,
  SSOProviderType,
  SSOSamlConfig,
  SSOOidcConfig,
  SSOTestResult,
  SSOOidcTestDetails,
  SSOSamlTestDetails,
  CreateSSOProviderRequest,
  UpdateSSOProviderRequest,
} from "@useatlas/types";
import { SSO_PROVIDER_TYPES } from "@useatlas/types";

const log = createLogger("ee:sso");

// ── Typed errors ────────────────────────────────────────────────────

export type SSOErrorCode = "not_found" | "conflict" | "validation";

export class SSOError extends EEError<SSOErrorCode> {
  readonly name = "SSOError";
}

// ── Internal row shape ──────────────────────────────────────────────

interface SSOProviderRow {
  id: string;
  org_id: string;
  type: string;
  issuer: string;
  domain: string;
  enabled: boolean;
  sso_enforced: boolean;
  config: string | Record<string, unknown>;
  created_at: string;
  updated_at: string;
  verification_token: string | null;
  domain_verified: boolean;
  domain_verified_at: string | null;
  domain_verification_status: string;
  // Index signature required by internalQuery<T extends Record<string, unknown>>
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToProvider(row: SSOProviderRow): SSOProvider {
  const rawConfig = typeof row.config === "string" ? JSON.parse(row.config) : row.config;

  // Validate type on read — guards against DB corruption / bad migrations
  if (!isValidSSOProviderType(row.type)) {
    throw new Error(`SSO provider ${row.id} has invalid type "${row.type}" in database`);
  }

  // Decrypt OIDC client secret if present — redact on failure, never leak ciphertext
  const config = { ...rawConfig };
  if (row.type === "oidc" && config.clientSecret) {
    try {
      config.clientSecret = decryptUrl(config.clientSecret as string);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), providerId: row.id },
        "Failed to decrypt OIDC clientSecret — redacting",
      );
      config.clientSecret = "[REDACTED]";
    }
  }

  // Validate config shape on read
  const configError = validateProviderConfig(row.type, config);
  if (configError) {
    log.warn({ providerId: row.id, type: row.type }, `SSO provider has invalid config in database: ${configError}`);
  }

  const base = {
    id: row.id,
    orgId: row.org_id,
    issuer: row.issuer,
    domain: row.domain.toLowerCase(),
    enabled: row.enabled,
    ssoEnforced: row.sso_enforced ?? false,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    verificationToken: row.verification_token ?? null,
    domainVerified: row.domain_verified ?? false,
    domainVerifiedAt: row.domain_verified_at ? String(row.domain_verified_at) : null,
    domainVerificationStatus: (row.domain_verification_status ?? "pending") as "pending" | "verified" | "failed",
  };

  if (row.type === "saml") {
    return { ...base, type: "saml", config: config as SSOSamlConfig };
  }
  return { ...base, type: "oidc", config: config as SSOOidcConfig };
}

/**
 * Strip secrets from an SSO provider before returning in API responses.
 * OIDC clientSecret is redacted; SAML certificates are public and left as-is.
 */
export function redactProvider(provider: SSOProvider): SSOProvider {
  if (provider.type === "oidc") {
    return {
      ...provider,
      config: { ...provider.config, clientSecret: "****" },
    };
  }
  return provider;
}

/** Summary view for list endpoints — omits full config to reduce payload. */
export function summarizeProvider(provider: SSOProvider): Omit<SSOProvider, "config"> {
  const { config: _config, ...rest } = provider;
  return rest;
}

/** Encrypt sensitive fields in config before storage. */
function prepareConfigForStorage(type: SSOProviderType, config: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...config };
  if (type === "oidc" && stored.clientSecret) {
    const encrypted = encryptUrl(stored.clientSecret as string);
    if (encrypted === stored.clientSecret) {
      log.warn("OIDC clientSecret stored without encryption — set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
    }
    stored.clientSecret = encrypted;
  }
  return stored;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

// ── Validation ──────────────────────────────────────────────────────

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(normalizeDomain(domain));
}

export function isValidSSOProviderType(type: string): type is SSOProviderType {
  return (SSO_PROVIDER_TYPES as readonly string[]).includes(type);
}

export function validateSamlConfig(config: unknown): config is SSOSamlConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.idpEntityId === "string" && c.idpEntityId.length > 0 &&
    typeof c.idpSsoUrl === "string" && c.idpSsoUrl.length > 0 &&
    typeof c.idpCertificate === "string" && c.idpCertificate.length > 0
  );
}

export function validateOidcConfig(config: unknown): config is SSOOidcConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.clientId === "string" && c.clientId.length > 0 &&
    typeof c.clientSecret === "string" && c.clientSecret.length > 0 &&
    typeof c.discoveryUrl === "string" && c.discoveryUrl.length > 0
  );
}

export function validateProviderConfig(type: SSOProviderType, config: unknown): string | null {
  if (type === "saml") {
    if (!validateSamlConfig(config)) {
      return "SAML config requires idpEntityId, idpSsoUrl, and idpCertificate.";
    }
  } else if (type === "oidc") {
    if (!validateOidcConfig(config)) {
      return "OIDC config requires clientId, clientSecret, and discoveryUrl.";
    }
  }
  return null;
}

// ── Domain verification ─────────────────────────────────────────────

// Re-export for consumers that import from sso.ts
export { generateVerificationToken } from "../lib/domain-verification";

/**
 * Verify domain ownership by checking DNS TXT records for the verification token.
 * Returns immediately if the domain is already verified. On DNS lookup failure,
 * sets status to 'failed' rather than throwing. Updates the provider's
 * verification status in the database.
 */
export const verifyDomain = (
  providerId: string,
  orgId: string,
): Effect.Effect<{ status: string; message: string }, SSOError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    yield* requireInternalDBEffect("SSO domain verification");

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<SSOProviderRow>(
        `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
         FROM sso_providers
         WHERE id = $1 AND org_id = $2`,
        [providerId, orgId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (rows.length === 0) {
      return yield* Effect.fail(new SSOError("SSO provider not found.", "not_found"));
    }

    const provider = rows[0];
    if (!provider.verification_token) {
      return yield* Effect.fail(new SSOError("No verification token configured for this provider.", "validation"));
    }

    if (provider.domain_verified) {
      return { status: "verified", message: "Domain is already verified." };
    }

    const dnsResult = yield* verifyDnsTxt(provider.domain, provider.verification_token);

    if (!dnsResult.ok) {
      log.warn({ providerId, domain: provider.domain, reason: dnsResult.reason }, "SSO domain DNS verification failed");
      yield* Effect.tryPromise({
        try: () => internalQuery(
          `UPDATE sso_providers SET domain_verification_status = 'failed', updated_at = now() WHERE id = $1 AND org_id = $2`,
          [providerId, orgId],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ providerId, err: err.message }, "Failed to persist domain verification failure status");
        return Effect.void;
      }));

      return {
        status: "failed",
        message: dnsResult.reason === "no_match"
          ? dnsResult.message
          : `DNS lookup failed for ${provider.domain}. Check your DNS configuration and try again.`,
      };
    }

    yield* Effect.tryPromise({
      try: () => internalQuery(
        `UPDATE sso_providers
         SET domain_verified = true, domain_verified_at = now(), domain_verification_status = 'verified', updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [providerId, orgId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.error({ providerId, domain: provider.domain, err: err.message }, "DNS verification succeeded but DB update failed");
      return Effect.fail(new SSOError("Domain verified via DNS but failed to persist — please retry.", "validation"));
    }));

    log.info({ providerId, domain: provider.domain }, "SSO domain verified via DNS TXT record");
    return { status: "verified", message: "Domain verified successfully." };
  });

/**
 * Check if a domain is available for SSO registration.
 * Requires an internal database — returns unavailable with reason if not configured.
 */
export const checkDomainAvailability = (
  domain: string,
  orgId: string,
): Effect.Effect<{ available: boolean; reason?: string }, SSOError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");

    const normalized = normalizeDomain(domain);
    if (!isValidDomain(normalized)) {
      return { available: false, reason: "Invalid domain format." };
    }

    if (!hasInternalDB()) {
      return { available: false, reason: "Domain availability check unavailable — internal database not configured." };
    }

    const existing = yield* Effect.tryPromise({
      try: () => internalQuery<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM sso_providers WHERE domain = $1`,
        [normalized],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (existing.length === 0) {
      return { available: true };
    }

    if (existing[0].org_id === orgId) {
      return { available: false, reason: "Domain is already registered by your organization." };
    }

    return { available: false, reason: "Domain is already registered by another organization." };
  });

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * List SSO providers for an organization.
 */
export const listSSOProviders = (orgId: string): Effect.Effect<SSOProvider[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    if (!hasInternalDB()) return [];

    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
       FROM sso_providers
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId],
    ));
    return rows.map(rowToProvider);
  });

/**
 * Get a single SSO provider by ID, scoped to org.
 */
export const getSSOProvider = (orgId: string, providerId: string): Effect.Effect<SSOProvider | null, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
       FROM sso_providers
       WHERE id = $1 AND org_id = $2`,
      [providerId, orgId],
    ));
    return rows[0] ? rowToProvider(rows[0]) : null;
  });

/**
 * Create a new SSO provider for an organization.
 * Validates config shape and domain uniqueness.
 */
export const createSSOProvider = (
  orgId: string,
  input: CreateSSOProviderRequest,
): Effect.Effect<SSOProvider, SSOError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    yield* requireInternalDBEffect("SSO provider management");

    // Validate type
    if (!isValidSSOProviderType(input.type)) {
      return yield* Effect.fail(new SSOError(`Invalid SSO provider type: ${input.type}. Must be one of: ${SSO_PROVIDER_TYPES.join(", ")}`, "validation"));
    }

    // Validate domain
    const domain = normalizeDomain(input.domain);
    if (!isValidDomain(domain)) {
      return yield* Effect.fail(new SSOError(`Invalid domain: ${input.domain}. Must be a valid domain name (e.g. "acme.com").`, "validation"));
    }

    // Validate config
    const configError = validateProviderConfig(input.type, input.config);
    if (configError) return yield* Effect.fail(new SSOError(configError, "validation"));

    // Check domain uniqueness
    const existing = yield* Effect.promise(() => internalQuery<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM sso_providers WHERE domain = $1`,
      [domain],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new SSOError(`Domain "${domain}" is already registered by another SSO provider.`, "conflict"));
    }

    const storedConfig = prepareConfigForStorage(input.type, input.config as unknown as Record<string, unknown>);

    // Generate verification token — provider cannot be enabled until domain is verified
    if (input.enabled) {
      log.info({ orgId, domain }, "SSO provider create requested enabled=true — overriding to false (domain verification required)");
    }
    const verificationToken = generateVerificationToken();

    // Cross-domain: check if the workspace has a verified custom domain for this domain
    const autoVerified = yield* Effect.gen(function* () {
      const mod = yield* Effect.tryPromise({
        try: () => import("../platform/domains"),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      const verified = yield* mod.hasVerifiedCustomDomain(orgId, domain);
      if (verified) log.info({ orgId, domain }, "SSO provider auto-verified via existing verified custom domain");
      return verified;
    }).pipe(
      Effect.catchAll((err) => {
        // Distinguish import failures (expected in AGPL builds) from runtime errors
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
          log.debug({ err: msg }, "Cross-domain verification unavailable — domains module not present");
        } else {
          log.warn({ orgId, domain, err: msg }, "Cross-domain auto-verification failed — SSO domain will require manual verification");
        }
        return Effect.succeed(false);
      }),
    );

    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `INSERT INTO sso_providers (org_id, type, issuer, domain, enabled, config, verification_token, domain_verified, domain_verified_at, domain_verification_status)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, CASE WHEN $7 = true THEN now() ELSE NULL END, $8)
       RETURNING id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status`,
      [orgId, input.type, input.issuer, domain, JSON.stringify(storedConfig), verificationToken, autoVerified, autoVerified ? "verified" : "pending"],
    ));

    if (!rows[0]) return yield* Effect.die(new Error("Failed to create SSO provider — no row returned."));

    log.info({ orgId, type: input.type, domain, issuer: input.issuer, autoVerified }, "SSO provider created");
    return rowToProvider(rows[0]);
  });

/**
 * Update an existing SSO provider.
 */
export const updateSSOProvider = (
  orgId: string,
  providerId: string,
  input: UpdateSSOProviderRequest,
): Effect.Effect<SSOProvider, SSOError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    yield* requireInternalDBEffect("SSO provider management");

    // Fetch existing
    const existing = yield* getSSOProvider(orgId, providerId);
    if (!existing) return yield* Effect.fail(new SSOError("SSO provider not found.", "not_found"));

    // Build update fields
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (input.issuer !== undefined) {
      sets.push(`issuer = $${paramIdx++}`);
      params.push(input.issuer);
    }

    let domainChanged = false;
    if (input.domain !== undefined) {
      const domain = normalizeDomain(input.domain);
      if (!isValidDomain(domain)) {
        return yield* Effect.fail(new SSOError(`Invalid domain: ${input.domain}. Must be a valid domain name.`, "validation"));
      }
      // Check uniqueness (exclude current provider)
      const clash = yield* Effect.promise(() => internalQuery<{ id: string }>(
        `SELECT id FROM sso_providers WHERE domain = $1 AND id != $2`,
        [domain, providerId],
      ));
      if (clash.length > 0) {
        return yield* Effect.fail(new SSOError(`Domain "${domain}" is already registered by another SSO provider.`, "conflict"));
      }
      sets.push(`domain = $${paramIdx++}`);
      params.push(domain);

      // Domain changed — reset verification
      if (domain !== existing.domain) {
        domainChanged = true;
        const newToken = generateVerificationToken();
        sets.push(`verification_token = $${paramIdx++}`);
        params.push(newToken);
        sets.push(`domain_verified = false`);
        sets.push(`domain_verified_at = NULL`);
        sets.push(`domain_verification_status = 'pending'`);
        // Force disable when domain changes
        sets.push(`enabled = false`);
      }
    }

    if (input.enabled !== undefined && !domainChanged) {
      // Block enabling when domain is not verified
      if (input.enabled && !existing.domainVerified) {
        return yield* Effect.fail(new SSOError(
          "Cannot enable SSO provider until domain is verified. Verify domain ownership first.",
          "validation",
        ));
      }
      sets.push(`enabled = $${paramIdx++}`);
      params.push(input.enabled);
    }

    if (input.config !== undefined) {
      // Merge partial config with existing
      const merged = { ...(existing.config as unknown as Record<string, unknown>), ...input.config };
      // Re-validate full config
      const configError = validateProviderConfig(existing.type, merged);
      if (configError) return yield* Effect.fail(new SSOError(configError, "validation"));

      const storedConfig = prepareConfigForStorage(existing.type, merged);
      sets.push(`config = $${paramIdx++}`);
      params.push(JSON.stringify(storedConfig));
    }

    if (sets.length === 0) {
      return existing; // Nothing to update
    }

    sets.push(`updated_at = now()`);
    params.push(providerId, orgId);

    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `UPDATE sso_providers SET ${sets.join(", ")}
       WHERE id = $${paramIdx++} AND org_id = $${paramIdx}
       RETURNING id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status`,
      params,
    ));

    if (!rows[0]) return yield* Effect.fail(new SSOError("SSO provider not found or update failed.", "not_found"));

    log.info({ orgId, providerId }, "SSO provider updated");
    return rowToProvider(rows[0]);
  });

/**
 * Delete an SSO provider.
 */
export const deleteSSOProvider = (orgId: string, providerId: string): Effect.Effect<boolean, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    if (!hasInternalDB()) return false;

    const pool = getInternalDB();
    const result = yield* Effect.promise(() =>
      pool.query(
        `DELETE FROM sso_providers WHERE id = $1 AND org_id = $2 RETURNING id`,
        [providerId, orgId],
      ),
    );

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId, providerId }, "SSO provider deleted");
    }
    return deleted;
  });

// ── Domain matching ─────────────────────────────────────────────────

/**
 * Find the SSO provider registered for the given email domain.
 * Returns the enabled provider, or null if no match / provider disabled.
 *
 * Does NOT call requireEnterprise — this is used during login flow
 * where the enterprise check happens upstream.
 */
export const findProviderByDomain = (emailDomain: string): Effect.Effect<SSOProvider | null> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return null;

    const domain = normalizeDomain(emailDomain);
    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
       FROM sso_providers
       WHERE domain = $1 AND enabled = true
       LIMIT 1`,
      [domain],
    ));

    return rows[0] ? rowToProvider(rows[0]) : null;
  });

// ── Test connection ─────────────────────────────────────────────────

// Re-export wire types so route modules can import from ee/auth/sso
export type { SSOTestResult, SSOOidcTestDetails, SSOSamlTestDetails } from "@useatlas/types";

const TEST_TIMEOUT_MS = 5_000;

/**
 * Validate that a URL is HTTPS (or HTTP in dev) before making outbound requests.
 * Blocks non-HTTP(S) schemes to prevent SSRF via file://, data://, etc.
 */
function validateTestUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return null;
    return `URL has unsupported protocol: ${parsed.protocol}`;
  } catch {
    // intentionally ignored: new URL() throws on malformed input — returned as validation error
    return `Not a valid URL: "${url}"`;
  }
}

/**
 * Test an OIDC provider by fetching its discovery document and validating
 * the required OpenID Connect fields.
 */
export async function testOidcProvider(provider: SSOProvider & { type: "oidc" }): Promise<SSOTestResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: SSOOidcTestDetails = {
    discoveryReachable: false,
    issuerMatch: false,
    requiredFieldsPresent: false,
    endpoints: {},
  };

  // Validate URL scheme before outbound request
  const urlError = validateTestUrl(provider.config.discoveryUrl);
  if (urlError) {
    errors.push(`Discovery URL: ${urlError}`);
    return { type: "oidc", success: false, testedAt: new Date().toISOString(), details, errors };
  }

  let discoveryJson: Record<string, unknown>;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(provider.config.discoveryUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      errors.push(`Discovery URL returned HTTP ${res.status}`);
      return { type: "oidc", success: false, testedAt: new Date().toISOString(), details, errors };
    }

    const contentType = res.headers.get("content-type") ?? "";

    let text: string;
    try {
      text = await res.text();
    } catch (bodyErr) {
      details.discoveryReachable = true;
      errors.push(`Discovery URL reachable but body could not be read: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)}`);
      return { type: "oidc", success: false, testedAt: new Date().toISOString(), details, errors };
    }

    try {
      discoveryJson = JSON.parse(text) as Record<string, unknown>;
    } catch (parseErr) {
      const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
      errors.push(`Discovery URL returned non-JSON body (${reason})` + (contentType ? ` (content-type: ${contentType})` : ""));
      return { type: "oidc", success: false, testedAt: new Date().toISOString(), details, errors };
    }
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      errors.push(`Discovery URL timed out after ${TEST_TIMEOUT_MS}ms`);
    } else {
      errors.push(`Failed to reach discovery URL: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { type: "oidc", success: false, testedAt: new Date().toISOString(), details, errors };
  }

  details.discoveryReachable = true;

  // Validate required OIDC discovery fields
  const requiredFields = ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const;
  const missingFields = requiredFields.filter((f) => typeof discoveryJson[f] !== "string" || (discoveryJson[f] as string).length === 0);
  details.requiredFieldsPresent = missingFields.length === 0;
  if (missingFields.length > 0) {
    errors.push(`Discovery document missing required fields: ${missingFields.join(", ")}`);
  }

  // Populate endpoints from discovery
  details.endpoints = Object.fromEntries(
    requiredFields.filter((f) => typeof discoveryJson[f] === "string").map((f) => [f, discoveryJson[f] as string]),
  );

  // Check issuer match
  if (typeof discoveryJson.issuer === "string") {
    details.issuerMatch = discoveryJson.issuer === provider.issuer;
    if (!details.issuerMatch) {
      errors.push(`Issuer mismatch: discovery has "${discoveryJson.issuer}", provider configured with "${provider.issuer}"`);
    }
  }

  return {
    type: "oidc",
    success: errors.length === 0,
    testedAt: new Date().toISOString(),
    details,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Test a SAML provider by parsing its X.509 certificate and checking
 * the IdP SSO URL reachability.
 */
export async function testSamlProvider(provider: SSOProvider & { type: "saml" }): Promise<SSOTestResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: SSOSamlTestDetails = {
    certValid: false,
    certSubject: null,
    certExpiry: null,
    certDaysRemaining: null,
    idpReachable: null,
  };

  // Parse and validate the PEM certificate
  try {
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(provider.config.idpCertificate);
    details.certValid = true;
    details.certSubject = cert.subject;

    const expiryDate = new Date(cert.validTo);
    if (isNaN(expiryDate.getTime())) {
      details.certExpiry = cert.validTo; // fallback to raw string if unparseable
      errors.push(`Could not parse certificate expiry date: "${cert.validTo}"`);
    } else {
      details.certExpiry = expiryDate.toISOString();
      const now = new Date();
      const daysRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      details.certDaysRemaining = daysRemaining;

      if (daysRemaining < 0) {
        errors.push(`Certificate expired ${Math.abs(daysRemaining)} day(s) ago`);
        details.certValid = false;
      } else if (daysRemaining < 30) {
        // Expiry warning — cert is still valid, so this is a warning not an error
        warnings.push(`Certificate expires in ${daysRemaining} day(s) — consider renewing soon`);
      }
    }
  } catch (err) {
    details.certValid = false;
    errors.push(`Malformed PEM certificate: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check IdP SSO URL reachability (validate URL scheme first)
  const idpUrlError = validateTestUrl(provider.config.idpSsoUrl);
  if (idpUrlError) {
    details.idpReachable = false;
    errors.push(`IdP SSO URL: ${idpUrlError}`);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const res = await fetch(provider.config.idpSsoUrl, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);
      // Any response (even 4xx) means the server is reachable.
      // Some IdPs return 405 for HEAD — that's still "reachable".
      details.idpReachable = true;
      if (res.status >= 500) {
        errors.push(`IdP SSO URL returned server error (HTTP ${res.status})`);
      }
    } catch (err) {
      clearTimeout(timer);
      details.idpReachable = false;
      if (err instanceof DOMException && err.name === "AbortError") {
        errors.push(`IdP SSO URL timed out after ${TEST_TIMEOUT_MS}ms`);
      } else {
        errors.push(`IdP SSO URL unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Success is determined solely by certificate validity — expiry warnings (< 30 days)
  // and IdP reachability failures do not fail the test.
  return {
    type: "saml",
    success: details.certValid,
    testedAt: new Date().toISOString(),
    details,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Test an SSO provider's configuration. Requires enterprise license.
 * Looks up the provider by org + ID (fails with SSOError if not found),
 * then dispatches to the OIDC or SAML test based on provider type.
 */
export const testSSOProvider = (
  orgId: string,
  providerId: string,
): Effect.Effect<SSOTestResult, SSOError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");

    const provider = yield* getSSOProvider(orgId, providerId);
    if (!provider) {
      return yield* Effect.fail(new SSOError("SSO provider not found.", "not_found"));
    }

    if (provider.type === "oidc") {
      return yield* Effect.tryPromise({
        try: () => testOidcProvider(provider),
        catch: (err) => new SSOError(
          `OIDC test failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          "validation",
        ),
      });
    }
    return yield* Effect.tryPromise({
      try: () => testSamlProvider(provider),
      catch: (err) => new SSOError(
        `SAML test failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        "validation",
      ),
    });
  });

// ── Domain matching ─────────────────────────────────────────────────

/**
 * Extract the domain part from an email address.
 * Returns null for invalid addresses.
 */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

// ── SSO enforcement ──────────────────────────────────────────────────

export type SSOEnforcementErrorCode = "no_provider" | "not_enterprise";

export class SSOEnforcementError extends EEError<SSOEnforcementErrorCode> {
  readonly name = "SSOEnforcementError";
}

/**
 * Check whether SSO is enforced for the given organization.
 * Returns the enforced provider info (with redirect URL) or null if not enforced.
 *
 * Does NOT call requireEnterprise — this is used during the login flow
 * to block password auth. Enterprise gating happens on the admin toggle.
 */
export const isSSOEnforced = (orgId: string): Effect.Effect<{
  enforced: boolean;
  provider?: SSOProvider;
  ssoRedirectUrl?: string;
} | null> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
       FROM sso_providers
       WHERE org_id = $1 AND enabled = true AND sso_enforced = true
       LIMIT 1`,
      [orgId],
    ));

    if (!rows[0]) return { enforced: false };

    const provider = rowToProvider(rows[0]);
    const ssoRedirectUrl = provider.type === "saml"
      ? provider.config.idpSsoUrl
      : provider.config.discoveryUrl;

    if (!ssoRedirectUrl) {
      log.error(
        { providerId: provider.id, type: provider.type },
        "SSO enforcement active but provider has no redirect URL configured",
      );
    }

    return { enforced: true, provider, ssoRedirectUrl };
  });

/**
 * Check SSO enforcement by email domain — used in the login middleware
 * to block password auth when the user's email domain has SSO enforced.
 *
 * Does NOT call requireEnterprise — this runs in the login flow.
 */
export const isSSOEnforcedForDomain = (emailDomain: string): Effect.Effect<{
  enforced: boolean;
  provider?: SSOProvider;
  ssoRedirectUrl?: string;
} | null> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return null;

    const domain = normalizeDomain(emailDomain);
    const rows = yield* Effect.promise(() => internalQuery<SSOProviderRow>(
      `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at, verification_token, domain_verified, domain_verified_at, domain_verification_status
       FROM sso_providers
       WHERE domain = $1 AND enabled = true AND sso_enforced = true
       LIMIT 1`,
      [domain],
    ));

    if (!rows[0]) return { enforced: false };

    const provider = rowToProvider(rows[0]);
    const ssoRedirectUrl = provider.type === "saml"
      ? provider.config.idpSsoUrl
      : provider.config.discoveryUrl;

    if (!ssoRedirectUrl) {
      log.error(
        { providerId: provider.id, type: provider.type },
        "SSO enforcement active but provider has no redirect URL configured",
      );
    }

    return { enforced: true, provider, ssoRedirectUrl };
  });

/**
 * Set SSO enforcement for an organization.
 * Requires enterprise license and at least one active (enabled) SSO provider.
 */
export const setSSOEnforcement = (orgId: string, enforced: boolean): Effect.Effect<{ enforced: boolean; orgId: string }, SSOEnforcementError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("sso");
    yield* requireInternalDBEffect("SSO enforcement");

    if (enforced) {
      // Verify at least one active SSO provider exists for this org
      const active = yield* Effect.promise(() => internalQuery<{ id: string }>(
        `SELECT id FROM sso_providers WHERE org_id = $1 AND enabled = true LIMIT 1`,
        [orgId],
      ));
      if (active.length === 0) {
        return yield* Effect.fail(new SSOEnforcementError(
          "Cannot enforce SSO without at least one active SSO provider. Create and enable a SAML or OIDC provider first.",
          "no_provider",
        ));
      }
    }

    // Update all providers for this org (enforcement is org-level)
    const updated = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `UPDATE sso_providers SET sso_enforced = $1, updated_at = now() WHERE org_id = $2 RETURNING id`,
      [enforced, orgId],
    ));

    if (enforced && updated.length === 0) {
      return yield* Effect.fail(new SSOEnforcementError(
        "No SSO providers were updated. Providers may have been deleted.",
        "no_provider",
      ));
    }

    log.info({ orgId, enforced }, "SSO enforcement %s", enforced ? "enabled" : "disabled");
    return { enforced, orgId };
  });
