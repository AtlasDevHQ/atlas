/**
 * Sandbox provider credential validation.
 *
 * Each function hits the real provider API to verify that the supplied
 * credentials are valid. Returns a discriminated union indicating
 * success (with display name) or failure (with error message).
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("sandbox-validate");

export type ValidationResult =
  | { valid: true; displayName: string }
  | { valid: false; error: string };

/** Timeout for provider API validation calls (10 seconds). */
const VALIDATION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// URL safety (SSRF prevention)
// ---------------------------------------------------------------------------

/**
 * Validates that a user-supplied URL is safe for server-side requests.
 * Blocks non-HTTPS schemes and private/internal hostnames.
 */
function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (host.startsWith("10.") || host.startsWith("192.168.")) return false;
    if (host.startsWith("169.254.")) return false; // AWS metadata
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

export async function validateVercelCredentials(
  accessToken: string,
  teamId: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid access token — check your Vercel token permissions" };
      }
      if (status === 404) {
        return { valid: false, error: "Team not found — verify your Team ID" };
      }
      return { valid: false, error: `Vercel API returned ${status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { name?: string };
    return { valid: true, displayName: data.name ?? teamId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Vercel credential validation failed");
    return { valid: false, error: `Could not reach Vercel API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// E2B
// ---------------------------------------------------------------------------

export async function validateE2BCredentials(
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.e2b.dev/sandboxes", {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid API key — check your E2B API key" };
      }
      return { valid: false, error: `E2B API returned ${status}` };
    }
    return { valid: true, displayName: "E2B" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "E2B credential validation failed");
    return { valid: false, error: `Could not reach E2B API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Daytona
// ---------------------------------------------------------------------------

export async function validateDaytonaCredentials(
  apiKey: string,
  apiUrl?: string,
): Promise<ValidationResult> {
  const base = apiUrl ?? "https://api.daytona.io";

  // Validate user-supplied URL to prevent SSRF
  if (apiUrl && !isSafeExternalUrl(apiUrl)) {
    return { valid: false, error: "API URL must use HTTPS and point to a public hostname" };
  }

  try {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid API key — check your Daytona API key" };
      }
      return { valid: false, error: `Daytona API returned ${status}` };
    }
    return { valid: true, displayName: apiUrl ? `Daytona (${apiUrl})` : "Daytona Cloud" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Daytona credential validation failed");
    return { valid: false, error: `Could not reach Daytona API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function validateCredentials(
  provider: string,
  credentials: Record<string, unknown>,
): Promise<ValidationResult> {
  switch (provider) {
    case "vercel": {
      const accessToken = credentials.accessToken;
      const teamId = credentials.teamId;
      if (typeof accessToken !== "string" || !accessToken) {
        return { valid: false, error: "Access token is required" };
      }
      if (typeof teamId !== "string" || !teamId) {
        return { valid: false, error: "Team ID is required" };
      }
      return validateVercelCredentials(accessToken, teamId);
    }
    case "e2b": {
      const apiKey = credentials.apiKey;
      if (typeof apiKey !== "string" || !apiKey) {
        return { valid: false, error: "API key is required" };
      }
      return validateE2BCredentials(apiKey);
    }
    case "daytona": {
      const apiKey = credentials.apiKey;
      if (typeof apiKey !== "string" || !apiKey) {
        return { valid: false, error: "API key is required" };
      }
      const apiUrl = typeof credentials.apiUrl === "string" ? credentials.apiUrl : undefined;
      return validateDaytonaCredentials(apiKey, apiUrl);
    }
    default:
      return { valid: false, error: `Unknown sandbox provider: ${provider}` };
  }
}
