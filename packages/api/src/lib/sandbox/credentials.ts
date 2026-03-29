/**
 * Sandbox credential storage.
 *
 * Stores per-org BYOC sandbox provider credentials (Vercel, E2B, Daytona)
 * in the internal database. Follows the same pattern as
 * `packages/api/src/lib/teams/store.ts`.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("sandbox-credentials");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SANDBOX_PROVIDERS = ["vercel", "e2b", "daytona"] as const;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

export interface SandboxCredential {
  id: string;
  orgId: string;
  provider: SandboxProvider;
  credentials: Record<string, unknown>;
  displayName: string | null;
  validatedAt: string | null;
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): SandboxCredential | null {
  const id = row.id;
  const orgId = row.org_id;
  const provider = row.provider;

  if (typeof id !== "string" || typeof orgId !== "string" || typeof provider !== "string") {
    log.warn(context, "Invalid sandbox_credentials record in database");
    return null;
  }

  let creds: Record<string, unknown>;
  if (typeof row.credentials === "string") {
    try {
      creds = JSON.parse(row.credentials) as Record<string, unknown>;
    } catch (err) {
      log.warn(
        { ...context, parseError: err instanceof Error ? err.message : String(err) },
        "Failed to parse sandbox credentials JSON — treating record as invalid",
      );
      return null;
    }
  } else if (row.credentials && typeof row.credentials === "object") {
    creds = row.credentials as Record<string, unknown>;
  } else {
    log.warn(context, "Missing credentials field in sandbox_credentials record");
    return null;
  }

  if (!SANDBOX_PROVIDERS.includes(provider as SandboxProvider)) {
    log.warn({ ...context, provider }, "Unknown sandbox provider in database record");
    return null;
  }

  return {
    id,
    orgId,
    provider: provider as SandboxProvider,
    credentials: creds,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    validatedAt: typeof row.validated_at === "string" ? row.validated_at : null,
    connectedAt: typeof row.connected_at === "string" ? row.connected_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get all connected sandbox providers for an org.
 */
export async function getSandboxCredentials(orgId: string): Promise<SandboxCredential[]> {
  if (!hasInternalDB()) return [];

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT id, org_id, provider, credentials, display_name,
              validated_at::text, connected_at::text
       FROM sandbox_credentials
       WHERE org_id = $1
       ORDER BY connected_at`,
      [orgId],
    );
    const results: SandboxCredential[] = [];
    for (const row of rows) {
      const parsed = parseRow(row, { orgId });
      if (parsed) results.push(parsed);
    }
    return results;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query sandbox_credentials",
    );
    throw err;
  }
}

/**
 * Get a single provider's credential for an org.
 */
export async function getSandboxCredentialByProvider(
  orgId: string,
  provider: string,
): Promise<SandboxCredential | null> {
  if (!hasInternalDB()) return null;

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT id, org_id, provider, credentials, display_name,
              validated_at::text, connected_at::text
       FROM sandbox_credentials
       WHERE org_id = $1 AND provider = $2`,
      [orgId, provider],
    );
    if (rows.length === 0) return null;
    return parseRow(rows[0], { orgId, provider });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, provider },
      "Failed to query sandbox_credentials by provider",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a sandbox provider credential (upsert).
 */
export async function saveSandboxCredential(
  orgId: string,
  provider: string,
  credentials: Record<string, unknown>,
  displayName?: string,
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save sandbox credentials — no internal database configured");
  }

  try {
    await internalQuery(
      `INSERT INTO sandbox_credentials (org_id, provider, credentials, display_name, validated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (org_id, provider) DO UPDATE SET
         credentials = $3,
         display_name = COALESCE($4, sandbox_credentials.display_name),
         validated_at = now()`,
      [orgId, provider, JSON.stringify(credentials), displayName ?? null],
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, provider },
      "Failed to save sandbox_credentials",
    );
    throw err;
  }
}

/**
 * Remove a sandbox provider credential.
 * Returns true if a row was deleted.
 */
export async function deleteSandboxCredential(
  orgId: string,
  provider: string,
): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete sandbox credentials — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ id: string }>(
      "DELETE FROM sandbox_credentials WHERE org_id = $1 AND provider = $2 RETURNING id",
      [orgId, provider],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, provider },
      "Failed to delete sandbox_credentials",
    );
    throw err;
  }
}
