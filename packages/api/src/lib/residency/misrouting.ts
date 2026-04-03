/**
 * Cross-region request misrouting detection.
 *
 * Each Atlas API instance knows its own region via ATLAS_API_REGION (or
 * residency.defaultRegion from config). When a request arrives from a
 * workspace assigned to a different region, the middleware logs a warning
 * and increments a counter. With strict routing enabled, misrouted
 * requests receive 421 Misdirected Request.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";

const log = createLogger("misrouting");

// ── In-memory counter ──────────────────────────────────────────────

let misroutedCount = 0;

/** Number of misrouted requests detected since process start. */
export function getMisroutedCount(): number {
  return misroutedCount;
}

/** @internal Reset counter — for testing only. */
export function _resetMisroutedCount(): void {
  misroutedCount = 0;
}

// ── Region cache (orgId → region) ──────────────────────────────────

interface CacheEntry {
  region: string | null;
  expiresAt: number;
}

const regionCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function getCachedRegion(orgId: string): string | null | undefined {
  const cached = regionCache.get(orgId);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAt) {
    regionCache.delete(orgId);
    return undefined;
  }
  return cached.region;
}

function setCachedRegion(orgId: string, region: string | null): void {
  regionCache.set(orgId, { region, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** @internal Reset region cache — for testing only. */
export function _resetRegionCache(): void {
  regionCache.clear();
}

// ── API region identity ────────────────────────────────────────────

/**
 * Get the region identity of this API instance.
 *
 * Resolution order:
 * 1. `ATLAS_API_REGION` env var (explicit per-instance override)
 * 2. `residency.defaultRegion` from atlas.config.ts (shared config fallback)
 * 3. `null` — no region configured (self-hosted compatibility, check is skipped)
 */
export function getApiRegion(): string | null {
  const envRegion = process.env.ATLAS_API_REGION;
  if (envRegion) return envRegion;
  const config = getConfig();
  return config?.residency?.defaultRegion ?? null;
}

// ── Strict routing flag ────────────────────────────────────────────

/**
 * Whether strict routing mode is enabled.
 *
 * In strict mode, misrouted requests receive 421 Misdirected Request
 * with a `correctApiUrl` hint. In graceful mode (default), requests
 * are served normally but the mismatch is logged.
 *
 * Controlled by `residency.strictRouting` in config or
 * `ATLAS_STRICT_ROUTING=true` env var.
 */
export function isStrictRoutingEnabled(): boolean {
  if (process.env.ATLAS_STRICT_ROUTING === "true") return true;
  const config = getConfig();
  return config?.residency?.strictRouting ?? false;
}

// ── Misrouting result ──────────────────────────────────────────────

export interface MisroutingResult {
  readonly expectedRegion: string;
  readonly actualRegion: string;
  readonly correctApiUrl?: string;
}

// ── Detection ──────────────────────────────────────────────────────

/**
 * Detect whether a request is misrouted to the wrong regional API instance.
 *
 * Returns a `MisroutingResult` when the workspace's assigned region
 * doesn't match this instance's region. Returns `null` when:
 * - No orgId (unauthenticated or no org context)
 * - No region configured on this instance (self-hosted)
 * - Workspace has no region assigned yet
 * - Regions match (correct routing)
 * - Region lookup fails (logged as warning, request continues)
 */
export async function detectMisrouting(
  orgId: string | undefined,
  requestId: string,
): Promise<MisroutingResult | null> {
  if (!orgId) return null;

  const apiRegion = getApiRegion();
  if (!apiRegion) return null;

  // Check cache first, then DB
  let workspaceRegion = getCachedRegion(orgId);
  if (workspaceRegion === undefined) {
    try {
      const { getWorkspaceRegion } = await import("@atlas/api/lib/db/internal");
      workspaceRegion = await getWorkspaceRegion(orgId);
      setCachedRegion(orgId, workspaceRegion);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), requestId, orgId },
        "Failed to look up workspace region — skipping misrouting check",
      );
      return null;
    }
  }

  // No region assigned → skip (new workspace, not yet assigned)
  if (!workspaceRegion) return null;

  // Region matches → all good
  if (workspaceRegion === apiRegion) return null;

  // Mismatch detected
  misroutedCount++;

  const config = getConfig();
  const correctApiUrl = config?.residency?.regions[workspaceRegion]?.apiUrl;

  log.warn(
    {
      requestId,
      orgId,
      expectedRegion: workspaceRegion,
      actualRegion: apiRegion,
      correctApiUrl,
    },
    "Misrouted request — workspace assigned to different region",
  );

  return {
    expectedRegion: workspaceRegion,
    actualRegion: apiRegion,
    ...(correctApiUrl ? { correctApiUrl } : {}),
  };
}
