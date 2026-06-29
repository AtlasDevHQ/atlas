/**
 * `/api/*` response middleware that evicts the legacy parent-domain
 * (cross-subdomain) auth cookie shadowing the new host-only session (#4086).
 *
 * Thin Hono glue around the pure {@link buildLegacyCookieDeletions} helper —
 * kept in its own module (not inlined in `api/index.ts`) so the wiring test can
 * drive the EXACT production middleware rather than a hand-copied mirror that
 * could silently drift. The helper stays Hono-free; this file owns the coupling.
 *
 * Runs AFTER `next()`: it observes the route's finished response (Better Auth's
 * own `Set-Cookie` included) and APPENDS the parent-domain deletions, so the
 * live host-only cookie is never disturbed. The whole append is best-effort —
 * a cleanup failure must never turn a good auth response into a 500 — so it is
 * caught and logged, never re-thrown. See `legacy-cookie-cleanup.ts` for the
 * root-cause analysis and the self-limiting (≥2 duplicate) detection.
 */
import type { MiddlewareHandler } from "hono";
import { createLogger } from "@atlas/api/lib/logger";
import { resolveCookiePrefix } from "@atlas/api/lib/env-profile";
import { buildLegacyCookieDeletions } from "./legacy-cookie-cleanup";

const log = createLogger("auth");

/**
 * Build the cleanup middleware. `resolvePrefix` defaults to the deployment's
 * resolved cookie prefix (`resolveCookiePrefix(process.env)`); tests inject a
 * fixed prefix so the assertion doesn't hinge on the ambient `ATLAS_DEPLOY_ENV`
 * (which would otherwise flip the prefix between `atlas`/`atlas-dev`/`atlas-staging`).
 */
export function createLegacyCookieCleanupMiddleware(
  resolvePrefix: () => string = () => resolveCookiePrefix(process.env),
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    try {
      const deletions = buildLegacyCookieDeletions({
        cookieHeader: c.req.header("cookie"),
        host: c.req.header("host"),
        cookiePrefix: resolvePrefix(),
      });
      if (deletions.length === 0) return;
      for (const setCookie of deletions) {
        c.res.headers.append("set-cookie", setCookie);
      }
      // Migration telemetry: lets an operator watch the affected-browser tail
      // drain post-deploy. No cookie VALUES are logged (host + count only).
      log.info(
        { host: c.req.header("host"), count: deletions.length },
        "Evicted legacy parent-domain auth cookie shadow (#4086)",
      );
    } catch (err) {
      // Cleanup is best-effort; a failure must never break the auth response.
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: c.req.path,
          host: c.req.header("host"),
        },
        "Legacy parent-domain cookie cleanup failed (#4086)",
      );
    }
  };
}

/** Production singleton — reads the cookie prefix from the deployment env. */
export const legacyCookieCleanupMiddleware = createLegacyCookieCleanupMiddleware();
