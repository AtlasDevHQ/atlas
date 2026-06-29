/**
 * Returning-user login front-door — stateless fan-out region resolution
 * (ADR-0024 §3, #3973).
 *
 * Under regional identity isolation a returning user's `user` row lives only in
 * their region's DB, so the browser must resolve email→region BEFORE any
 * session exists. This module is the region-agnostic logic that powers the edge
 * route on app.useatlas.dev: it hashes the typed email (`sha256(lower(email))`)
 * and fans an existence probe out to every region in parallel, then routes to
 * the single hit, presents a chooser for multiple hits, or reports none.
 *
 * Design invariants (the security contract the probe ADR calls for):
 *   - The raw email never leaves the front-door — only its hash is fanned out.
 *   - There is no global email→region store; the hash is transient per request.
 *   - The hashed-email fan-out is the SOLE authority on which region(s) host an
 *     account. The `atlas_region` cookie is only a tiebreaker among confirmed
 *     hits — it never short-circuits the lookup, overrides it, or conjures a
 *     region for an email that exists nowhere (#4090). When it does break a tie,
 *     the region is re-resolved to its AUTHORITATIVE apiUrl from the region-map,
 *     never from the client-writable cookie's own apiUrl.
 *
 * `resolveRegion` takes `fetchRegionMap` + `probe` as injected dependencies so
 * the routing logic is unit-testable without network; the edge route
 * (`app/api/login/resolve-region/route.ts`) wires the real fetch-backed ones.
 */

import type { RegionRoutingMap } from "@useatlas/types";

/** One region a multi-region returning user can choose between. */
export interface RegionChoice {
  region: string;
  apiUrl: string;
  label: string;
}

/**
 * The front-door's verdict for a typed email:
 *   - `single`   — route here (apply the region signal and reload onto that
 *                  region's credentials form; sign-in then hits that region).
 *   - `multiple` — same email exists in >1 region; present a chooser (§6).
 *   - `none`     — no account in any region (offer signup).
 *   - `skip`     — region routing is not applicable (self-hosted / single
 *                  region); proceed with the default API base unchanged.
 *   - `error`    — the fan-out was inconclusive (map unreachable, or every
 *                  probe failed); the caller should let the user retry rather
 *                  than mis-route to the default (US) region.
 */
export type RegionResolution =
  | { outcome: "single"; region: string; apiUrl: string }
  | { outcome: "multiple"; regions: RegionChoice[] }
  | { outcome: "none" }
  | { outcome: "skip" }
  | { outcome: "error"; message: string };

/**
 * Trim + lower-case. The DB index hashes `lower(email)` over already-clean
 * stored addresses, so the lower-case is the load-bearing match; the trim is
 * belt-and-suspenders for whatever the user pastes into the field.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A deliberately loose "looks like an email" gate (real validation is the auth step). */
export function isLikelyEmail(email: string): boolean {
  const e = email.trim();
  return e.length >= 3 && e.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * `sha256(lower(email))` as 64-char lowercase hex — matches the probe's
 * `EMAIL_HASH_RE` and the pgcrypto index expression
 * `encode(digest(lower(email), 'sha256'), 'hex')`. Web Crypto so it runs
 * unchanged on the Node and Edge runtimes (and in jsdom tests).
 */
export async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeEmail(email));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract a validated region key from the raw `atlas_region` cookie value
 * (`encodeURIComponent(JSON.stringify({ region, apiUrl }))`). Returns only the
 * region string — the apiUrl is deliberately ignored and re-derived from the
 * authoritative region-map, so a tampered cookie can't repoint credentialed
 * traffic. Returns null for any missing / malformed value.
 */
export function parseRegionCookie(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== "object" || parsed === null) return null;
    const region = (parsed as Record<string, unknown>).region;
    if (typeof region !== "string") return null;
    const trimmed = region.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // intentionally ignored: a malformed cookie is treated as "no fast-path
    // hint" — the cold fan-out path still resolves the region correctly.
    return null;
  }
}

export interface ResolveRegionDeps {
  /** The typed email (raw; hashed internally, never forwarded raw). */
  email: string;
  /**
   * The region key from a valid `atlas_region` cookie, or null. Used ONLY as a
   * tiebreaker among confirmed multi-region hits — never to short-circuit or
   * override the email fan-out (#4090).
   */
  cookieRegion: string | null;
  /** Fetch the region-routing map (throws on network failure). */
  fetchRegionMap: () => Promise<RegionRoutingMap>;
  /** Probe one region for the hashed email (throws on network failure). */
  probe: (apiUrl: string, emailHash: string) => Promise<boolean>;
}

/**
 * Resolve a typed email to a region without any global storage.
 *
 * Order: fetch the map → single-region short-circuit → hashed-email fan-out →
 * cookie tiebreaker. The email lookup is ALWAYS authoritative: the
 * `atlas_region` cookie never short-circuits or overrides it, so a stale cookie
 * can neither route a returning user to the wrong region nor conjure a `single`
 * for an email that exists nowhere (#4090). The cookie only breaks a genuine
 * tie — narrowing a multi-region `multiple` to the cookie's region when that
 * region is itself one of the confirmed hits.
 *
 * A region that errors during the fan-out is never reported as a confident
 * "none": if no region confirmed a hit AND at least one probe failed, the
 * result is `error` (retry) rather than a false negative that would dead-end a
 * real returning user.
 */
export async function resolveRegion(deps: ResolveRegionDeps): Promise<RegionResolution> {
  const { email, cookieRegion, fetchRegionMap, probe } = deps;

  let map: RegionRoutingMap;
  try {
    map = await fetchRegionMap();
  } catch {
    // intentionally ignored here: the map is the routing source of truth and
    // its absence is inconclusive, not "no account" — surface a retryable
    // error instead of mis-routing to the default region.
    return { outcome: "error", message: "Could not reach the region directory. Please try again." };
  }

  if (!map.configured || map.regions.length === 0) {
    return { outcome: "skip" };
  }

  // Single-region deployment: route to it without probing — there is no
  // ambiguity to resolve and no reason to operate the existence oracle.
  if (map.regions.length === 1) {
    const only = map.regions[0];
    return { outcome: "single", region: only.id, apiUrl: only.apiUrl };
  }

  const emailHash = await hashEmail(email);
  const settled = await Promise.allSettled(
    map.regions.map(async (r) => ({ region: r, exists: await probe(r.apiUrl, emailHash) })),
  );

  const hits: RegionChoice[] = [];
  let failures = 0;
  for (const s of settled) {
    if (s.status === "rejected") {
      failures++;
      continue;
    }
    if (s.value.exists) {
      hits.push({ region: s.value.region.id, apiUrl: s.value.region.apiUrl, label: s.value.region.label });
    }
  }

  if (hits.length === 0) {
    // No confirmed hit. If a region was unreachable we can't claim "no
    // account" — that would dead-end a returning user whose region just
    // happened to error. Only a clean all-regions-answered sweep yields "none".
    // A stale `atlas_region` cookie is deliberately NOT consulted here: the
    // email genuinely exists nowhere, so the verdict is `none`/`error` (#4090).
    return failures > 0
      ? { outcome: "error", message: "Could not reach every region. Please try again." }
      : { outcome: "none" };
  }
  if (hits.length === 1) {
    return { outcome: "single", region: hits[0].region, apiUrl: hits[0].apiUrl };
  }

  // Multiple regions host this email. Use the cookie as a tiebreaker ONLY when
  // it names one of the confirmed hits — a returning multi-region user skips the
  // chooser and lands on their last-used region with its authoritative apiUrl. A
  // cookie that matches no hit is ignored (it can never fabricate or override a
  // region), so the chooser still appears.
  if (cookieRegion) {
    const pinned = hits.find((h) => h.region === cookieRegion);
    if (pinned) return { outcome: "single", region: pinned.region, apiUrl: pinned.apiUrl };
  }
  return { outcome: "multiple", regions: hits };
}
