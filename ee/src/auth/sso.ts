/**
 * Enterprise SSO provider management.
 *
 * CRUD for per-organization SAML/OIDC identity providers and
 * domain-based auto-provisioning. Every CRUD function calls
 * `requireEnterprise("sso")` — unlicensed deployments get a clear error.
 * Validation helpers and domain-matching functions do not require a license.
 */

import { requireEnterprise } from "../index";
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
  CreateSSOProviderRequest,
  UpdateSSOProviderRequest,
} from "@useatlas/types";
import { SSO_PROVIDER_TYPES } from "@useatlas/types";

const log = createLogger("ee:sso");

// ── Typed errors ────────────────────────────────────────────────────

export type SSOErrorCode = "not_found" | "conflict" | "validation";

export class SSOError extends Error {
  constructor(message: string, public readonly code: SSOErrorCode) {
    super(message);
    this.name = "SSOError";
  }
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

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * List SSO providers for an organization.
 */
export async function listSSOProviders(orgId: string): Promise<SSOProvider[]> {
  requireEnterprise("sso");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<SSOProviderRow>(
    `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at
     FROM sso_providers
     WHERE org_id = $1
     ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(rowToProvider);
}

/**
 * Get a single SSO provider by ID, scoped to org.
 */
export async function getSSOProvider(orgId: string, providerId: string): Promise<SSOProvider | null> {
  requireEnterprise("sso");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<SSOProviderRow>(
    `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at
     FROM sso_providers
     WHERE id = $1 AND org_id = $2`,
    [providerId, orgId],
  );
  return rows[0] ? rowToProvider(rows[0]) : null;
}

/**
 * Create a new SSO provider for an organization.
 * Validates config shape and domain uniqueness.
 */
export async function createSSOProvider(
  orgId: string,
  input: CreateSSOProviderRequest,
): Promise<SSOProvider> {
  requireEnterprise("sso");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for SSO provider management.");
  }

  // Validate type
  if (!isValidSSOProviderType(input.type)) {
    throw new SSOError(`Invalid SSO provider type: ${input.type}. Must be one of: ${SSO_PROVIDER_TYPES.join(", ")}`, "validation");
  }

  // Validate domain
  const domain = normalizeDomain(input.domain);
  if (!isValidDomain(domain)) {
    throw new SSOError(`Invalid domain: ${input.domain}. Must be a valid domain name (e.g. "acme.com").`, "validation");
  }

  // Validate config
  const configError = validateProviderConfig(input.type, input.config);
  if (configError) throw new SSOError(configError, "validation");

  // Check domain uniqueness
  const existing = await internalQuery<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM sso_providers WHERE domain = $1`,
    [domain],
  );
  if (existing.length > 0) {
    throw new SSOError(`Domain "${domain}" is already registered by another SSO provider.`, "conflict");
  }

  const storedConfig = prepareConfigForStorage(input.type, input.config as unknown as Record<string, unknown>);

  const rows = await internalQuery<SSOProviderRow>(
    `INSERT INTO sso_providers (org_id, type, issuer, domain, enabled, config)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at`,
    [orgId, input.type, input.issuer, domain, input.enabled ?? false, JSON.stringify(storedConfig)],
  );

  if (!rows[0]) throw new Error("Failed to create SSO provider — no row returned.");

  log.info({ orgId, type: input.type, domain, issuer: input.issuer }, "SSO provider created");
  return rowToProvider(rows[0]);
}

/**
 * Update an existing SSO provider.
 */
export async function updateSSOProvider(
  orgId: string,
  providerId: string,
  input: UpdateSSOProviderRequest,
): Promise<SSOProvider> {
  requireEnterprise("sso");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for SSO provider management.");
  }

  // Fetch existing
  const existing = await getSSOProvider(orgId, providerId);
  if (!existing) throw new SSOError("SSO provider not found.", "not_found");

  // Build update fields
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (input.issuer !== undefined) {
    sets.push(`issuer = $${paramIdx++}`);
    params.push(input.issuer);
  }

  if (input.domain !== undefined) {
    const domain = normalizeDomain(input.domain);
    if (!isValidDomain(domain)) {
      throw new SSOError(`Invalid domain: ${input.domain}. Must be a valid domain name.`, "validation");
    }
    // Check uniqueness (exclude current provider)
    const clash = await internalQuery<{ id: string }>(
      `SELECT id FROM sso_providers WHERE domain = $1 AND id != $2`,
      [domain, providerId],
    );
    if (clash.length > 0) {
      throw new SSOError(`Domain "${domain}" is already registered by another SSO provider.`, "conflict");
    }
    sets.push(`domain = $${paramIdx++}`);
    params.push(domain);
  }

  if (input.enabled !== undefined) {
    sets.push(`enabled = $${paramIdx++}`);
    params.push(input.enabled);
  }

  if (input.config !== undefined) {
    // Merge partial config with existing
    const merged = { ...(existing.config as unknown as Record<string, unknown>), ...input.config };
    // Re-validate full config
    const configError = validateProviderConfig(existing.type, merged);
    if (configError) throw new SSOError(configError, "validation");

    const storedConfig = prepareConfigForStorage(existing.type, merged);
    sets.push(`config = $${paramIdx++}`);
    params.push(JSON.stringify(storedConfig));
  }

  if (sets.length === 0) {
    return existing; // Nothing to update
  }

  sets.push(`updated_at = now()`);
  params.push(providerId, orgId);

  const rows = await internalQuery<SSOProviderRow>(
    `UPDATE sso_providers SET ${sets.join(", ")}
     WHERE id = $${paramIdx++} AND org_id = $${paramIdx}
     RETURNING id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at`,
    params,
  );

  if (!rows[0]) throw new SSOError("SSO provider not found or update failed.", "not_found");

  log.info({ orgId, providerId }, "SSO provider updated");
  return rowToProvider(rows[0]);
}

/**
 * Delete an SSO provider.
 */
export async function deleteSSOProvider(orgId: string, providerId: string): Promise<boolean> {
  requireEnterprise("sso");
  if (!hasInternalDB()) return false;

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM sso_providers WHERE id = $1 AND org_id = $2 RETURNING id`,
    [providerId, orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId, providerId }, "SSO provider deleted");
  }
  return deleted;
}

// ── Domain matching ─────────────────────────────────────────────────

/**
 * Find the SSO provider registered for the given email domain.
 * Returns the enabled provider, or null if no match / provider disabled.
 *
 * Does NOT call requireEnterprise — this is used during login flow
 * where the enterprise check happens upstream.
 */
export async function findProviderByDomain(emailDomain: string): Promise<SSOProvider | null> {
  if (!hasInternalDB()) return null;

  const domain = normalizeDomain(emailDomain);
  const rows = await internalQuery<SSOProviderRow>(
    `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at
     FROM sso_providers
     WHERE domain = $1 AND enabled = true
     LIMIT 1`,
    [domain],
  );

  return rows[0] ? rowToProvider(rows[0]) : null;
}

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

export class SSOEnforcementError extends Error {
  constructor(message: string, public readonly code: SSOEnforcementErrorCode) {
    super(message);
    this.name = "SSOEnforcementError";
  }
}

/**
 * Check whether SSO is enforced for the given organization.
 * Returns the enforced provider info (with redirect URL) or null if not enforced.
 *
 * Does NOT call requireEnterprise — this is used during the login flow
 * to block password auth. Enterprise gating happens on the admin toggle.
 */
export async function isSSOEnforced(orgId: string): Promise<{
  enforced: boolean;
  provider?: SSOProvider;
  ssoRedirectUrl?: string;
} | null> {
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<SSOProviderRow>(
    `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at
     FROM sso_providers
     WHERE org_id = $1 AND enabled = true AND sso_enforced = true
     LIMIT 1`,
    [orgId],
  );

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
}

/**
 * Check SSO enforcement by email domain — used in the login middleware
 * to block password auth when the user's email domain has SSO enforced.
 *
 * Does NOT call requireEnterprise — this runs in the login flow.
 */
export async function isSSOEnforcedForDomain(emailDomain: string): Promise<{
  enforced: boolean;
  provider?: SSOProvider;
  ssoRedirectUrl?: string;
} | null> {
  if (!hasInternalDB()) return null;

  const domain = normalizeDomain(emailDomain);
  const rows = await internalQuery<SSOProviderRow>(
    `SELECT id, org_id, type, issuer, domain, enabled, sso_enforced, config, created_at, updated_at
     FROM sso_providers
     WHERE domain = $1 AND enabled = true AND sso_enforced = true
     LIMIT 1`,
    [domain],
  );

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
}

/**
 * Set SSO enforcement for an organization.
 * Requires enterprise license and at least one active (enabled) SSO provider.
 */
export async function setSSOEnforcement(orgId: string, enforced: boolean): Promise<{ enforced: boolean; orgId: string }> {
  requireEnterprise("sso");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for SSO enforcement.");
  }

  if (enforced) {
    // Verify at least one active SSO provider exists for this org
    const active = await internalQuery<{ id: string }>(
      `SELECT id FROM sso_providers WHERE org_id = $1 AND enabled = true LIMIT 1`,
      [orgId],
    );
    if (active.length === 0) {
      throw new SSOEnforcementError(
        "Cannot enforce SSO without at least one active SSO provider. Create and enable a SAML or OIDC provider first.",
        "no_provider",
      );
    }
  }

  // Update all providers for this org (enforcement is org-level)
  const updated = await internalQuery<{ id: string }>(
    `UPDATE sso_providers SET sso_enforced = $1, updated_at = now() WHERE org_id = $2 RETURNING id`,
    [enforced, orgId],
  );

  if (enforced && updated.length === 0) {
    throw new SSOEnforcementError(
      "No SSO providers were updated. Providers may have been deleted.",
      "no_provider",
    );
  }

  log.info({ orgId, enforced }, "SSO enforcement %s", enforced ? "enabled" : "disabled");
  return { enforced, orgId };
}
