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

import { Effect } from "effect";
import { EEError } from "../lib/errors";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { CustomDomain, CertificateStatus } from "@useatlas/types";
import { DOMAIN_STATUSES, CERTIFICATE_STATUSES } from "@useatlas/types";

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

export class DomainError extends EEError<DomainErrorCode> {
  readonly name = "DomainError";
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Validates that a domain looks like a valid hostname (no protocol, no path). */
function isValidDomain(domain: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

function requireDB(): Effect.Effect<void, DomainError | Error> {
  return requireInternalDBEffect("custom domains", () => new DomainError("Internal database is required for custom domains.", "no_internal_db"));
}

/** Coerce a DB value (Date or string) to an ISO 8601 string. Throws on null/undefined/unexpected types. */
function toISOString(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new DomainError(
    `rowToDomain: expected Date or ISO string for "${field}", got ${value === null ? "null" : typeof value}`,
    "data_integrity",
  );
}

/** Map a DB row to a CustomDomain wire type. Validates status and certificate_status against known enums; other fields are defensively coerced. */
function rowToDomain(row: Record<string, unknown>): CustomDomain {
  const id = row.id;
  if (id == null || String(id) === "") {
    throw new DomainError(`rowToDomain: missing required field "id"`, "data_integrity");
  }

  const status = String(row.status ?? "");
  if (!DOMAIN_STATUSES.includes(status as CustomDomain["status"])) {
    throw new DomainError(
      `rowToDomain: unexpected status "${status}" — expected one of ${DOMAIN_STATUSES.join(", ")}`,
      "data_integrity",
    );
  }

  const certRaw = row.certificate_status != null ? String(row.certificate_status) : null;
  if (certRaw != null && !CERTIFICATE_STATUSES.includes(certRaw as CertificateStatus)) {
    throw new DomainError(
      `rowToDomain: unexpected certificate_status "${certRaw}" — expected one of ${CERTIFICATE_STATUSES.join(", ")}`,
      "data_integrity",
    );
  }

  return {
    id: String(id),
    workspaceId: String(row.workspace_id ?? ""),
    domain: String(row.domain ?? ""),
    status: status as CustomDomain["status"],
    railwayDomainId: row.railway_domain_id != null ? String(row.railway_domain_id) : null,
    cnameTarget: row.cname_target != null ? String(row.cname_target) : null,
    certificateStatus: certRaw as CertificateStatus | null,
    createdAt: toISOString(row.created_at, "created_at"),
    verifiedAt: row.verified_at != null ? toISOString(row.verified_at, "verified_at") : null,
  };
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
    throw new DomainError(
      "Railway API is not configured. Set RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_WEB_SERVICE_ID.",
      "railway_not_configured",
    );
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
        return new DomainError(
          "Could not reach Railway API. Check network connectivity and RAILWAY_API_TOKEN.",
          "railway_error",
        );
      },
    });

    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text());
      log.error({ status: response.status, body: text.slice(0, 500) }, "Railway API HTTP error");
      return yield* Effect.fail(new DomainError(
        `Railway API returned ${response.status}`,
        "railway_error",
      ));
    }

    const json = (yield* Effect.promise(() => response.json())) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      log.error({ errors: json.errors }, "Railway API GraphQL errors");
      return yield* Effect.fail(new DomainError(`Railway API error: ${msg}`, "railway_error"));
    }

    if (!json.data) {
      return yield* Effect.fail(new DomainError("Railway API returned no data", "railway_error"));
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
      return yield* Effect.fail(new DomainError(
        `Invalid domain "${domain}". Provide a valid hostname (e.g. data.example.com).`,
        "invalid_domain",
      ));
    }

    // Check for existing registration in our DB
    const existing = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(
      `SELECT id FROM custom_domains WHERE domain = $1`,
      [normalized],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new DomainError(
        `Domain "${normalized}" is already registered.`,
        "duplicate_domain",
      ));
    }

    const config = getRailwayConfig();

    // Check availability with Railway
    const availability = yield* checkDomainAvailable(config, normalized);
    if (!availability.available) {
      return yield* Effect.fail(new DomainError(
        `Domain "${normalized}" is not available: ${availability.message}`,
        "duplicate_domain",
      ));
    }

    // Create domain in Railway
    const railwayDomain = yield* createRailwayDomain(config, normalized);
    const cnameTarget = railwayDomain.status.dnsRecords[0]?.requiredValue ?? null;

    // Store in Atlas internal DB — roll back Railway domain on failure
    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<Record<string, unknown>>(
        `INSERT INTO custom_domains (workspace_id, domain, railway_domain_id, cname_target, certificate_status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [workspaceId, normalized, railwayDomain.id, cnameTarget, railwayDomain.status.certificateStatus],
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
      return yield* Effect.fail(new DomainError(
        `Domain with ID "${domainId}" not found.`,
        "domain_not_found",
      ));
    }

    const record = rowToDomain(rows[0]);

    if (!record.railwayDomainId) {
      return yield* Effect.fail(new DomainError(
        `Domain "${record.domain}" has no Railway domain ID — registration may have been incomplete.`,
        "railway_error",
      ));
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
      return yield* Effect.fail(new DomainError(
        `Domain "${domainId}" was deleted during verification.`,
        "domain_not_found",
      ));
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
      return yield* Effect.fail(new DomainError(
        `Domain with ID "${domainId}" not found.`,
        "domain_not_found",
      ));
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
