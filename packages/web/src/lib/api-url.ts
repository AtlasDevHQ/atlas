/**
 * Pre-auth regional API base resolution (ADR-0024 §3–§4).
 *
 * The browser must target its workspace's regional API *before* any
 * authenticated call. Region is therefore a signal the browser knows up
 * front — never something it learns by first calling the US API. (The retired
 * path did exactly that: it discovered the regional host from the US
 * admin-settings response, which only worked while data was wrongly readable
 * from US. ADR-0024 deletes that circular dependency.)
 *
 * What this module implements:
 *   - applyRegionSignal(region, apiUrl): point the API base at a region and
 *     persist `{ region, apiUrl }` in the `atlas_region` cookie.
 *   - restore-on-import + initRegionFromCookie(): a returning visit resolves
 *     the regional base straight from that cookie, with no network round-trip.
 *
 * Resolution order for getApiUrl():
 *   1. An active region signal — applied this session, or restored from the
 *      `atlas_region` cookie on load → that region's apiUrl.
 *   2. Otherwise the build-time default (NEXT_PUBLIC_ATLAS_API_URL), empty on
 *      self-hosted → same-origin, unaffected by any of this.
 *
 * Intended consumers (separate slices): the signup region step calls
 * applyRegionSignal so the choice is made before the first identity write, and
 * a login fast-path reads getActiveRegion() to short-circuit the front-door
 * region fan-out. Neither is wired here — this is the primitive they build on.
 */

import type { Region } from "@useatlas/types";

const DEFAULT_API_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");

/** Cookie persisting the selected region + its resolved API base. */
export const REGION_COOKIE = "atlas_region";

/** 1 year — region rarely changes; a returning user keeps the fast-path. */
const REGION_COOKIE_MAX_AGE = 31_536_000;

/** Hosts allowed to serve a regional base over plain http (local dev only). */
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** A region selection projected onto the API base it resolves to. */
export interface RegionSignal {
  /** Region identifier (e.g. "eu") — seeds the login fast-path. */
  readonly region: Region;
  /** Resolved regional API base (e.g. "https://api-eu.useatlas.dev"). */
  readonly apiUrl: string;
}

/**
 * Active region signal — a selection made this session, or the cookie
 * restored on load. `null` means "no signal → build-time default".
 */
let activeSignal: RegionSignal | null = null;

/**
 * Trim + strip trailing slashes; return null unless the value parses as a URL
 * on a credential-safe scheme. Requires https (the regional bases are https),
 * allowing http only for localhost so local dev still works. The regional base
 * is fed to credentialed fetches and the `atlas_region` cookie is
 * client-writable, so rejecting arbitrary http/`javascript:` origins here keeps
 * a tampered cookie from repointing authenticated traffic at an attacker host.
 */
function normalizeUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\/+$/, "");
  if (!cleaned) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    // intentionally ignored: a parse failure IS the "invalid URL" signal; the
    // caller (applyRegionSignal / readRegionCookie) surfaces the rejection.
    return null;
  }
  if (parsed.protocol === "https:") return cleaned;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.test(parsed.hostname)) return cleaned;
  return null;
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
  if (!raw) return null; // no cookie — the normal, default-base path; stay quiet

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    console.warn(
      "api-url: ignoring atlas_region cookie with an unparseable value:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const signal = toSignal(parsed);
  if (!signal) {
    // Present but shape-invalid — a tampered value, or a cookie left by an
    // older format after a RegionSignal change. Surface it: silently demoting
    // a regional user to the US build-time default is the residency failure
    // #3971 exists to kill, so it must be observable, not swallowed.
    console.warn("api-url: ignoring atlas_region cookie with an invalid shape.");
  }
  return signal;
}

/**
 * `; Secure` on https (prod regional hosts), omitted on http so the cookie is
 * actually stored during local development (and in the test DOM, which runs on
 * http://localhost). Pure on `protocol` so the https branch is unit-testable —
 * the test DOM can't exercise it via a real document.cookie write.
 */
export function secureCookieAttr(protocol: string | undefined): string {
  return protocol === "http:" ? "" : "; Secure";
}

function currentProtocol(): string | undefined {
  return typeof window !== "undefined" ? window.location?.protocol : undefined;
}

function writeRegionCookie(signal: RegionSignal | null): void {
  if (typeof document === "undefined") return;
  const secure = secureCookieAttr(currentProtocol());
  if (signal === null) {
    document.cookie = `${REGION_COOKIE}=; path=/; max-age=0; SameSite=Lax${secure}`;
    return;
  }
  const value = encodeURIComponent(JSON.stringify(signal));
  document.cookie =
    `${REGION_COOKIE}=${value}; path=/; max-age=${REGION_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

// Restore synchronously at module load (browser only) so getApiUrl() is
// already regional on the very first call, before any component renders. SSR
// resolves to the default base (no `document`) while the client resolves
// regional after this restore — an intentional divergence that is safe because
// `apiUrl` is only ever used to address fetches, never rendered as hydrated
// text.
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
export function getActiveRegion(): Region | null {
  return activeSignal?.region ?? null;
}

/**
 * Apply a region selection: point the API base at the region's `apiUrl` and
 * persist `{ region, apiUrl }` in the `atlas_region` cookie so it survives
 * reloads. Returns `false` (base unchanged, cookie untouched) when the region
 * is empty or the `apiUrl` is not a credential-safe URL — a bad signal must
 * never strand the browser on an unreachable host.
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
