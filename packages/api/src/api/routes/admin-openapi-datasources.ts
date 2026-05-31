/**
 * `admin-openapi-datasources` — management surface for installed generic OpenAPI
 * REST datasources (PRD #2868 slice 2, #2926). The install itself goes through
 * the integrations form-install pipeline (`POST /api/v1/integrations/openapi-generic/install-form`
 * → `OpenApiGenericFormInstallHandler`); this router owns the post-install
 * lifecycle the `/admin/connections` UI drives:
 *
 *   - `GET /`                       — list the workspace's REST datasources
 *   - `GET /{installId}`            — detail + the discovered operation surface
 *   - `POST /{installId}/rediscover`— re-probe the spec, refresh the snapshot
 *   - `PATCH /{installId}`          — flip the representation-mode toggle
 *   - `DELETE /{installId}`         — uninstall
 *
 * Lives alongside `admin-connections` (REST datasources ARE connections in the
 * user's mental model, ADR-0006) and reuses its `admin:connections` permission.
 * Reads/writes only NON-secret config fields directly (JSONB merge) so the
 * encrypted `auth_value` is never round-tripped through this layer; rediscover
 * decrypts solely to read the credential for the upstream probe.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { runHandler } from "@atlas/api/lib/effect/hono";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  coerceRepresentationMode,
  isValidSnapshot,
  type OpenApiSnapshot,
  type OpenApiAuthKind,
} from "@atlas/api/lib/openapi/catalog";
import {
  resolveAuthFromDecryptedConfig,
  probeSpec,
  buildSnapshot,
  snapshotToGraph,
  invalidateInstallGraphCache,
  summarizeOperations,
  OpenApiProbeError,
} from "@atlas/api/lib/openapi/probe";
import { REPRESENTATION_MODES } from "@atlas/api/lib/openapi/representation";
import {
  coerceSpecRefreshInterval,
  normalizeSpecRefreshInterval,
} from "@atlas/api/lib/openapi/spec-refresh";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin.openapi-datasources");

const SECRET_SCHEMA = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);

/**
 * Raw install row shape this router reads. A `type` (not `interface`) so it
 * satisfies `internalQuery`'s `Record<string, unknown>` constraint.
 */
type InstallRow = {
  readonly install_id: string;
  readonly config: Record<string, unknown> | null;
  readonly status: string;
};

/** Project the non-secret summary fields for a list/detail card from a config blob. */
function summarizeInstall(installId: string, config: Record<string, unknown> | null, status: string) {
  const c = config ?? {};
  // Validate the JSONB read-back rather than an unchecked cast — a drifted row
  // surfaces as `snapshot: null` (prompting a rediscover) instead of a card with
  // undefined title / NaN operationCount.
  const snapshot = isValidSnapshot(c.openapi_snapshot) ? c.openapi_snapshot : undefined;
  return {
    id: installId,
    displayName:
      (typeof c.display_name === "string" && c.display_name) ||
      snapshot?.title ||
      installId,
    authKind: (typeof c.auth_kind === "string" ? c.auth_kind : "none") as OpenApiAuthKind,
    openapiUrl: typeof c.openapi_url === "string" ? c.openapi_url : null,
    baseUrlOverride: typeof c.base_url_override === "string" ? c.base_url_override : null,
    representationMode: coerceRepresentationMode(c.representation_mode),
    // Per-install spec-refresh interval (#2977). Fail-soft display coercion so a
    // drifted / absent value renders as the `off` default rather than undefined.
    specRefreshInterval: coerceSpecRefreshInterval(c.spec_refresh_interval),
    status,
    snapshot: snapshot
      ? {
          title: snapshot.title,
          version: snapshot.version,
          openapiVersion: snapshot.openapiVersion,
          operationCount: snapshot.operationCount,
          probedAt: snapshot.probedAt,
        }
      : null,
  };
}

// ── Route schemas ──────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — OpenAPI Datasources"],
  summary: "List installed OpenAPI REST datasources",
  responses: {
    200: { description: "Datasource list", content: { "application/json": { schema: z.object({ datasources: z.array(z.record(z.string(), z.unknown())) }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/{installId}",
  tags: ["Admin — OpenAPI Datasources"],
  summary: "Get an OpenAPI datasource's detail + discovered operations",
  request: {
    params: z.object({ installId: z.string().min(1).openapi({ param: { name: "installId", in: "path" } }) }),
  },
  responses: {
    200: { description: "Datasource detail", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rediscoverRoute = createRoute({
  method: "post",
  path: "/{installId}/rediscover",
  tags: ["Admin — OpenAPI Datasources"],
  summary: "Re-probe the spec and refresh the cached snapshot",
  request: {
    params: z.object({ installId: z.string().min(1).openapi({ param: { name: "installId", in: "path" } }) }),
  },
  responses: {
    200: { description: "Snapshot refreshed", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Probe failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{installId}",
  tags: ["Admin — OpenAPI Datasources"],
  summary: "Update non-secret install config (representation mode, spec refresh interval)",
  request: {
    params: z.object({ installId: z.string().min(1).openapi({ param: { name: "installId", in: "path" } }) }),
    body: {
      content: {
        "application/json": {
          // Both fields optional — a partial PATCH updates only what's provided.
          // `specRefreshInterval` is a free string validated + clamped in the
          // handler (off / daily / weekly / "<N>h"); the richer parse gives an
          // actionable 400 a bare enum couldn't (#2977).
          schema: z
            .object({
              representationMode: z.enum(REPRESENTATION_MODES).optional(),
              specRefreshInterval: z
                .string()
                .min(1)
                .optional()
                .openapi({
                  description:
                    "How often Atlas auto-refreshes the cached spec: 'off' (default, no auto-refresh), " +
                    "'daily', 'weekly', or a custom '<N>h' interval in hours (clamped to 1–720h / 30 days). " +
                    "Out-of-range positive values are clamped; unparseable values are rejected with an actionable error.",
                  example: "daily",
                }),
            })
            .refine(
              (b) => b.representationMode !== undefined || b.specRefreshInterval !== undefined,
              { message: "Provide representationMode and/or specRefreshInterval." },
            ),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{installId}",
  tags: ["Admin — OpenAPI Datasources"],
  summary: "Uninstall an OpenAPI datasource",
  request: {
    params: z.object({ installId: z.string().min(1).openapi({ param: { name: "installId", in: "path" } }) }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Router ───────────────────────────────────────────────────────────────

const adminOpenApiDatasources = createAdminRouter();
adminOpenApiDatasources.use(requireOrgContext());
adminOpenApiDatasources.use(requirePermission("admin:connections"));

/** Load one install scoped to the workspace, or `null` when it doesn't exist. */
async function loadInstall(orgId: string, installId: string): Promise<InstallRow | null> {
  const rows = await internalQuery<InstallRow>(
    `SELECT install_id, config, status
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2
        AND catalog_id = $3 AND pillar = 'datasource'
        AND status != 'archived'
      LIMIT 1`,
    [orgId, installId, OPENAPI_GENERIC_CATALOG_ID],
  );
  return rows[0] ?? null;
}

adminOpenApiDatasources.openapi(listRoute, async (c) =>
  runHandler(c, "list openapi datasources", async () => {
    const { orgId } = c.get("orgContext");
    const rows = await internalQuery<InstallRow>(
      `SELECT install_id, config, status
         FROM workspace_plugins
        WHERE workspace_id = $1 AND catalog_id = $2 AND pillar = 'datasource'
          AND status != 'archived'
        ORDER BY installed_at ASC`,
      [orgId, OPENAPI_GENERIC_CATALOG_ID],
    );
    return c.json(
      { datasources: rows.map((r) => summarizeInstall(r.install_id, r.config, r.status)) },
      200,
    );
  }),
);

adminOpenApiDatasources.openapi(detailRoute, async (c) =>
  runHandler(c, "get openapi datasource detail", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { installId } = c.req.valid("param");
    const row = await loadInstall(orgId, installId);
    if (!row) {
      return c.json({ error: "not_found", message: `No OpenAPI datasource "${installId}".`, requestId }, 404);
    }

    const summary = summarizeInstall(row.install_id, row.config, row.status);
    const rawSnapshot = (row.config ?? {}).openapi_snapshot;
    const snapshot = isValidSnapshot(rawSnapshot) ? rawSnapshot : undefined;

    // Rebuild the graph from the cached snapshot to list operations. A corrupt /
    // missing snapshot surfaces as an empty list + a flag so the UI prompts a
    // rediscover, rather than 500ing the whole detail view. Mapped to plain
    // mutable objects (summary fields + `summary: ... | null`) so the JSON
    // response satisfies the typed-response `JSONValue` shape.
    let operations: Array<{ operationId: string; method: string; path: string; summary: string | null }> = [];
    let snapshotError = false;
    if (snapshot) {
      try {
        operations = summarizeOperations(snapshotToGraph(orgId, installId, snapshot)).map((o) => ({
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary ?? null,
        }));
      } catch (err) {
        snapshotError = true;
        log.warn(
          { installId, err: errorMessage(err) },
          "Failed to rebuild graph from snapshot for detail view",
        );
      }
    } else {
      snapshotError = true;
    }

    return c.json({ ...summary, operations, snapshotError }, 200);
  }),
);

adminOpenApiDatasources.openapi(rediscoverRoute, async (c) =>
  runHandler(c, "rediscover openapi datasource", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { installId } = c.req.valid("param");
    const row = await loadInstall(orgId, installId);
    if (!row) {
      return c.json({ error: "not_found", message: `No OpenAPI datasource "${installId}".`, requestId }, 404);
    }

    // Decrypt ONLY to read the credential + URL for the upstream probe; the
    // snapshot we write back is non-secret, merged via JSONB || so the encrypted
    // auth_value never round-trips through this layer. A decrypt failure (e.g. a
    // rotated-away key version) is surfaced as an actionable 400, not a generic 500.
    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(row.config ?? {}, SECRET_SCHEMA);
    } catch (err) {
      log.warn({ installId, err: errorMessage(err) }, "Rediscover credential decrypt failed");
      return c.json(
        {
          error: "decrypt_failed",
          message:
            "Could not decrypt the stored credential (the encryption key may have rotated). " +
            "Reinstall the datasource with a fresh credential.",
          requestId,
        },
        400,
      );
    }
    const openapiUrl = typeof decrypted.openapi_url === "string" ? decrypted.openapi_url : "";
    if (!openapiUrl) {
      return c.json({ error: "bad_request", message: "Datasource has no spec URL to rediscover.", requestId }, 400);
    }
    // Narrow + build the credential via the glue shared with the workspace
    // resolver. A drifted row could carry the deferred oauth2 kind (or garbage) —
    // `ok: false` becomes an actionable 400 rather than letting buildResolvedAuth's
    // exhaustiveness guard 500. Tailor the remediation: a deferred oauth2 row is
    // "coming later"; any other unsupported/drifted kind needs the operator to fix
    // the config, so don't tell them it's oauth2 when it isn't.
    const authResult = resolveAuthFromDecryptedConfig(decrypted);
    if (!authResult.ok) {
      const message =
        authResult.rawAuthKind === "oauth2"
          ? "This datasource uses oauth2 auth, which is not supported yet — rediscover is unavailable."
          : `This datasource has an unsupported auth kind ("${authResult.rawAuthKind}") — fix its config before rediscovering.`;
      return c.json({ error: "bad_request", message, requestId }, 400);
    }
    const auth = authResult.auth;

    // Host-match credential gate (#3034): the re-probe attaches the stored
    // credential ONLY when the spec host matches the datasource's API host. This
    // route manages generic OpenAPI installs, whose API host is the admin-supplied
    // `base_url_override` (absent ⇒ the credential is withheld — the same fail-safe
    // the install path applies, so install + rediscover stay symmetric).
    const baseUrlOverride =
      typeof decrypted.base_url_override === "string" ? decrypted.base_url_override : undefined;

    let snapshot: OpenApiSnapshot;
    try {
      const { doc, graph } = await probeSpec(openapiUrl, auth, {
        ...(baseUrlOverride ? { apiBaseUrl: baseUrlOverride } : {}),
      });
      snapshot = buildSnapshot(doc, graph, new Date().toISOString());
    } catch (err) {
      if (err instanceof OpenApiProbeError) {
        log.warn({ installId, reason: err.reason }, "Rediscover probe failed");
        return c.json({ error: "probe_failed", message: err.message, requestId }, 400);
      }
      throw err;
    }

    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('openapi_snapshot', $4::jsonb),
              updated_at = NOW()
        WHERE workspace_id = $1 AND install_id = $2 AND catalog_id = $3 AND pillar = 'datasource'`,
      [orgId, installId, OPENAPI_GENERIC_CATALOG_ID, JSON.stringify(snapshot)],
    );

    // Drop the in-process graph cache for this install: the re-probe bumped
    // `probedAt`, so the next resolve rebuilds under the fresh key and the now-
    // orphaned prior-`probedAt` entry is reclaimed instead of leaking (#3009).
    invalidateInstallGraphCache(orgId, installId);

    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.probe,
      targetType: "connection",
      targetId: installId,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { installId, operationCount: snapshot.operationCount, kind: "openapi-rediscover" },
    });

    return c.json(
      { rediscovered: true, operationCount: snapshot.operationCount, probedAt: snapshot.probedAt },
      200,
    );
  }),
);

adminOpenApiDatasources.openapi(patchRoute, async (c) =>
  runHandler(c, "update openapi datasource", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { installId } = c.req.valid("param");
    const { representationMode, specRefreshInterval } = c.req.valid("json");
    const row = await loadInstall(orgId, installId);
    if (!row) {
      return c.json({ error: "not_found", message: `No OpenAPI datasource "${installId}".`, requestId }, 404);
    }

    // Collect the non-secret config fields this PATCH touches: the JSONB column
    // (snake_case) it writes, and the camelCase wire shape echoed in the response
    // + audit metadata. Each column key is from a fixed allow-set (never user
    // input) so interpolating it into the SQL is safe; the value is always bound.
    const updates: Record<string, string> = {};
    const changed: Record<string, string> = {};
    if (representationMode !== undefined) {
      updates.representation_mode = representationMode;
      changed.representationMode = representationMode;
    }
    if (specRefreshInterval !== undefined) {
      // Validate + clamp here so an invalid interval is an actionable 400, never a
      // silent fallback to off (#2977 / CLAUDE.md error-handling). An out-of-range
      // but positive value is clamped (e.g. "9000h" → the 30-day ceiling).
      const normalized = normalizeSpecRefreshInterval(specRefreshInterval);
      if (!normalized.ok) {
        return c.json({ error: "bad_request", message: normalized.message, requestId }, 400);
      }
      updates.spec_refresh_interval = normalized.value;
      changed.specRefreshInterval = normalized.value;
    }

    // JSONB merge of only the provided fields — the encrypted auth_value is
    // untouched. Representation-only PATCH keeps the exact single-key SQL shape.
    const keys = Object.keys(updates);
    const pairs = keys.map((key, i) => `'${key}', $${i + 4}::text`).join(", ");
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object(${pairs}),
              updated_at = NOW()
        WHERE workspace_id = $1 AND install_id = $2 AND catalog_id = $3 AND pillar = 'datasource'`,
      [orgId, installId, OPENAPI_GENERIC_CATALOG_ID, ...keys.map((k) => updates[k])],
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.update,
      targetType: "connection",
      targetId: installId,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { installId, ...changed, kind: "openapi-config-update" },
    });

    return c.json({ updated: true, ...changed }, 200);
  }),
);

adminOpenApiDatasources.openapi(deleteRoute, async (c) =>
  runHandler(c, "delete openapi datasource", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { installId } = c.req.valid("param");
    const rows = await internalQuery<{ install_id: string }>(
      `DELETE FROM workspace_plugins
        WHERE workspace_id = $1 AND install_id = $2 AND catalog_id = $3 AND pillar = 'datasource'
        RETURNING install_id`,
      [orgId, installId, OPENAPI_GENERIC_CATALOG_ID],
    );
    if (rows.length === 0) {
      return c.json({ error: "not_found", message: `No OpenAPI datasource "${installId}".`, requestId }, 404);
    }

    // Reclaim the uninstalled datasource's cached graph(s) so a stale shape can't
    // linger in-process after the row is gone (#3009).
    invalidateInstallGraphCache(orgId, installId);

    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.delete,
      targetType: "connection",
      targetId: installId,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { installId, kind: "openapi-uninstall" },
    });

    return c.json({ deleted: true }, 200);
  }),
);

export { adminOpenApiDatasources };
