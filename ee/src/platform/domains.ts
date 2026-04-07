/**
 * Enterprise custom domains — workspace-level custom domain support via Railway.
 *
 * Orchestrates Railway's custom domain GraphQL API for provisioning and
 * TLS certificate management, and stores domain→workspace mappings in
 * the Atlas internal DB for host-based routing.
 *
 * Access-gated via platformAdminAuth middleware (platform_admin role
 * required). `resolveWorkspaceByHost` returns null gracefully when not
 * configured (used in request routing).
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 *
 * Required env vars:
 * - RAILWAY_API_TOKEN — workspace-scoped Railway API token
 * - RAILWAY_PROJECT_ID — Railway project ID
 * - RAILWAY_ENVIRONMENT_ID — Railway environment ID (production)
 * - RAILWAY_WEB_SERVICE_ID — Railway service ID for the web service
 */

import { Data, Effect } from "effect";
import { generateVerificationToken, verifyDnsTxt } from "../lib/domain-verification";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { CustomDomain, CertificateStatus, DomainVerificationStatus } from "@useatlas/types";
import { DOMAIN_STATUSES, CERTIFICATE_STATUSES, DOMAIN_VERIFICATION_STATUSES } from "@useatlas/types";

const log = createLogger("ee:domains");

// ── Typed errors ────────────────────────────────────────────────────

export type DomainErrorCode =
  | "no_internal_db"
  | "invalid_domain"
  | "duplicate_domain"
  | "domain_not_found"
  | "railway_error"
  | "railway_not_configured"
  | "data_integrity";

export class DomainError extends Data.TaggedError("DomainError")<{
  message: string;
  code: DomainErrorCode;
}> {}

// ── Helpers ─────────────────────────────────────────────────────────

/** Validates that a domain looks like a valid hostname (no protocol, no path). */
function isValidDomain(domain: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

function requireDB(): Effect.Effect<void, DomainError | Error> {
  return requireInternalDBEffect("custom domains", () => new DomainError({ message: "Internal database is required for custom domains.", code: "no_internal_db" }));
}

/** Coerce a DB value (Date or string) to an ISO 8601 string. Throws on null/undefined/unexpected types. */
function toISOString(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new DomainError({ message: `rowToDomain: expected Date or ISO string for "${field}", got ${value === null ? "null" : typeof value}`, code: "data_integrity" });
}

/** Map a DB row to a CustomDomain wire type. Validates status and certificate_status against known enums; other fields are defensively coerced. */
function rowToDomain(row: Record<string, unknown>): CustomDomain {
  const id = row.id;
  if (id == null || String(id) === "") {
    throw new DomainError({ message: `rowToDomain: missing required field "id"`, code: "data_integrity" });
  }

  const status = String(row.status ?? "");
  if (!DOMAIN_STATUSES.includes(status as CustomDomain["status"])) {
    throw new DomainError({ message: `rowToDomain: unexpected status "${status}" — expected one of ${DOMAIN_STATUSES.join(", ")}`, code: "data_integrity" });
  }

  const certRaw = row.certificate_status != null ? String(row.certificate_status) : null;
  if (certRaw != null && !CERTIFICATE_STATUSES.includes(certRaw as CertificateStatus)) {
    throw new DomainError({ message: `rowToDomain: unexpected certificate_status "${certRaw}" — expected one of ${CERTIFICATE_STATUSES.join(", ")}`, code: "data_integrity" });
  }

  // Default to "pending" for pre-migration rows that lack the column
  const verificationStatusRaw = row.domain_verification_status != null ? String(row.domain_verification_status) : "pending";
  if (!DOMAIN_VERIFICATION_STATUSES.includes(verificationStatusRaw as DomainVerificationStatus)) {
    throw new DomainError({ message: `rowToDomain: unexpected domain_verification_status "${verificationStatusRaw}" — expected one of ${DOMAIN_VERIFICATION_STATUSES.join(", ")}`, code: "data_integrity" });
  }
  const domainVerificationStatus = verificationStatusRaw as DomainVerificationStatus;

  return {
    id: String(id),
    workspaceId: String(row.workspace_id ?? ""),
    domain: String(row.domain ?? ""),
    status: status as CustomDomain["status"],
    railwayDomainId: row.railway_domain_id != null ? String(row.railway_domain_id) : null,
    cnameTarget: row.cname_target != null ? String(row.cname_target) : null,
    certificateStatus: certRaw as CertificateStatus | null,
    verificationToken: row.verification_token != null ? String(row.verification_token) : null,
    domainVerified: row.domain_verified === true || row.domain_verified === "true",
    domainVerifiedAt: row.domain_verified_at != null ? toISOString(row.domain_verified_at, "domain_verified_at") : null,
    domainVerificationStatus,
    createdAt: toISOString(row.created_at, "created_at"),
    verifiedAt: row.verified_at != null ? toISOString(row.verified_at, "verified_at") : null,
  };
}

/**
 * Redact the verification token from a CustomDomain before returning in API responses.
 * Returns the full token only when `includeToken` is true (used at registration time).
 */
export function redactDomain(domain: CustomDomain, includeToken = false): CustomDomain {
  if (includeToken || !domain.verificationToken) return domain;
  return { ...domain, verificationToken: domain.verificationToken.slice(0, 13) + "..." };
}

// ── Railway GraphQL client ──────────────────────────────────────────

interface RailwayConfig {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
}

function getRailwayConfig(): RailwayConfig {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId = process.env.RAILWAY_WEB_SERVICE_ID;

  if (!token || !projectId || !environmentId || !serviceId) {
    throw new DomainError({ message: "Railway API is not configured. Set RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_WEB_SERVICE_ID.", code: "railway_not_configured" });
  }

  return { token, projectId, environmentId, serviceId };
}

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

const railwayGraphQL = <T>(
  config: RailwayConfig,
  query: string,
  variables: Record<string, unknown>,
): Effect.Effect<T, DomainError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(RAILWAY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ query, variables }),
      }),
      catch: (err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Railway API network error — could not reach backboard.railway.com",
        );
        return new DomainError({ message: "Could not reach Railway API. Check network connectivity and RAILWAY_API_TOKEN.", code: "railway_error" });
      },
    });

    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text());
      log.error({ status: response.status, body: text.slice(0, 500) }, "Railway API HTTP error");
      return yield* Effect.fail(new DomainError({ message: `Railway API returned ${response.status}`, code: "railway_error" }));
    }

    const json = (yield* Effect.promise(() => response.json())) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      log.error({ errors: json.errors }, "Railway API GraphQL errors");
      return yield* Effect.fail(new DomainError({ message: `Railway API error: ${msg}`, code: "railway_error" }));
    }

    if (!json.data) {
      return yield* Effect.fail(new DomainError({ message: "Railway API returned no data", code: "railway_error" }));
    }

    return json.data;
  });

// ── Railway operations ──────────────────────────────────────────────

const checkDomainAvailable = (config: RailwayConfig, domain: string): Effect.Effect<{ available: boolean; message: string }, DomainError> =>
  railwayGraphQL<{ customDomainAvailable: { available: boolean; message: string } }>(
    config,
    `query ($domain: String!) {
      customDomainAvailable(domain: $domain) {
        available
        message
      }
    }`,
    { domain },
  ).pipe(Effect.map((data) => data.customDomainAvailable));

interface RailwayDomainCreateResult {
  customDomainCreate: {
    id: string;
    domain: string;
    status: {
      dnsRecords: Array<{ requiredValue: string; currentValue: string | null; status: string }>;
      certificateStatus: string;
    };
  };
}

const createRailwayDomain = (config: RailwayConfig, domain: string): Effect.Effect<RailwayDomainCreateResult["customDomainCreate"], DomainError> =>
  railwayGraphQL<RailwayDomainCreateResult>(
    config,
    `mutation ($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) {
        id
        domain
        status {
          dnsRecords {
            requiredValue
            currentValue
            status
          }
          certificateStatus
        }
      }
    }`,
    {
      input: {
        projectId: config.projectId,
        environmentId: config.environmentId,
        serviceId: config.serviceId,
        domain,
      },
    },
  ).pipe(Effect.map((data) => data.customDomainCreate));

interface RailwayDomainStatusResult {
  customDomain: {
    id: string;
    domain: string;
    status: {
      dnsRecords: Array<{ requiredValue: string; currentValue: string | null; status: string }>;
      certificateStatus: string;
    };
  };
}

const getRailwayDomainStatus = (config: RailwayConfig, railwayDomainId: string): Effect.Effect<RailwayDomainStatusResult["customDomain"], DomainError> =>
  railwayGraphQL<RailwayDomainStatusResult>(
    config,
    `query ($id: String!, $projectId: String!) {
      customDomain(id: $id, projectId: $projectId) {
        id
        domain
        status {
          dnsRecords {
            requiredValue
            currentValue
            status
          }
          certificateStatus
        }
      }
    }`,
    { id: railwayDomainId, projectId: config.projectId },
  ).pipe(Effect.map((data) => data.customDomain));

const deleteRailwayDomain = (config: RailwayConfig, railwayDomainId: string): Effect.Effect<void, DomainError> =>
  railwayGraphQL<{ customDomainDelete: boolean }>(
    config,
    `mutation ($id: String!) {
      customDomainDelete(id: $id)
    }`,
    { id: railwayDomainId },
  ).pipe(Effect.asVoid);

// ── Host resolution cache (60s TTL) ────────────────────────────────

const CACHE_TTL_MS = 60_000;
const hostCache = new Map<string, { workspaceId: string; expiresAt: number }>();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Register a custom domain for a workspace.
 * Checks availability with Railway, creates the domain, stores the mapping.
 */
export const registerDomain = (
  workspaceId: string,
  domain: string,
): Effect.Effect<CustomDomain, DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const normalized = domain.toLowerCase().trim();
    if (!isValidDomain(normalized)) {
      return yield* Effect.fail(new DomainError({ message: `Invalid domain "${domain}". Provide a valid hostname (e.g. data.example.com).`, code: "invalid_domain" }));
    }

    // Check for existing registration in our DB
    const existing = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT id FROM custom_domains WHERE domain = $1`,
      [normalized],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${normalized}" is already registered.`, code: "duplicate_domain" }));
    }

    const config = getRailwayConfig();

    // Check availability with Railway
    const availability = yield* checkDomainAvailable(config, normalized);
    if (!availability.available) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${normalized}" is not available: ${availability.message}`, code: "duplicate_domain" }));
    }

    // Create domain in Railway
    const railwayDomain = yield* createRailwayDomain(config, normalized);
    const cnameTarget = railwayDomain.status.dnsRecords[0]?.requiredValue ?? null;

    // Generate DNS TXT verification token for domain ownership proof
    const verificationToken = generateVerificationToken();

    // Store in Atlas internal DB — roll back Railway domain on failure
    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<Record<string, unknown>>(
        `INSERT INTO custom_domains (workspace_id, domain, railway_domain_id, cname_target, certificate_status, verification_token)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [workspaceId, normalized, railwayDomain.id, cnameTarget, railwayDomain.status.certificateStatus, verificationToken],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.catchAll((err) =>
        // Roll back Railway domain to avoid orphaned resources
        deleteRailwayDomain(config, railwayDomain.id).pipe(
          Effect.tap(() => {
            log.warn({ railwayDomainId: railwayDomain.id }, "Rolled back Railway domain after DB insert failure");
          }),
          Effect.catchAll((rollbackErr) => {
            log.error(
              { railwayDomainId: railwayDomain.id, err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) },
              "Failed to roll back Railway domain — orphaned domain in Railway",
            );
            return Effect.void;
          }),
          Effect.flatMap(() => Effect.fail(err)),
        ),
      ),
    );

    log.info({ workspaceId, domain: normalized, railwayDomainId: railwayDomain.id }, "Custom domain registered");
    return rowToDomain(rows[0]);
  });

/**
 * Verify a custom domain by checking Railway for DNS + cert status.
 *
 * Queries Railway's `customDomain` endpoint once to check DNS propagation
 * and certificate provisioning. Updates local status accordingly.
 * Invalidates the host resolution cache on successful verification.
 */
export const verifyDomain = (domainId: string): Effect.Effect<CustomDomain, DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT * FROM custom_domains WHERE id = $1`,
      [domainId],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain with ID "${domainId}" not found.`, code: "domain_not_found" }));
    }

    const record = rowToDomain(rows[0]);

    if (!record.railwayDomainId) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${record.domain}" has no Railway domain ID — registration may have been incomplete.`, code: "railway_error" }));
    }

    const config = getRailwayConfig();
    const railwayStatus = yield* getRailwayDomainStatus(config, record.railwayDomainId!);

    const certRaw = String(railwayStatus.status.certificateStatus ?? "");
    let certStatus: CertificateStatus;
    if (CERTIFICATE_STATUSES.includes(certRaw as CertificateStatus)) {
      certStatus = certRaw as CertificateStatus;
    } else {
      log.warn(
        { domainId, railwayCertificateStatus: certRaw, knownStatuses: [...CERTIFICATE_STATUSES] },
        "Railway returned unrecognized certificate status — falling back to PENDING",
      );
      certStatus = "PENDING";
    }
    const dnsReady = railwayStatus.status.dnsRecords.every((r) => r.status === "VALID" || r.status === "valid");
    const verified = certStatus === "ISSUED" && dnsReady;

    const newStatus = verified ? "verified" : (certStatus === "FAILED" ? "failed" : "pending");
    const updatedRows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `UPDATE custom_domains
       SET status = $1,
           certificate_status = $2,
           verified_at = CASE WHEN $1 = 'verified' THEN now() ELSE verified_at END
       WHERE id = $3
       RETURNING *`,
      [newStatus, certStatus, domainId],
    ));

    if (updatedRows.length === 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${domainId}" was deleted during verification.`, code: "domain_not_found" }));
    }

    if (verified) {
      log.info({ domainId, domain: record.domain }, "Custom domain verified");
      // Invalidate cache for this domain
      hostCache.delete(record.domain);
    } else {
      log.info({ domainId, domain: record.domain, certStatus, dnsReady }, "Custom domain verification checked — not yet verified");
    }

    return rowToDomain(updatedRows[0]);
  });

/**
 * List all custom domains for a workspace.
 */
export const listDomains = (workspaceId: string): Effect.Effect<CustomDomain[], DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT * FROM custom_domains WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    ));

    return rows.map(rowToDomain);
  });

/**
 * List all custom domains across all workspaces (platform admin view).
 */
export const listAllDomains = (): Effect.Effect<CustomDomain[], DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT * FROM custom_domains ORDER BY created_at DESC`,
      [],
    ));

    return rows.map(rowToDomain);
  });

/**
 * Delete a custom domain from both Railway and Atlas DB.
 */
export const deleteDomain = (domainId: string): Effect.Effect<void, DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT * FROM custom_domains WHERE id = $1`,
      [domainId],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain with ID "${domainId}" not found.`, code: "domain_not_found" }));
    }

    const record = rowToDomain(rows[0]);

    // Delete from Railway if we have a domain ID
    if (record.railwayDomainId) {
      const config = getRailwayConfig();
      yield* deleteRailwayDomain(config, record.railwayDomainId).pipe(
        Effect.catchAll((err) => {
          log.warn(
            { domainId, railwayDomainId: record.railwayDomainId, err: err instanceof Error ? err.message : String(err) },
            "Failed to delete domain from Railway — proceeding with local deletion",
          );
          return Effect.void;
        }),
      );
    }

    // Delete from Atlas DB
    yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `DELETE FROM custom_domains WHERE id = $1`,
      [domainId],
    ));

    // Invalidate cache
    hostCache.delete(record.domain);

    log.info({ domainId, domain: record.domain }, "Custom domain deleted");
  });

/**
 * Verify domain ownership via DNS TXT record lookup.
 *
 * Checks for the expected `atlas-verify=<uuid>` TXT record on the domain.
 * Updates local verification status. On success, also auto-verifies any
 * SSO provider for the same domain in the same workspace (cross-domain verification).
 *
 * This is additive to Railway's CNAME verification — DNS TXT proves ownership,
 * Railway CNAME proves DNS routing.
 */
export const verifyDomainDnsTxt = (domainId: string): Effect.Effect<CustomDomain, DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<Record<string, unknown>>(
        `SELECT * FROM custom_domains WHERE id = $1`,
        [domainId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (rows.length === 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain with ID "${domainId}" not found.`, code: "domain_not_found" }));
    }

    const record = rowToDomain(rows[0]);

    if (!record.verificationToken) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${record.domain}" has no verification token — it may have been created before DNS TXT verification was available.`, code: "data_integrity" }));
    }

    if (record.domainVerified) {
      return record;
    }

    const dnsResult = yield* verifyDnsTxt(record.domain, record.verificationToken);

    if (!dnsResult.ok) {
      log.warn({ domainId, domain: record.domain, reason: dnsResult.reason }, "Custom domain DNS TXT verification failed");
      yield* Effect.tryPromise({
        try: () => internalQuery(
          `UPDATE custom_domains SET domain_verification_status = 'failed' WHERE id = $1`,
          [domainId],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ domainId, err: err.message }, "Failed to persist domain verification failure status");
        return Effect.void;
      }));

      // Return record reflecting actual DNS result, even if the persist failed
      return { ...record, domainVerificationStatus: "failed" as const };
    }

    // DNS TXT verified — update status
    yield* Effect.tryPromise({
      try: () => internalQuery(
        `UPDATE custom_domains
         SET domain_verified = true, domain_verified_at = now(), domain_verification_status = 'verified'
         WHERE id = $1`,
        [domainId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.error({ domainId, domain: record.domain, err: err.message }, "DNS TXT verification succeeded but DB update failed");
      return Effect.fail(new DomainError({ message: "Domain verified via DNS but failed to persist — please retry.", code: "data_integrity" }));
    }));

    log.info({ domainId, domain: record.domain }, "Custom domain verified via DNS TXT record");

    // Cross-domain: auto-verify SSO provider for the same domain + workspace
    yield* autoVerifySSODomain(record.workspaceId, record.domain);

    const updatedRows = yield* Effect.tryPromise({
      try: () => internalQuery<Record<string, unknown>>(
        `SELECT * FROM custom_domains WHERE id = $1`,
        [domainId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (updatedRows.length === 0) {
      return yield* Effect.fail(new DomainError({ message: `Domain "${domainId}" was deleted during verification.`, code: "domain_not_found" }));
    }

    return rowToDomain(updatedRows[0]);
  });

/**
 * Check if a domain is available for custom domain registration.
 * Returns availability status and reason if unavailable.
 */
export const checkDomainAvailability = (
  domain: string,
  workspaceId: string,
): Effect.Effect<{ available: boolean; reason?: string }, DomainError | Error> =>
  Effect.gen(function* () {
    yield* requireDB();

    const normalized = domain.toLowerCase().trim();
    if (!isValidDomain(normalized)) {
      return { available: false, reason: "Invalid domain format." };
    }

    const existing = yield* Effect.tryPromise({
      try: () => internalQuery<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM custom_domains WHERE domain = $1`,
        [normalized],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    if (existing.length === 0) {
      return { available: true };
    }

    if (existing[0].workspace_id === workspaceId) {
      return { available: false, reason: "Domain is already registered by your workspace." };
    }

    return { available: false, reason: "Domain is already registered by another workspace." };
  });

/**
 * Cross-domain auto-verification: when a custom domain is verified,
 * auto-mark any unverified SSO provider for the same domain in the same workspace as verified.
 * Logs a warning on failure — domain verification still succeeds.
 */
const autoVerifySSODomain = (workspaceId: string, domain: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return;

    yield* Effect.tryPromise({
      try: () => internalQuery(
        `UPDATE sso_providers
         SET domain_verified = true, domain_verified_at = now(), domain_verification_status = 'verified', updated_at = now()
         WHERE org_id = $1 AND LOWER(domain) = $2 AND domain_verified = false`,
        [workspaceId, domain.toLowerCase()],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.tap((updated) => {
        if (Array.isArray(updated) && updated.length > 0) {
          log.info({ workspaceId, domain }, "Cross-domain: auto-verified SSO provider via custom domain verification");
        }
        return Effect.void;
      }),
      Effect.catchAll((err) => {
        log.warn(
          { workspaceId, domain, err: err.message },
          "Cross-domain SSO auto-verification failed — SSO domain must be verified separately",
        );
        return Effect.void;
      }),
    );
  });

/**
 * Check if the workspace has a verified custom domain for the given domain.
 * Used by SSO provider creation to auto-verify domains.
 * Returns false if the internal DB is not configured.
 * Propagates DB errors through the Effect error channel.
 */
export const hasVerifiedCustomDomain = (
  workspaceId: string,
  domain: string,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return false;

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<{ id: string }>(
        `SELECT id FROM custom_domains WHERE workspace_id = $1 AND LOWER(domain) = $2 AND domain_verified = true LIMIT 1`,
        [workspaceId, domain.toLowerCase()],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    return rows.length > 0;
  });

/**
 * Resolve a hostname to a workspace ID via verified custom domains.
 *
 * Uses a 60-second in-memory cache to avoid DB lookups on every request.
 * Returns null if no verified domain matches or no internal DB configured.
 */
export const resolveWorkspaceByHost = (hostname: string): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return null;

    const normalized = hostname.toLowerCase().trim();

    // Check cache (empty string = negative cache entry)
    const cached = hostCache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.workspaceId || null;
    }

    return yield* Effect.promise(async () => {
      try {
        const rows = await internalQuery<{ workspace_id: string }>(
          `SELECT workspace_id FROM custom_domains WHERE domain = $1 AND status = 'verified' LIMIT 1`,
          [normalized],
        );

        if (rows.length > 0) {
          hostCache.set(normalized, { workspaceId: rows[0].workspace_id, expiresAt: Date.now() + CACHE_TTL_MS });
          return rows[0].workspace_id;
        }

        // Negative cache — avoid DB query on every request for non-custom-domain hostnames
        hostCache.set(normalized, { workspaceId: "", expiresAt: Date.now() + CACHE_TTL_MS });
        return null;
      } catch (err) {
        log.error(
          { hostname: normalized, err: err instanceof Error ? err.message : String(err) },
          "Failed to resolve custom domain — request will use default workspace routing",
        );
        return null;
      }
    });
  });

/** @internal Reset host resolution cache — for testing only. */
export function _resetHostCache(): void {
  hostCache.clear();
}
