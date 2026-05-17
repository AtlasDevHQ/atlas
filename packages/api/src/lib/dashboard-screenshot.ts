/**
 * Dashboard screenshot pipeline (#2367 — vision tool for the bound agent).
 *
 * Renders a dashboard page in a long-lived headless Chromium, captures a PNG
 * the LLM can reason over, and caches the bytes keyed by
 * `(dashboardId, userId, snapshotHash)`. The cache is intentionally simple
 * and in-process — the #2366 spike comment + CLAUDE.md memory both flag
 * pooled browsers / cache warming as productionisation work post-v1, but
 * the in-process LRU is enough to make repeated agent turns cheap when the
 * dashboard hasn't changed.
 *
 * Design choices (per #2366 spike findings):
 *   - **Long-lived Chromium**: launched once, reused across requests. A
 *     `closeScreenshotBrowser()` finalizer is exported so the server
 *     shutdown hook can tear it down cleanly. First call pays the launch
 *     cost (~1-3s); subsequent calls only pay nav + render + capture.
 *   - **1920×2160 tall viewport**: fits the full canvas in one frame so we
 *     don't need scroll-stitching (the grid's scroll container is internal,
 *     not document-level). ~200 ms penalty over 1440×900, no missed cards.
 *   - **Sidebar crop ~256 px**: easy ~20% image-size reduction and tighter
 *     signal-to-noise for the vision model.
 *   - **Cookie forwarding**: the API route is auth-gated, so the calling
 *     user already has a valid Better Auth cookie. We forward it to the
 *     headless browser instead of doing a fresh `signInEmail` per shot —
 *     dodges the rate-limit failure mode the spike hit.
 *   - **Draft-aware behavior**: gated on `ATLAS_DASHBOARD_DRAFTS_ENABLED`
 *     for forward-compat with #2364 (drafts foundation, not yet merged).
 *     v1 ships the published-only path; when #2364 lands, swap the URL
 *     and the cache key derivation below.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getDashboard } from "@atlas/api/lib/dashboards";

const log = createLogger("dashboard-screenshot");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScreenshotFailReason =
  | "no_db"
  | "dashboard_not_found"
  | "render_failed"
  | "browser_unavailable";

export type ScreenshotResult =
  | { ok: true; png: Buffer; cached: boolean; durationMs: number }
  | { ok: false; reason: ScreenshotFailReason; message: string };

export interface ScreenshotOpts {
  dashboardId: string;
  userId: string;
  /** Org gate. Mirrors the convention used everywhere in the dashboards lib. */
  orgId: string | null | undefined;
  /**
   * Forwarded `Cookie:` header from the original request. The headless
   * browser uses it to reach the auth-gated dashboard route without doing
   * a fresh sign-in. May be null when called from a non-HTTP context (the
   * bound agent tool path), in which case the call falls back to the
   * configured `ATLAS_INTERNAL_SCREENSHOT_COOKIE` env var.
   */
  cookieHeader?: string | null;
  /** Override the base URL used for nav. Defaults to `ATLAS_WEB_BASE_URL`. */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// In-memory LRU cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  png: Buffer;
  expiresAt: number;
}

/**
 * Simple LRU. Default cap 32 entries (~16 MB at avg 500 KB/PNG), TTL 60s
 * — short backstop since explicit invalidation is the primary contract.
 */
const CACHE_MAX_ENTRIES = 32;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(dashboardId: string, userId: string, snapshotHash: string): string {
  return `${dashboardId}::${userId}::${snapshotHash}`;
}

function cacheGet(key: string): Buffer | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // LRU bump
  cache.delete(key);
  cache.set(key, entry);
  return entry.png;
}

function cacheSet(key: string, png: Buffer): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { png, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Drop every cache entry for a dashboard. Wired to:
 *   - any accepted draft mutation through the bound editor tools (this slice)
 *   - any accepted stage from #2365 (when that lands — the staging module
 *     should call this on stage commit)
 *
 * Drops across ALL users — a mutation by user A invalidates user B's
 * cached view of the same dashboard too, because the published baseline
 * has shifted.
 */
export function invalidateDashboardScreenshot(dashboardId: string): void {
  const prefix = `${dashboardId}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** @internal — test-only. Drop every cached entry. */
export function _resetScreenshotCache(): void {
  cache.clear();
}

/** @internal — test-only. Returns the current size of the cache. */
export function _screenshotCacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Snapshot hashing
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of the dashboard's contents that flips on
 * any user-visible change. Today (published-only) this is title + per-card
 * id/title/sql/chartConfig/layout/position + updatedAt. When #2364
 * (drafts) ships, this should mix the user's draft pointer (which itself
 * mutates on every accepted edit) so the key naturally invalidates per-user.
 */
async function computeSnapshotHash(
  dashboardId: string,
  orgId: string | null | undefined,
): Promise<{ ok: true; hash: string } | { ok: false; reason: ScreenshotFailReason }> {
  const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined });
  if (!dash.ok) {
    if (dash.reason === "no_db") return { ok: false, reason: "no_db" };
    if (dash.reason === "not_found") return { ok: false, reason: "dashboard_not_found" };
    return { ok: false, reason: "render_failed" };
  }
  const payload = {
    id: dash.data.id,
    title: dash.data.title,
    description: dash.data.description,
    updatedAt: dash.data.updatedAt,
    cards: dash.data.cards.map((c) => ({
      id: c.id,
      title: c.title,
      sql: c.sql,
      chartConfig: c.chartConfig,
      layout: c.layout,
      position: c.position,
    })),
  };
  const hash = createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return { ok: true, hash };
}

// ---------------------------------------------------------------------------
// Long-lived browser
// ---------------------------------------------------------------------------

// Use a loose `unknown` typed pair — we lazy-import playwright to avoid
// pulling it into the import graph at module load time (some self-hosted
// users may not install browsers).
let cachedBrowser: unknown | null = null;
let browserShuttingDown = false;

interface PlaywrightChromium {
  launch: (opts?: Record<string, unknown>) => Promise<{
    newContext: (opts?: Record<string, unknown>) => Promise<{
      newPage: () => Promise<{
        goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
        waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
        waitForFunction: (fn: string | (() => boolean), opts?: Record<string, unknown>) => Promise<unknown>;
        evaluate: <T>(fn: string | (() => T)) => Promise<T>;
        screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
        close: () => Promise<void>;
      }>;
      addCookies: (cookies: unknown[]) => Promise<void>;
      setExtraHTTPHeaders: (headers: Record<string, string>) => Promise<void>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  }>;
}

async function getBrowser(): Promise<unknown> {
  if (cachedBrowser) return cachedBrowser;
  if (browserShuttingDown) throw new Error("Screenshot browser is shutting down");

  // Lazy import — surface a graceful error if Playwright isn't installed.
  let chromium: PlaywrightChromium;
  try {
    // The api package depends on @playwright/test as a (root) devDep.
    // Self-hosted production installs that strip dev deps will see a
    // module-not-found here, surfaced as `browser_unavailable`.
    const mod = await import("@playwright/test");
    chromium = mod.chromium as unknown as PlaywrightChromium;
  } catch (err) {
    log.warn({ err: errorMessage(err) }, "Playwright not available — screenshot tool disabled");
    throw new Error("playwright_not_installed", { cause: err });
  }

  cachedBrowser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  log.info("Headless Chromium launched for dashboard screenshots");
  return cachedBrowser;
}

/**
 * Graceful shutdown hook. Wire from the server's stop path so a SIGTERM
 * doesn't leak the Chromium process.
 */
export async function closeScreenshotBrowser(): Promise<void> {
  browserShuttingDown = true;
  if (!cachedBrowser) return;
  try {
    const browser = cachedBrowser as { close: () => Promise<void> };
    await browser.close();
    log.info("Headless Chromium closed");
  } catch (err) {
    log.warn({ err: errorMessage(err) }, "closeScreenshotBrowser failed");
  } finally {
    cachedBrowser = null;
    browserShuttingDown = false;
  }
}

// ---------------------------------------------------------------------------
// Render injection point — overridable for tests
// ---------------------------------------------------------------------------

export type RenderFn = (opts: {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  cookieHeader: string | null;
  baseUrl: string;
}) => Promise<Buffer>;

let renderImpl: RenderFn | null = null;

/**
 * @internal — test seam. Swap in a stub renderer that returns a canned
 * PNG without touching Playwright. The tool integration tests use this
 * to keep the suite fast.
 */
export function _setRenderFn(fn: RenderFn | null): void {
  renderImpl = fn;
}

// ---------------------------------------------------------------------------
// Default Playwright renderer
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 2160;
const SIDEBAR_CROP_PX = 256;
const NAV_TIMEOUT_MS = 15_000;
const RENDER_WAIT_TIMEOUT_MS = 10_000;

async function defaultRender(opts: {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  cookieHeader: string | null;
  baseUrl: string;
}): Promise<Buffer> {
  const browser = (await getBrowser()) as Awaited<ReturnType<PlaywrightChromium["launch"]>>;

  // Per-request context so cookies from one user can't bleed into another.
  // Page reuse across screenshots is a productionisation win (see #2366
  // comment) but contexts are cheap enough that a fresh one per shot keeps
  // the multi-tenant boundary obvious.
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: 1,
  });

  try {
    // Forward the user's auth cookies. The cookieHeader arrives as a raw
    // header string ("name=value; name2=value2"); split it into the
    // shape Playwright expects.
    const cookieValues = opts.cookieHeader ?? process.env.ATLAS_INTERNAL_SCREENSHOT_COOKIE ?? "";
    if (cookieValues.length > 0) {
      const url = new URL(opts.baseUrl);
      const cookies = parseCookieHeader(cookieValues).map((c) => ({
        name: c.name,
        value: c.value,
        domain: url.hostname,
        path: "/",
      }));
      if (cookies.length > 0) await context.addCookies(cookies);
    }

    const page = await context.newPage();
    try {
      const targetUrl = new URL(`/dashboards/${opts.dashboardId}`, opts.baseUrl).toString();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });

      // Wait for the grid + each tile to have visible content. Same
      // predicate the #2366 spike validated across 33 renders. The
      // function runs inside the page context, so we pass it as a string
      // — keeps the api/ package off the `dom` lib (it's a Node runtime).
      await page.waitForFunction(
        `(() => {
          const tiles = Array.from(document.querySelectorAll('[data-dashboard-card-id]'));
          if (tiles.length === 0) {
            return Boolean(document.querySelector('[data-dashboard-canvas]'));
          }
          return tiles.every((tile) => {
            const body = tile.querySelector('[data-card-body]') || tile;
            const hasSvg = body.querySelector('svg');
            const hasTable = body.querySelector('table');
            const text = (body.textContent || '').trim();
            return Boolean(hasSvg || hasTable || text.length > 0);
          });
        })()`,
        { timeout: RENDER_WAIT_TIMEOUT_MS },
      );

      // Crop the sidebar by clipping to the rest of the viewport.
      const png = await page.screenshot({
        type: "png",
        clip: {
          x: SIDEBAR_CROP_PX,
          y: 0,
          width: VIEWPORT_WIDTH - SIDEBAR_CROP_PX,
          height: VIEWPORT_HEIGHT,
        },
      });
      return png;
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

interface ParsedCookie {
  name: string;
  value: string;
}

function parseCookieHeader(header: string): ParsedCookie[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return { name: part, value: "" };
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render or fetch-from-cache a screenshot of the dashboard.
 *
 * TODO(#2364): when the drafts foundation lands, derive the snapshot hash
 * from the user's draft pointer (if any) instead of the published baseline.
 * Today (published-only) the cache key includes userId for forward-compat
 * symmetry only — every user gets the same PNG for the same published
 * snapshot.
 */
export async function screenshotDashboard(opts: ScreenshotOpts): Promise<ScreenshotResult> {
  const startedAt = Date.now();

  const snap = await computeSnapshotHash(opts.dashboardId, opts.orgId);
  if (!snap.ok) {
    return {
      ok: false,
      reason: snap.reason,
      message:
        snap.reason === "no_db"
          ? "Screenshots require an internal database."
          : snap.reason === "dashboard_not_found"
            ? "Dashboard not found."
            : "Could not compute dashboard snapshot.",
    };
  }

  const key = cacheKey(opts.dashboardId, opts.userId, snap.hash);
  const cached = cacheGet(key);
  if (cached) {
    return {
      ok: true,
      png: cached,
      cached: true,
      durationMs: Date.now() - startedAt,
    };
  }

  const baseUrl = opts.baseUrl ?? process.env.ATLAS_WEB_BASE_URL ?? "http://localhost:3000";

  let png: Buffer;
  try {
    const fn = renderImpl ?? defaultRender;
    png = await fn({
      dashboardId: opts.dashboardId,
      userId: opts.userId,
      orgId: opts.orgId,
      cookieHeader: opts.cookieHeader ?? null,
      baseUrl,
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg === "playwright_not_installed") {
      return {
        ok: false,
        reason: "browser_unavailable",
        message:
          "Headless browser is not installed in this deployment. Screenshots are disabled.",
      };
    }
    log.warn({ err: msg, dashboardId: opts.dashboardId }, "screenshotDashboard render failed");
    return {
      ok: false,
      reason: "render_failed",
      message: "Could not render dashboard screenshot. Try again or simplify the dashboard.",
    };
  }

  cacheSet(key, png);
  return {
    ok: true,
    png,
    cached: false,
    durationMs: Date.now() - startedAt,
  };
}
