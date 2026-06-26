/**
 * Returning-user login front-door — region-agnostic edge route (ADR-0024 §3,
 * #3973).
 *
 * Lives on app.useatlas.dev (NOT on any regional API — no regional API may
 * carry a dual global identity role). The browser POSTs the typed email here
 * BEFORE any session exists; this route hashes it (`sha256(lower(email))`) and
 * fans an existence probe out to every region in parallel, returning the
 * region to route to (single hit), a chooser (multiple hits, §6), `none`,
 * `skip` (not a multi-region deployment), or a retryable `error`.
 *
 * Why server-side: the browser hits ONE same-origin endpoint and never learns
 * the per-region probe URLs; the raw email is hashed here and only the hash
 * leaves; and the oracle is rate-limited at this front-door per the REAL client
 * IP (the regional probe additionally rate-limits, but the front-door's
 * server-side fan-out arrives from the web tier's IP — so the per-user control
 * belongs here). No email→region is ever stored — the hash is transient.
 *
 * Only reachable in cross-origin SaaS mode: when NEXT_PUBLIC_ATLAS_API_URL is
 * unset, next.config rewrites `/api/*` to the Hono API and the login page never
 * engages the region gate, so this handler is a SaaS-only surface.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  resolveRegion,
  parseRegionCookie,
  isLikelyEmail,
  type RegionMap,
} from "@/lib/login-frontdoor";
import { REGION_COOKIE } from "@/lib/api-url";

// Web Crypto + per-request work; never cache an account-existence oracle.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Default API base for the region-map discovery fetch (server-side). */
function defaultApiBase(): string {
  return (
    process.env.NEXT_PUBLIC_ATLAS_API_URL ||
    process.env.ATLAS_API_URL ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}

// --- Front-door rate limiter (per real client IP, per server instance) ------
//
// The PRIMARY per-user oracle control: a returning user resolves their region
// a handful of times at most, so a tight per-IP ceiling bounds enumeration
// without ever inconveniencing a legitimate login. Per-instance in-memory
// (same accepted contract as the API's public-share limiter); under N web
// replicas the effective ceiling is N× this, which is fine for an oracle whose
// regional probes are independently rate-limited.

const FRONTDOOR_WINDOW_MS = 60_000;
const FRONTDOOR_MAX_RPM = 20;
const buckets = new Map<string, { count: number; resetAt: number }>();

/** First hop of X-Forwarded-For, or null when no client IP can be resolved. */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  return real?.trim() || null;
}

/** Returns true if the request is within the per-IP ceiling. */
function allow(ip: string | null): boolean {
  // IP-less requests share one conservative bucket so a missing proxy header
  // can't disable the limit entirely.
  const key = ip ?? "__anon__";
  const limit = ip ? FRONTDOOR_MAX_RPM : Math.min(FRONTDOOR_MAX_RPM, 10);
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + FRONTDOOR_WINDOW_MS });
    // Opportunistic eviction so the map can't grow unbounded across instances
    // that never restart.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    }
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

const PROBE_TIMEOUT_MS = 4_000;
const MAP_TIMEOUT_MS = 4_000;

async function fetchRegionMap(): Promise<RegionMap> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), MAP_TIMEOUT_MS);
  try {
    const res = await fetch(`${defaultApiBase()}/api/v1/auth/region-map`, {
      signal: controller.signal,
      // The map is static config; cache briefly to spare the API the per-login
      // round-trip while staying fresh enough for a region rollout.
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`region-map returned ${res.status}`);
    return (await res.json()) as RegionMap;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe one region for the hashed email. A 404 (region not managed / no
 * front-door) is "not a hit", not a failure; a 429 / 5xx / network error
 * throws so `resolveRegion` treats the region as inconclusive rather than a
 * confident miss.
 */
async function probeRegion(apiUrl: string, emailHash: string): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/v1/auth/region-probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailHash }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`region-probe returned ${res.status}`);
    const body = (await res.json()) as { exists?: unknown };
    return body.exists === true;
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!allow(clientIp(req))) {
    return NextResponse.json(
      { outcome: "error", message: "Too many attempts. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  let email: unknown;
  try {
    const body = (await req.json()) as { email?: unknown };
    email = body.email;
  } catch {
    // intentionally ignored: an unparseable body is a client error surfaced as 400.
    return NextResponse.json({ outcome: "error", message: "Invalid request." }, { status: 400 });
  }

  if (typeof email !== "string" || !isLikelyEmail(email)) {
    return NextResponse.json(
      { outcome: "error", message: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const cookieRegion = parseRegionCookie(req.cookies.get(REGION_COOKIE)?.value);

  const result = await resolveRegion({
    email,
    cookieRegion,
    fetchRegionMap,
    probe: probeRegion,
  });

  // `error` is the only non-2xx routing verdict — it means "inconclusive, let
  // the user retry". Every other outcome is a successful resolution (including
  // `none` and `skip`), so it is 200.
  const status = result.outcome === "error" ? 502 : 200;
  return NextResponse.json(result, { status });
}
