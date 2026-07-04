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
 *   - **Per-(user, dashboard) cache key**: the hash mixes `userId` so a
 *     future per-user draft view can invalidate cleanly. Today the snapshot
 *     hash is computed from the published row only — a user with an active
 *     draft sees the published PNG, not their draft view. Mixing the
 *     draft pointer into `computeSnapshotHash` is tracked as a 1.4.7
 *     follow-up; the existing cache shape already supports it.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getDashboard } from "@atlas/api/lib/dashboards";
import { resolveDashboardParameterValues } from "@atlas/api/lib/dashboard-parameters";

const log = createLogger("dashboard-screenshot");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScreenshotFailReason =
  | "no_db"
  | "dashboard_not_found"
  /**
   * Internal DB query for the snapshot hash failed (or returned an error
   * reason we didn't enumerate). Distinct from `render_failed` so the
   * route layer can map it to 500-with-requestId rather than 400 — and
   * distinct from `dashboard_not_found` so a buggy `getDashboard`
   * upstream cannot mask an infra outage as a 404.
   */
  | "dashboard_unavailable"
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
 * Drop every cache entry for a dashboard. Called by:
 *   - safe-op mutations through the bound editor tools (`addCard` /
 *     `updateCard` / `updateLayout` / `updateDashboardMeta`).
 *   - destructive-op stage acceptance via `acceptStagedChange` (#2365).
 *   - publish via the `/draft/publish` route — published moved, every
 *     editor's cached view is stale.
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
 * any user-visible change: title + per-card id/title/sql/chartConfig/layout
 * /position + updatedAt. The cache key separately mixes in `userId` so a
 * future per-user draft view can invalidate without touching this hash.
 */
async function computeSnapshotHash(
  dashboardId: string,
  orgId: string | null | undefined,
): Promise<{ ok: true; hash: string } | { ok: false; reason: ScreenshotFailReason }> {
  const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined });
  if (!dash.ok) {
    if (dash.reason === "no_db") return { ok: false, reason: "no_db" };
    if (dash.reason === "not_found") return { ok: false, reason: "dashboard_not_found" };
    // Any other failure reason (today "error"; future-proof against new
    // ones the dashboards helper might add) is an infra failure, NOT a
    // render failure and NOT a 404. Surface as `dashboard_unavailable`
    // so the route layer can return 500-with-requestId. Collapsing the
    // path to `render_failed` here would mask an internal DB outage
    // (or worse, a buggy cross-org masking) as a Playwright problem.
    log.warn(
      { dashboardId, reason: dash.reason },
      "computeSnapshotHash: dashboard lookup failed with non-not_found reason",
    );
    return { ok: false, reason: "dashboard_unavailable" };
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
// Single-flight guard: N concurrent renders that find the cache empty (or a
// dead handle) share ONE (close-dead + launch) instead of each spawning its
// own Chromium and leaking all but one. Cleared once the acquire settles.
let browserAcquire: Promise<unknown> | null = null;

interface PlaywrightChromium {
  launch: (opts?: Record<string, unknown>) => Promise<LaunchedBrowser>;
}

/**
 * Minimal lifecycle surface of a launched browser. `isConnected()` is
 * Playwright's liveness signal — it flips to `false` the moment the underlying
 * Chromium process dies or the transport drops, which is exactly the
 * dead-instance-cached-forever failure (#4319) we relaunch on.
 */
export interface LaunchedBrowser {
  isConnected?: () => boolean;
  close: () => Promise<void>;
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
}

/** Injectable launcher — the real one lazy-imports Playwright. */
type BrowserLauncher = () => Promise<LaunchedBrowser>;

let browserLauncherOverride: BrowserLauncher | null = null;

/**
 * @internal — test seam. Swap in a fake browser launcher so the launch /
 * liveness / relaunch lifecycle is testable without downloading Chromium.
 * Pass `null` to restore the real Playwright launcher.
 */
export function _setBrowserLauncher(fn: BrowserLauncher | null): void {
  browserLauncherOverride = fn;
}

/**
 * @internal — test-only. Reset the browser cache + single-flight guard between
 * tests (the cache and shutdown flag are module-level singletons).
 */
export function _resetScreenshotBrowserState(): void {
  cachedBrowser = null;
  browserShuttingDown = false;
  browserAcquire = null;
}

/**
 * @internal — test-only. Force-acquire the shared browser through the real
 * `getBrowser()` path (liveness check + relaunch + single-flight), so the
 * lifecycle can be asserted directly.
 */
export function _acquireScreenshotBrowser(): Promise<unknown> {
  return getBrowser();
}

/** The real launcher: lazy-import Playwright and launch headless Chromium. */
async function launchViaPlaywright(): Promise<LaunchedBrowser> {
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
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/**
 * Liveness check. A cached browser whose process has crashed reports
 * `isConnected() === false`; serving it would fail every render until an API
 * restart (#4319). A handle that doesn't expose `isConnected` (a stub, or an
 * older Playwright) is treated as alive — we can't prove it's dead. A throw
 * from `isConnected()` means the transport is gone → treat as dead.
 */
function isBrowserAlive(b: LaunchedBrowser): boolean {
  if (typeof b.isConnected !== "function") return true;
  try {
    return b.isConnected();
  } catch (err) {
    log.debug({ err: errorMessage(err) }, "browser isConnected() threw — treating as dead");
    return false;
  }
}

async function getBrowser(): Promise<unknown> {
  if (browserShuttingDown) throw new Error("Screenshot browser is shutting down");

  // Fast path: a live cached browser.
  if (cachedBrowser && isBrowserAlive(cachedBrowser as LaunchedBrowser)) {
    return cachedBrowser;
  }

  // Slow path: no browser, or the cached one is dead. Single-flight the
  // (close-dead + launch) so concurrent renders share one relaunch.
  if (!browserAcquire) {
    browserAcquire = acquireBrowser().finally(() => {
      browserAcquire = null;
    });
  }
  return browserAcquire;
}

async function acquireBrowser(): Promise<unknown> {
  // Re-check inside the single-flight — a racing caller may have already
  // relaunched a live browser while we were queued behind it.
  if (cachedBrowser && isBrowserAlive(cachedBrowser as LaunchedBrowser)) {
    return cachedBrowser;
  }

  // A dead handle is cached: best-effort close so we don't leak the crashed
  // process, then drop it. A throw here must not block the relaunch.
  if (cachedBrowser) {
    log.warn("Cached headless Chromium is disconnected — relaunching");
    try {
      await (cachedBrowser as LaunchedBrowser).close();
    } catch (err) {
      log.debug({ err: errorMessage(err) }, "closing dead browser handle failed (ignored)");
    }
    cachedBrowser = null;
  }

  const launch = browserLauncherOverride ?? launchViaPlaywright;
  cachedBrowser = await launch();
  log.info("Headless Chromium launched for dashboard screenshots");
  return cachedBrowser;
}

/**
 * Graceful shutdown hook. Wire from the server's stop path so a SIGTERM
 * doesn't leak the Chromium process.
 */
export async function closeScreenshotBrowser(): Promise<void> {
  browserShuttingDown = true;
  if (!cachedBrowser) {
    browserShuttingDown = false;
    return;
  }
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
// Render concurrency semaphore (#4319)
// ---------------------------------------------------------------------------
//
// One shared headless Chromium serves every screenshot AND export. Without a
// bound, a burst of export requests each opens its own browser context/page in
// parallel, and memory (each ~1920×2160 or 1600×2000 @2× render) climbs
// unbounded until the process OOMs. The semaphore caps simultaneous renders;
// excess requests QUEUE (FIFO) and run as permits free up, rather than being
// rejected or spawning unbounded contexts.

const RENDER_CONCURRENCY_DEFAULT = 3;
const RENDER_CONCURRENCY_MIN = 1;
const RENDER_CONCURRENCY_MAX = 16;

let renderConcurrencyOverride: number | null = null;

/**
 * @internal — test seam. Pin the concurrency cap so the queueing behaviour is
 * deterministic without reaching into the settings registry. `null` restores
 * the registry-backed value.
 */
export function _setRenderConcurrency(n: number | null): void {
  renderConcurrencyOverride = n;
}

/**
 * Clamp a raw setting value to a valid concurrency cap. Pure + exported so the
 * boundary behaviour is unit-testable without the settings registry:
 *   - unset / empty / non-numeric → default (3)
 *   - below the floor (incl. 0 / negative) → 1  (a 0 cap would deadlock all renders)
 *   - above the ceiling → 16
 *   - fractional → truncated
 */
export function clampRenderConcurrency(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return RENDER_CONCURRENCY_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return RENDER_CONCURRENCY_DEFAULT;
  return Math.min(RENDER_CONCURRENCY_MAX, Math.max(RENDER_CONCURRENCY_MIN, Math.trunc(parsed)));
}

/** Effective cap: test override > platform DB override > env > default. */
function getRenderConcurrency(): number {
  if (renderConcurrencyOverride !== null) return renderConcurrencyOverride;
  return clampRenderConcurrency(getSettingAuto("ATLAS_DASHBOARD_RENDER_CONCURRENCY"));
}

/**
 * Minimal FIFO counting semaphore. The limit is read live on every admission
 * decision (via `getLimit`) so a settings hot-reload takes effect for the next
 * queued waiter without a restart.
 */
class RenderSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly getLimit: () => number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tryAdmit = (): void => {
        if (this.active < this.getLimit()) {
          this.active += 1;
          resolve();
        } else {
          // Over the cap — queue and re-attempt when a permit frees up.
          this.waiters.push(tryAdmit);
        }
      };
      tryAdmit();
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** @internal — test-only. Current in-flight render count. */
  get inFlight(): number {
    return this.active;
  }
}

const renderSemaphore = new RenderSemaphore(getRenderConcurrency);

/** @internal — test-only. Current in-flight render count (semaphore probe). */
export function _renderInFlight(): number {
  return renderSemaphore.inFlight;
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
      const name = part.slice(0, eq).trim();
      const rawValue = part.slice(eq + 1).trim();
      // Cookie values are percent-encoded per RFC 6265 when they carry
      // characters outside the cookie-octet set (commonly `;`, `,`,
      // `%`, whitespace). Better Auth session cookies are typically
      // base64url so this is usually a no-op, but a percent-encoded
      // value would otherwise be passed verbatim to Playwright and
      // fail the auth handshake.
      let value = rawValue;
      try {
        value = decodeURIComponent(rawValue);
      } catch (err) {
        // Malformed percent-escape — keep the raw value and log so the
        // operator sees the drift. (Better Auth never emits these.)
        log.debug(
          { err: errorMessage(err), name },
          "parseCookieHeader: cookie value not valid percent-encoded; using raw",
        );
      }
      return { name, value };
    });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render or fetch-from-cache a screenshot of the dashboard.
 *
 * The snapshot hash is derived from the published row only — a user with
 * an active draft sees the published PNG, not their draft view. The
 * cache key already mixes `userId` so a future "draft-aware hash" can
 * land without changing the cache shape (1.4.7 follow-up).
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
            : snap.reason === "dashboard_unavailable"
              ? "Could not load the dashboard for rendering. The database may be temporarily unavailable — try again."
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
    // Bound simultaneous headless renders — excess requests queue here rather
    // than each opening its own browser context (#4319).
    png = await renderSemaphore.run(() =>
      fn({
        dashboardId: opts.dashboardId,
        userId: opts.userId,
        orgId: opts.orgId,
        cookieHeader: opts.cookieHeader ?? null,
        baseUrl,
      }),
    );
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

// ===========================================================================
// Whole-dashboard export (#3211 — PNG / PDF of the full board)
// ===========================================================================
//
// Reuses the same long-lived Chromium + cookie-forwarding machinery as the
// vision screenshot above — NOT a second headless path. The differences:
//
//   - **Full board, not a fixed clip.** We capture the `.dashboard-app` grid
//     element directly, so a board taller than the viewport is captured whole
//     and the multi-card layout is preserved without scroll-stitching.
//   - **Current parameter values.** The caller's override map is forwarded via
//     the same `dparams` URL key the parameter bar writes (#2267), so the
//     headless render reproduces the viewer's current parameters.
//   - **Partial-tolerant.** A single tile that never finishes rendering must
//     NOT abort the export — the tile-content wait is best-effort; on timeout
//     we mark the result `partial` and capture whatever rendered.
//   - **PDF without a new dependency.** For PDF we wrap the captured PNG in a
//     tiny print document (title + timestamp header) and let the SAME headless
//     page emit the PDF via `page.pdf()`. No PDF library, no second render.
//   - **Uncached.** Exports are explicit, parameter-varying, one-shot user
//     actions — caching them would mostly miss and risk serving a stale board.

export type ExportFormat = "png" | "pdf";

export type ExportFailReason =
  | "no_db"
  | "dashboard_not_found"
  | "dashboard_unavailable"
  | "invalid_parameters"
  | "render_failed"
  | "export_timeout"
  | "browser_unavailable";

export type ExportResult =
  | {
      ok: true;
      format: ExportFormat;
      bytes: Buffer;
      contentType: string;
      /** `<slug-title>-<utc-stamp>.<ext>` — safe for `Content-Disposition`. */
      filename: string;
      title: string;
      /** True when one or more tiles did not finish rendering in time. */
      partial: boolean;
      durationMs: number;
    }
  | { ok: false; reason: ExportFailReason; message: string };

export interface ExportOpts {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  format: ExportFormat;
  /** Caller's current parameter override map; serialized to the `dparams` URL key. */
  parameters?: Record<string, string | number | null> | null;
  cookieHeader?: string | null;
  baseUrl?: string;
  /**
   * Public origin of the API the export request hit (e.g. the request's own
   * origin). In a cross-origin deploy the page's data fetches go here, so the
   * forwarded session cookie is also seeded for this host. Defaults to none
   * (same-origin: the web host alone suffices).
   */
  apiBaseUrl?: string;
  /** Overall render timeout; defaults to `ATLAS_DASHBOARD_EXPORT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injectable clock so the generated filename + header stamp are testable. */
  now?: Date;
}

/** Args handed to the (overridable) export renderer. */
export interface ExportRenderArgs {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  cookieHeader: string | null;
  baseUrl: string;
  /** API origin to also seed cookies for (cross-origin deploys). */
  apiBaseUrl?: string;
  format: ExportFormat;
  parameters: Record<string, string | number | null> | null;
  title: string;
  /** Human-readable UTC stamp rendered into the PDF header. */
  generatedAt: string;
  /** Overall wall-clock budget; staged waits self-bound so capture always runs. */
  timeoutMs: number;
}

export interface ExportRenderOutput {
  bytes: Buffer;
  contentType: string;
  partial: boolean;
}

export type ExportRenderFn = (args: ExportRenderArgs) => Promise<ExportRenderOutput>;

let exportRenderImpl: ExportRenderFn | null = null;

/**
 * @internal — test seam. Swap in a stub export renderer that returns canned
 * bytes without touching Playwright. The route + lib tests use this to stay
 * fast; the real Playwright path is exercised by the smoke spec.
 */
export function _setExportRenderFn(fn: ExportRenderFn | null): void {
  exportRenderImpl = fn;
}

// Default budget exceeds the worst-case sum of the staged render waits (nav +
// grid + param + tile, ~50s) plus the capture reserve, so a slow-but-expected
// parameterized export returns the documented partial artifact instead of a
// 504. Each staged wait is additionally bounded by the remaining budget (see
// `defaultExportRender`), so a lower operator override degrades to a partial
// capture rather than a timeout.
const EXPORT_TIMEOUT_DEFAULT_MS = 60_000;
const EXPORT_TIMEOUT_MIN_MS = 5_000;
const EXPORT_TIMEOUT_MAX_MS = 180_000;
/** Sentinel error message used to distinguish a timeout from a render failure. */
const EXPORT_TIMEOUT_SENTINEL = "atlas_export_timed_out";

function getExportTimeoutMs(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_DASHBOARD_EXPORT_TIMEOUT_MS");
  if (!raw) return EXPORT_TIMEOUT_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return EXPORT_TIMEOUT_DEFAULT_MS;
  return Math.min(EXPORT_TIMEOUT_MAX_MS, Math.max(EXPORT_TIMEOUT_MIN_MS, Math.trunc(parsed)));
}

/** Reject with the timeout sentinel if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(EXPORT_TIMEOUT_SENTINEL)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Serialize the override map to the `dparams` URL value the parameter bar
 * writes — dropping null/empty entries so "no overrides" serializes to nothing
 * (mirrors `DashboardParameterBar`'s commit-cleaning).
 *
 * @internal — exported only so the parameter-forwarding logic is unit-testable
 * without driving the Playwright render path.
 */
export function serializeDparams(
  parameters: Record<string, string | number | null> | null | undefined,
): string | null {
  if (!parameters) return null;
  const cleaned: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(parameters)) {
    if (v === null || v === "") continue;
    cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return null;
  return JSON.stringify(cleaned);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Filename-safe UTC stamp: `YYYYMMDD-HHmmss`. */
function filenameStamp(now: Date): string {
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Human-readable UTC stamp for the PDF header, e.g. `2026-06-04 12:30 UTC`. */
function formatDisplayStamp(now: Date): string {
  return (
    `${pad(now.getUTCFullYear(), 4)}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    ` ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`
  );
}

/** ASCII slug for the download filename. Falls back to `dashboard` when empty. */
function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "dashboard";
}

/** `<slug>-<stamp>.<ext>` — exported for the route's `Content-Disposition`. */
export function buildExportFilename(title: string, format: ExportFormat, now: Date): string {
  return `${slugifyTitle(title)}-${filenameStamp(now)}.${format}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Export the whole dashboard at the caller's current parameter values to PNG
 * or PDF. Returns a typed failure (never throws) so the route layer can map
 * each reason to an HTTP status with a `requestId`.
 */
export async function exportDashboard(opts: ExportOpts): Promise<ExportResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();

  // Resolve the dashboard for its title + an existence/org gate. Same
  // reason-mapping discipline as the screenshot path: a non-not_found lookup
  // failure is infra (`dashboard_unavailable` → 503), never a 404.
  const dash = await getDashboard(opts.dashboardId, { orgId: opts.orgId ?? undefined });
  if (!dash.ok) {
    if (dash.reason === "no_db") {
      return { ok: false, reason: "no_db", message: "Dashboard export requires an internal database." };
    }
    if (dash.reason === "not_found") {
      return { ok: false, reason: "dashboard_not_found", message: "Dashboard not found." };
    }
    log.warn(
      { dashboardId: opts.dashboardId, reason: dash.reason },
      "exportDashboard: dashboard lookup failed with non-not_found reason",
    );
    return {
      ok: false,
      reason: "dashboard_unavailable",
      message:
        "Could not load the dashboard for export. The database may be temporarily unavailable — try again.",
    };
  }

  const title = dash.data.title?.trim() ? dash.data.title : "Dashboard";

  // Validate the supplied overrides against the dashboard's declared parameters
  // BEFORE rendering — the same coercion `/cards/:cardId/render` runs. Without
  // this, an invalid override (e.g. a date param set to "not-a-date") would be
  // forwarded raw; the page's per-card renders 400, the grid keeps its cached
  // DEFAULT rows, and the export would still return 200 with a default-parameter
  // artifact for a non-default request. Fail closed instead.
  if (opts.parameters && Object.keys(opts.parameters).length > 0) {
    try {
      resolveDashboardParameterValues(dash.data.parameters, opts.parameters);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid_parameters",
        message: err instanceof Error ? err.message : "Invalid dashboard parameters.",
      };
    }
  }

  const baseUrl = opts.baseUrl ?? process.env.ATLAS_WEB_BASE_URL ?? "http://localhost:3000";
  const timeoutMs = opts.timeoutMs ?? getExportTimeoutMs();

  let rendered: ExportRenderOutput;
  try {
    const fn = exportRenderImpl ?? defaultExportRender;
    // Bound simultaneous headless renders (shared with the screenshot path).
    // The permit is acquired BEFORE the render timeout starts, so time spent
    // queueing for a permit doesn't count against the render budget (#4319).
    rendered = await renderSemaphore.run(() =>
      withTimeout(
        fn({
          dashboardId: opts.dashboardId,
          userId: opts.userId,
          orgId: opts.orgId,
          cookieHeader: opts.cookieHeader ?? null,
          baseUrl,
          apiBaseUrl: opts.apiBaseUrl,
          format: opts.format,
          parameters: opts.parameters ?? null,
          title,
          generatedAt: formatDisplayStamp(now),
          timeoutMs,
        }),
        timeoutMs,
      ),
    );
  } catch (err) {
    const msg = errorMessage(err);
    if (msg === "playwright_not_installed") {
      return {
        ok: false,
        reason: "browser_unavailable",
        message: "Headless browser is not installed in this deployment. Dashboard export is disabled.",
      };
    }
    if (msg === EXPORT_TIMEOUT_SENTINEL) {
      log.warn({ dashboardId: opts.dashboardId, timeoutMs }, "exportDashboard timed out");
      return {
        ok: false,
        reason: "export_timeout",
        message:
          "Dashboard export timed out. Try again, or reduce the number of tiles on the dashboard.",
      };
    }
    log.warn({ err: msg, dashboardId: opts.dashboardId }, "exportDashboard render failed");
    return {
      ok: false,
      reason: "render_failed",
      message: "Could not render the dashboard for export. Try again or simplify the dashboard.",
    };
  }

  return {
    ok: true,
    format: opts.format,
    bytes: rendered.bytes,
    contentType: rendered.contentType,
    filename: buildExportFilename(title, opts.format, now),
    title,
    partial: rendered.partial,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Default Playwright export renderer
// ---------------------------------------------------------------------------

// Richer page/element surface than the screenshot path uses (adds pdf /
// setContent / emulateMedia / element query). Loosely typed because Playwright
// is lazy-imported; `getBrowser()` returns the same launched instance.
interface ExportElementHandle {
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
  boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
}
interface ExportPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForFunction: (
    fn: string | (() => boolean),
    arg?: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  evaluate: <T>(fn: string | (() => T)) => Promise<T>;
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
  setContent: (html: string, opts?: Record<string, unknown>) => Promise<void>;
  emulateMedia: (opts?: Record<string, unknown>) => Promise<void>;
  pdf: (opts?: Record<string, unknown>) => Promise<Buffer>;
  $: (sel: string) => Promise<ExportElementHandle | null>;
  close: () => Promise<void>;
}
interface ExportContext {
  newPage: () => Promise<ExportPage>;
  addCookies: (cookies: unknown[]) => Promise<void>;
  close: () => Promise<void>;
}
interface ExportBrowser {
  newContext: (opts?: Record<string, unknown>) => Promise<ExportContext>;
}

const EXPORT_VIEWPORT_WIDTH = 1600;
const EXPORT_VIEWPORT_HEIGHT = 2000;
const EXPORT_NAV_TIMEOUT_MS = 20_000;
const EXPORT_GRID_WAIT_TIMEOUT_MS = 10_000;
const EXPORT_PARAM_WAIT_TIMEOUT_MS = 10_000;
const EXPORT_TILE_WAIT_TIMEOUT_MS = 8_000;
/** Wall-clock kept in reserve for the screenshot + PDF capture itself. */
const EXPORT_CAPTURE_RESERVE_MS = 8_000;
/** Below this, a staged wait is skipped (Playwright treats `timeout: 0` as "wait forever"). */
const EXPORT_MIN_WAIT_MS = 500;

// Predicate run inside the page: every grid tile's BODY has finished rendering.
// We inspect `.dash-tile-body` (not the wrapper) so the always-present
// title/footer text can't satisfy the check before a chart paints, and we treat
// the dynamic-import loading skeleton (`.animate-pulse`) as "not ready" — so a
// first-load chart export waits for the SVG instead of capturing a blank tile.
// A tile body is ready when it has no loading skeleton AND carries an SVG
// (chart), a table, or some text (KPI/markdown/"no data"). Passed as a string
// so the api/ package stays off the `dom` lib. An empty board passes
// immediately — the "empty canvas" state has nothing to wait for.
const EXPORT_TILE_CONTENT_PREDICATE = `(() => {
  const tiles = Array.from(document.querySelectorAll('.dash-tile-wrapper, .dash-mobile-tile'));
  if (tiles.length === 0) return true;
  return tiles.every((tile) => {
    const body = tile.querySelector('.dash-tile-body') || tile;
    if (body.querySelector('.animate-pulse')) return false;
    const hasSvg = body.querySelector('svg');
    const hasTable = body.querySelector('table');
    const text = (body.textContent || '').trim();
    return Boolean(hasSvg || hasTable || text.length > 0);
  });
})()`;

async function defaultExportRender(args: ExportRenderArgs): Promise<ExportRenderOutput> {
  const browser = (await getBrowser()) as ExportBrowser;
  const context = await browser.newContext({
    viewport: { width: EXPORT_VIEWPORT_WIDTH, height: EXPORT_VIEWPORT_HEIGHT },
    // 2× for a crisp export — embedded into the PDF at width:100% so the page
    // size stays in CSS pixels regardless.
    deviceScaleFactor: 2,
  });

  try {
    const cookieValues = args.cookieHeader ?? process.env.ATLAS_INTERNAL_SCREENSHOT_COOKIE ?? "";
    if (cookieValues.length > 0) {
      const parsed = parseCookieHeader(cookieValues);
      // Seed the forwarded session cookies for BOTH the web host (where the
      // page is served) AND the API host (where the page's credentialed
      // `/cards/:id/render` + dashboard fetches go). In a cross-origin deploy
      // (`ATLAS_WEB_BASE_URL` = app host, data API on a separate host) the
      // forwarded cookie belongs to the API origin — scoping it only to the web
      // host would leave Playwright's jar without an API cookie, so the page's
      // fetches render an unauthenticated/error board. De-duped so a same-origin
      // deploy seeds each host once.
      const hosts = new Set<string>();
      for (const base of [args.baseUrl, args.apiBaseUrl]) {
        if (!base) continue;
        try {
          hosts.add(new URL(base).hostname);
        } catch (err) {
          log.debug({ base, err: errorMessage(err) }, "exportRender: unparseable cookie host — skipping");
        }
      }
      const cookies = [...hosts].flatMap((hostname) =>
        parsed.map((c) => ({ name: c.name, value: c.value, domain: hostname, path: "/" })),
      );
      if (cookies.length > 0) await context.addCookies(cookies);
    }

    const page = await context.newPage();
    try {
      const target = new URL(`/dashboards/${args.dashboardId}`, args.baseUrl);
      const dparams = serializeDparams(args.parameters);
      if (dparams) target.searchParams.set("dparams", dparams);

      // Bound every staged wait by the remaining wall-clock budget (minus a
      // capture reserve) so the staged waits can never starve the screenshot/PDF
      // capture and 504 the whole export. A stage whose budget is exhausted is
      // skipped and flips `partial` — a slow board degrades to the documented
      // partial artifact rather than a timeout.
      let partial = false;
      const deadline = Date.now() + args.timeoutMs;
      // Budget for a pre-capture wait: the smaller of its cap and the time left
      // before the capture reserve must begin. Can go non-positive (→ skipped).
      const stageBudget = (cap: number): number =>
        Math.min(cap, deadline - EXPORT_CAPTURE_RESERVE_MS - Date.now());

      // Navigation must complete to capture anything; bound it by the remaining
      // budget (never below 1s so a tiny budget still attempts the nav).
      const navTimeout = Math.max(1_000, Math.min(EXPORT_NAV_TIMEOUT_MS, deadline - Date.now()));
      await page.goto(target.toString(), { waitUntil: "networkidle", timeout: navTimeout });

      const gridBudget = stageBudget(EXPORT_GRID_WAIT_TIMEOUT_MS);
      if (gridBudget < EXPORT_MIN_WAIT_MS) {
        partial = true;
      } else {
        try {
          await page.waitForSelector(".dashboard-app", { timeout: gridBudget });
        } catch (err) {
          log.debug(
            { dashboardId: args.dashboardId, err: errorMessage(err) },
            "exportRender: grid container not found within budget — capturing as-is",
          );
          partial = true;
        }
      }

      // When parameter overrides are present, the page re-renders each card via
      // async `/cards/:id/render` calls AFTER mount — the board initially shows
      // its cached DEFAULT rows. Wait for the page's readiness signal
      // (`data-dashboard-export-ready="1"`, set once the dashboard has loaded
      // and any parameter batch has settled) so we never capture the
      // default-parameter board for a parameterized request.
      if (dparams) {
        const paramBudget = stageBudget(EXPORT_PARAM_WAIT_TIMEOUT_MS);
        if (paramBudget < EXPORT_MIN_WAIT_MS) {
          partial = true;
        } else {
          try {
            await page.waitForSelector('[data-dashboard-export-ready="1"]', { timeout: paramBudget });
          } catch (err) {
            log.debug(
              { dashboardId: args.dashboardId, err: errorMessage(err) },
              "exportRender: parameter renders did not settle within budget — exporting partial board",
            );
            partial = true;
          }
        }
      }

      const tileBudget = stageBudget(EXPORT_TILE_WAIT_TIMEOUT_MS);
      if (tileBudget < EXPORT_MIN_WAIT_MS) {
        partial = true;
      } else {
        try {
          // Playwright signature is waitForFunction(pageFunction, arg?, options?)
          // — the timeout MUST be the third arg. Passing it as the second
          // (`arg`) position silently falls back to the 30s default.
          await page.waitForFunction(EXPORT_TILE_CONTENT_PREDICATE, undefined, { timeout: tileBudget });
        } catch (err) {
          log.debug(
            { dashboardId: args.dashboardId, err: errorMessage(err) },
            "exportRender: not every tile rendered content within budget — exporting partial board",
          );
          partial = true;
        }
      }

      // Capture the grid element so app chrome (sidebar/topbar) is excluded and
      // a board taller than the viewport is captured whole. Fall back to a
      // full-page shot if the grid never mounted (e.g. the empty-canvas state).
      const gridHandle = await page.$(".dashboard-app");
      const png = gridHandle
        ? await gridHandle.screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: true });

      if (args.format === "png") {
        return { bytes: png, contentType: "image/png", partial };
      }

      const box = gridHandle ? await gridHandle.boundingBox() : null;
      const cssWidth = box && box.width > 0 ? Math.round(box.width) : EXPORT_VIEWPORT_WIDTH;
      const pdf = await renderPdfFromPng(page, png, {
        title: args.title,
        generatedAt: args.generatedAt,
        partial,
        cssWidth,
      });
      return { bytes: pdf, contentType: "application/pdf", partial };
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

/**
 * Wrap a captured board PNG in a one-page print document (title + timestamp
 * header) and let the SAME headless page emit a PDF. Sizing the single page to
 * the rendered content keeps the multi-card layout intact — no card is split
 * across a page break.
 */
async function renderPdfFromPng(
  page: ExportPage,
  png: Buffer,
  meta: { title: string; generatedAt: string; partial: boolean; cssWidth: number },
): Promise<Buffer> {
  const b64 = png.toString("base64");
  const partialNote = meta.partial
    ? ' &middot; <span style="color:#b45309">partial export — some tiles did not finish rendering</span>'
    : "";
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `@page { margin: 0; }` +
    `html, body { margin: 0; padding: 0; background: #ffffff; }` +
    `body { width: ${meta.cssWidth}px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #18181b; }` +
    `.hdr { padding: 20px 24px 14px; border-bottom: 1px solid #e4e4e7; }` +
    `.title { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }` +
    `.meta { margin-top: 3px; font-size: 11px; color: #71717a; }` +
    `.board { display: block; width: 100%; height: auto; }` +
    `</style></head><body>` +
    `<div class="hdr"><div class="title">${escapeHtml(meta.title)}</div>` +
    `<div class="meta">Generated ${escapeHtml(meta.generatedAt)}${partialNote}</div></div>` +
    `<img class="board" src="data:image/png;base64,${b64}" />` +
    `</body></html>`;

  await page.setContent(html, { waitUntil: "load" });
  // The wrapper doc has no print-specific styles; keep screen rendering so the
  // header + image lay out exactly as authored.
  await page.emulateMedia({ media: "screen" });

  const dims = (await page.evaluate(
    `(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }))()`,
  )) as { w: number; h: number };
  const width = Math.max(1, Math.round(dims.w || meta.cssWidth));
  const height = Math.max(1, Math.round(dims.h || EXPORT_VIEWPORT_HEIGHT));

  return page.pdf({
    width: `${width}px`,
    height: `${height}px`,
    printBackground: true,
    pageRanges: "1",
  });
}
