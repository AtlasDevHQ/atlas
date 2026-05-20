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
 * Auth: install requires an authenticated workspace admin (per the F-04
 * install-hijack threat — without an org binding, an attacker can race
 * to claim a real OAuth token under their workspace). Callback verifies
 * the same binding via the state token signed at install time.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { runHandler } from "@atlas/api/lib/effect/hono";
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
 * Look up a catalog row by slug. Returns `null` when the row doesn't
 * exist or the row's `install_model` isn't one of the three known
 * dispatch values (the CHECK constraint normally prevents the latter,
 * but a planner-friendly assert keeps the route safe against a future
 * schema relaxation).
 */
async function getCatalogRowBySlug(slug: string): Promise<{
  slug: string;
  install_model: CatalogInstallModel;
} | null> {
  const rows = await internalQuery<CatalogRowFromDb>(
    `SELECT slug, install_model, enabled FROM plugin_catalog WHERE slug = $1 LIMIT 1`,
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

    // Org id is the WorkspaceId for the install row. Admin-mode "none"
    // (no-auth local dev) sets `activeOrganizationId = undefined`; we
    // accept that branch only for self-hosted (the SaaS-mode F-04 check
    // lives at the catalog gate, not here, because SaaS pins managed
    // auth so this code path can't be reached without an org id).
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json({ error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId }, 400);
    }
    // For "none" mode (self-hosted no-auth dev), use a sentinel
    // workspace id so the slice 4 state-token mint succeeds. Anyone
    // running self-hosted-no-auth is a single-tenant install; the
    // install row's workspace_id only needs to be stable for the dual-
    // store join.
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    // ── Catalog lookup ────────────────────────────────────────────
    const row = await getCatalogRowBySlug(platform);
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

    const row = await getCatalogRowBySlug(platform);
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
