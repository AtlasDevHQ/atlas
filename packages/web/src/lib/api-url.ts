/**
 * Pre-auth regional API base resolution (ADR-0024 §3–§4).
 *
 * The browser must target its workspace's regional API *before* any
 * authenticated call. Region is therefore a signal the browser knows up
 * front — a region selection during signup, or the `atlas_region` cookie on
 * a returning visit — never something it learns by first calling the US API.
 * (The retired path did exactly that: it discovered the regional host from
 * the US admin-settings response, which only worked while data was wrongly
 * readable from US. ADR-0024 deletes that circular dependency.)
 *
 * Resolution order for getApiUrl():
 *   1. An active region signal — a selection this session, or the
 *      `atlas_region` cookie restored on load → that region's apiUrl.
 *   2. Otherwise the build-time default (NEXT_PUBLIC_ATLAS_API_URL), which is
 *      empty on self-hosted → same-origin, unaffected by any of this.
 *
 * The `atlas_region` cookie persists `{ region, apiUrl }` so the regional
 * base survives reloads with no network round-trip, and the region key seeds
 * the login fast-path (it short-circuits the front-door region fan-out).
 */

const DEFAULT_API_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");

/** Cookie persisting the selected region + its resolved API base. */
export const REGION_COOKIE = "atlas_region";

/** 1 year — region rarely changes; a returning user keeps the fast-path. */
const REGION_COOKIE_MAX_AGE = 31_536_000;

/** A region selection projected onto the API base it resolves to. */
export interface RegionSignal {
  /** Region identifier (e.g. "eu") — seeds the login fast-path. */
  region: string;
  /** Resolved regional API base (e.g. "https://api-eu.useatlas.dev"). */
  apiUrl: string;
}

/**
 * Active region signal — a selection made this session, or the cookie
 * restored on load. `null` means "no signal → build-time default".
 */
let activeSignal: RegionSignal | null = null;

/** Trim + strip trailing slashes; return null unless it parses as a URL. */
function normalizeUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\/+$/, "");
  if (!cleaned) return null;
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

/** Validate a raw `{ region, apiUrl }` shape into a RegionSignal, or null. */
function toSignal(raw: unknown): RegionSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { region, apiUrl } = raw as Record<string, unknown>;
  if (typeof region !== "string" || typeof apiUrl !== "string") return null;
  const trimmedRegion = region.trim();
  const normalized = normalizeUrl(apiUrl);
  if (!trimmedRegion || !normalized) return null;
  return { region: trimmedRegion, apiUrl: normalized };
}

function readRegionCookie(): RegionSignal | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${REGION_COOKIE}=`));
  const raw = match?.slice(REGION_COOKIE.length + 1);
  if (!raw) return null;
  try {
    return toSignal(JSON.parse(decodeURIComponent(raw)));
  } catch (err) {
    // A tampered or stale-format cookie must not strand the browser — fall
    // back to the default base rather than throwing on every call.
    console.warn(
      "api-url: ignoring malformed atlas_region cookie:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * `Secure` on https (prod regional hosts) but omitted on http so the cookie
 * is actually stored during local development (and in the test DOM, which
 * runs on http://localhost).
 */
function cookieSecureAttr(): string {
  if (typeof window !== "undefined" && window.location?.protocol === "http:") return "";
  return "; Secure";
}

function writeRegionCookie(signal: RegionSignal | null): void {
  if (typeof document === "undefined") return;
  if (signal === null) {
    document.cookie = `${REGION_COOKIE}=; path=/; max-age=0; SameSite=Lax${cookieSecureAttr()}`;
    return;
  }
  const value = encodeURIComponent(JSON.stringify(signal));
  document.cookie =
    `${REGION_COOKIE}=${value}; path=/; max-age=${REGION_COOKIE_MAX_AGE}; SameSite=Lax${cookieSecureAttr()}`;
}

// Restore synchronously at module load (browser only) so getApiUrl() is
// already regional on the very first call, before any component renders.
if (typeof document !== "undefined") {
  activeSignal = readRegionCookie();
}

/** Returns the current API URL, preferring the active regional base. */
export function getApiUrl(): string {
  return activeSignal?.apiUrl ?? DEFAULT_API_URL;
}

/**
 * Whether requests cross an origin (an explicit/regional API base is set),
 * so consumers send `credentials: "include"` on credentialed fetches.
 */
export function isCrossOrigin(): boolean {
  return !!getApiUrl();
}

/** The active region key, if any — seeds the login fast-path. */
export function getActiveRegion(): string | null {
  return activeSignal?.region ?? null;
}

/**
 * Apply a region selection: point the API base at the region's `apiUrl` and
 * persist `{ region, apiUrl }` in the `atlas_region` cookie so it survives
 * reloads. Returns `false` (base unchanged, cookie untouched) when the region
 * is empty or the `apiUrl` doesn't parse — a bad signal must never strand the
 * browser on an unreachable host.
 */
export function applyRegionSignal(region: string, apiUrl: string): boolean {
  const signal = toSignal({ region, apiUrl });
  if (!signal) {
    console.error(
      `applyRegionSignal: rejected region="${region}" apiUrl="${apiUrl}". Keeping current API URL.`,
    );
    return false;
  }
  activeSignal = signal;
  writeRegionCookie(signal);
  return true;
}

/** Clear the region signal + cookie, reverting to the build-time default. */
export function clearRegionSignal(): void {
  activeSignal = null;
  writeRegionCookie(null);
}

/**
 * Restore the active region signal from the `atlas_region` cookie. Idempotent;
 * call on app load (the module also does this once on import) or after a
 * cookie change in another tab. A missing/malformed cookie clears the signal.
 */
export function initRegionFromCookie(): RegionSignal | null {
  activeSignal = readRegionCookie();
  return activeSignal;
}

/** Reset in-memory state (testing). Does not touch the cookie. */
export function _resetApiUrl(): void {
  activeSignal = null;
}
