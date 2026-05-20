/**
 * Platform install routes — slice 5 of #2649 (issue #2653).
 *
 * `/api/v1/integrations/:platform/install`  — start the OAuth dance
 * `/api/v1/integrations/:platform/callback` — handle the OAuth callback
 *
 * The handler family is dispatched by `getInstallHandler(catalogRow)`
 * from `lib/integrations/install`. This router is generic over the
 * Platform: it resolves the catalog row by slug, narrows the dispatch
 * result on `kind`, and calls into the per-Platform handler. Per-Platform
 * details (Slack's `oauth.v2.access`, Jira's `oauth/token`, etc.) live
 * in the registered handler, not here.
 *
 * Today only `install_model: "oauth"` is supported (slice 5 — Slack).
 * Form-based and static-bot install models surface a clear 400 — their
 * UI flows differ (form submit vs. routing-id capture) and don't share
 * this router's redirect-and-callback shape.
 *
 * Mount sibling: `integrations-catalog.ts` is also mounted at
 * `/api/v1/integrations` (path `/catalog`) and uses `createAdminRouter()`
 * which applies `adminAuth` + `mfaRequired` middleware. Hono scopes
 * sub-router middleware to that sub-router's own routes — the admin gate
 * does NOT bleed into this router's `/:platform/install,callback`. The
 * two sub-routers share a mount prefix but have non-overlapping paths
 * (`/catalog` is never a valid platform slug because the row id
 * `catalog:catalog` would never be seeded, and the catalog router owns
 * the `/catalog` segment first).
 *
 * Auth: install requires an authenticated workspace admin (per the F-04
 * install-hijack threat — without an org binding, an attacker can race
 * to claim a real OAuth token under their workspace). Callback verifies
 * the same binding via the state token signed at install time. In SaaS
 * deploy mode, the `mode === "none"` no-auth branch is refused outright
 * — managed-auth misconfig must never let an install land without an
 * org binding (would write under a shared sentinel workspace id).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { getConfig } from "@atlas/api/lib/config";
import { getInstallHandler } from "@atlas/api/lib/integrations/install";
import { adminAuthPreamble } from "./admin-auth";
import { validationHook } from "./validation-hook";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import type { WorkspaceId } from "@useatlas/types";
import type { CatalogInstallModel } from "@atlas/api/lib/config";

const log = createLogger("integrations");

const integrations = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/{platform}/install",
  tags: ["Integrations"],
  summary: "Platform OAuth install redirect",
  description:
    "Redirects to the Platform's OAuth authorization page. Requires the caller to be an " +
    "authenticated workspace admin — the state token binds the resulting install record " +
    "to the caller's workspace.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug (e.g. 'slack')" }),
    }),
  },
  responses: {
    302: { description: "Redirect to Platform OAuth authorization page" },
    400: { description: "Platform is not OAuth-installable, or unknown", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Not authenticated", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Caller is not a workspace admin", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Platform not found in catalog", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: AuthErrorSchema } } },
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/{platform}/callback",
  tags: ["Integrations"],
  summary: "Platform OAuth callback",
  description:
    "Handles the OAuth callback from the Platform: verifies the state token, exchanges the " +
    "code for credentials, and writes the install record + per-Platform credential. Returns " +
    "a 302 to /admin/integrations on success.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug" }),
    }),
    query: z.object({
      code: z.string().openapi({ description: "OAuth authorization code" }),
      state: z.string().openapi({ description: "Signed state token from install" }),
    }),
  },
  responses: {
    302: { description: "Install complete — redirected to /admin/integrations" },
    400: { description: "Invalid or expired state, or unknown platform", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Platform not found in catalog", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Upstream Platform rejected the OAuth exchange", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogRowFromDb extends Record<string, unknown> {
  readonly slug: string;
  readonly install_model: string;
  readonly enabled: boolean;
}

/**
 * Look up an *installable* catalog row by slug. Returns `null` when the
 * row doesn't exist, has been disabled by ops (`enabled = false`), or
 * carries an unknown `install_model` (the CHECK constraint normally
 * prevents the latter, but a planner-friendly assert keeps the route
 * safe against a future schema relaxation).
 *
 * The `enabled = true` predicate is load-bearing: ops can flip a row to
 * disabled in the DB without a deploy (see ADR-0002 S3 — the seeder
 * preserves DB-side `enabled=false`). Without this gate, a disabled
 * platform could still be installed by hitting the URL directly,
 * defeating the kill switch.
 */
async function getInstallableCatalogRowBySlug(slug: string): Promise<{
  slug: string;
  install_model: CatalogInstallModel;
} | null> {
  const rows = await internalQuery<CatalogRowFromDb>(
    `SELECT slug, install_model, enabled
       FROM plugin_catalog
      WHERE slug = $1 AND enabled = true
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.install_model !== "oauth" && row.install_model !== "form" && row.install_model !== "static-bot") {
    log.warn({ slug, install_model: row.install_model }, "Unknown install_model in plugin_catalog row");
    return null;
  }
  return { slug: row.slug, install_model: row.install_model as CatalogInstallModel };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

integrations.openapi(installRoute, async (c) =>
  runHandler(c, "platform install", async () => {
    const { platform } = c.req.valid("param");

    // ── Admin auth ────────────────────────────────────────────────
    const requestId = crypto.randomUUID();
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers);
    }

    // Org id is the WorkspaceId for the install row.
    //
    // F-04 fail-closed under SaaS: if auth mode is "none" (no-auth) AND
    // the deploy is SaaS, refuse outright. SaaS pins managed auth in
    // config, so a mode=none branch here means auth middleware
    // regressed or is misconfigured. Allowing an OAuth dance to land
    // with a shared sentinel workspaceId would write tenant-shared
    // install + credential rows — the exact install-hijack the legacy
    // route's SaaS-mode guard prevented. Self-hosted no-auth keeps the
    // sentinel branch for single-tenant dev.
    const deployMode = getConfig()?.deployMode;
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (preamble.authResult.mode === "none" && deployMode === "saas") {
      log.warn({ deployMode }, "Refusing install: SaaS deploy with mode=none is a misconfig");
      return c.json(
        { error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId },
        400,
      );
    }
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json({ error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId }, 400);
    }
    // For "none" mode (self-hosted no-auth dev only — SaaS branch
    // refused above), use a sentinel workspace id so the slice 4
    // state-token mint succeeds. Anyone running self-hosted-no-auth is
    // a single-tenant install; the install row's workspace_id only
    // needs to be stable for the dual-store join.
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    // ── Catalog lookup ────────────────────────────────────────────
    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    if (row.install_model !== "oauth") {
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not OAuth-installable via this route.`, requestId },
        400,
      );
    }

    // ── Dispatch + start install ──────────────────────────────────
    let handler: ReturnType<typeof getInstallHandler>;
    try {
      handler = getInstallHandler(row);
    } catch (err) {
      log.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        "No install handler registered for platform — operator must wire the handler",
      );
      return c.json(
        { error: "handler_unavailable", message: `OAuth handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }
    if (handler.kind !== "oauth") {
      // Catalog said OAuth, dispatch returned a non-OAuth handler — a
      // config drift; treat as 500-equivalent for the route's invariants.
      log.error({ platform, kind: handler.kind }, "Catalog install_model='oauth' but dispatch returned non-OAuth handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    const { redirectUrl } = await handler.startInstall(workspaceId);
    return c.redirect(redirectUrl);
  }),
);

integrations.openapi(callbackRoute, async (c) =>
  runHandler(c, "platform callback", async () => {
    const { platform } = c.req.valid("param");
    const { code, state } = c.req.valid("query");
    const requestId = crypto.randomUUID();

    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    if (row.install_model !== "oauth") {
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not OAuth-installable via this route.`, requestId },
        400,
      );
    }

    let handler: ReturnType<typeof getInstallHandler>;
    try {
      handler = getInstallHandler(row);
    } catch (err) {
      log.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        "No install handler registered for platform",
      );
      return c.json(
        { error: "handler_unavailable", message: `OAuth handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }
    if (handler.kind !== "oauth") {
      log.error({ platform, kind: handler.kind }, "Catalog install_model='oauth' but dispatch returned non-OAuth handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    const result = await handler.handleCallback(code, state);
    if (result === null) {
      return c.json(
        { error: "invalid_state", message: "Invalid or expired install state. Restart the install from /admin/integrations.", requestId },
        400,
      );
    }

    // Success — redirect to admin UI. Partial-failure (credential write
    // didn't land) flips the query param so /admin/integrations shows
    // a Reconnect affordance per ADR-0003.
    const webOrigin = getWebOrigin();
    const queryParam = result.credentialResult.written ? "installed" : "reconnect";
    const target = webOrigin
      ? `${webOrigin}/admin/integrations?${queryParam}=${encodeURIComponent(platform)}`
      : `/admin/integrations?${queryParam}=${encodeURIComponent(platform)}`;
    return c.redirect(target);
  }),
);

export { integrations };
