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
import { runHandler } from "@atlas/api/lib/effect/hono";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  coerceRepresentationMode,
  isValidSnapshot,
  type OpenApiAuthKind,
} from "@atlas/api/lib/openapi/catalog";
import {
  snapshotToGraph,
  invalidateInstallGraphCache,
  summarizeOperations,
} from "@atlas/api/lib/openapi/probe";
import { REPRESENTATION_MODES } from "@atlas/api/lib/openapi/representation";
import { normalizeGroupId } from "@atlas/api/lib/openapi/datasource";
import { verifyGroupBelongsToOrg } from "@atlas/api/lib/conversations";
import {
  coerceSpecRefreshInterval,
  normalizeSpecRefreshInterval,
} from "@atlas/api/lib/openapi/spec-refresh";
import { performRediscovery, persistRediscoverySnapshot } from "@atlas/api/lib/openapi/rediscover";
import { summarizeSpecDiffRecord } from "@atlas/api/lib/openapi/diff";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin.openapi-datasources");

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
    // #3044 — cross-environment scope (ADR-0010). `null` ⇒ workspace-global;
    // a string ⇒ scoped to that connection group. `normalizeGroupId` is the
    // shared empty→workspace-global coercion the resolver also uses.
    groupId: normalizeGroupId(c.group_id),
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
    // Spec-drift summary from the last re-discovery (#2976). Fail-soft: a missing
    // / malformed `openapi_last_diff` projects to `null` (no banner) instead of
    // rendering NaN counts. The full structured diff stays in config for #2979.
    lastRefresh: summarizeSpecDiffRecord(c.openapi_last_diff),
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
              // #3044 — cross-environment scope (ADR-0010). A non-empty string
              // scopes the datasource to that connection group; `null` clears the
              // assignment back to workspace-global. Omitted ⇒ left unchanged.
              groupId: z
                .string()
                .min(1)
                .nullable()
                .optional()
                .openapi({
                  description:
                    "Connection group this REST datasource is scoped to. A group id restricts the " +
                    "datasource to conversations whose active environment is that group; null clears the " +
                    "scope back to workspace-global (available in every environment).",
                  example: "prod",
                }),
            })
            .refine(
              (b) =>
                b.representationMode !== undefined ||
                b.specRefreshInterval !== undefined ||
                b.groupId !== undefined,
              { message: "Provide representationMode, specRefreshInterval, and/or groupId." },
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

    // Re-probe + re-normalize + diff via the shared core (#2978) — the exact same
    // egress-guarded path the scheduler uses, so manual and scheduled refreshes
    // can't drift. Decrypt happens inside (the encrypted `auth_value` never
    // round-trips through this layer); the result is a discriminated outcome we map
    // to an actionable 4xx, never a generic 500.
    let result: Awaited<ReturnType<typeof performRediscovery>>;
    try {
      result = await performRediscovery(row.config, installId);
    } catch (err) {
      // Unexpected fault from probe / snapshot-build / diff — attach the install
      // context before letting runHandler map it to a 500.
      log.warn({ installId, err: errorMessage(err) }, "Rediscover failed unexpectedly");
      throw err;
    }

    if (result.kind === "decrypt_failed") {
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
    if (result.kind === "no_url") {
      return c.json({ error: "bad_request", message: "Datasource has no spec URL to rediscover.", requestId }, 400);
    }
    if (result.kind === "unsupported_auth") {
      // Tailor the remediation: a deferred oauth2 row is "coming later"; any other
      // unsupported/drifted kind needs the operator to fix the config, so don't tell
      // them it's oauth2 when it isn't.
      const message =
        result.rawAuthKind === "oauth2"
          ? "This datasource uses oauth2 auth, which is not supported yet — rediscover is unavailable."
          : `This datasource has an unsupported auth kind ("${result.rawAuthKind}") — fix its config before rediscovering.`;
      return c.json({ error: "bad_request", message, requestId }, 400);
    }
    if (result.kind === "probe_failed") {
      log.warn({ installId, reason: result.reason }, "Rediscover probe failed");
      return c.json({ error: "probe_failed", message: result.message, requestId }, 400);
    }

    const { snapshot, diffRecord, drift } = result;

    // Persist the fresh snapshot AND the computed diff against the install in one
    // JSONB merge (AC2) + evict the in-process graph cache (#3009). The manual route
    // passes no watermark, so the merge is the pre-#2978 statement byte-for-byte.
    await persistRediscoverySnapshot(orgId, installId, snapshot, diffRecord);

    if (!drift) {
      // We just built and persisted `diffRecord`; if it fails to project, the
      // writer/reader contract has drifted (or the record is corrupt). The UI
      // still degrades to "no banner", but this self-written round-trip failure
      // must not be silent — surface it for log correlation.
      log.error(
        { installId, requestId },
        "Spec-diff record failed to project immediately after persist — drift summary unavailable",
      );
    }
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.probe,
      targetType: "connection",
      targetId: installId,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {
        installId,
        operationCount: snapshot.operationCount,
        kind: "openapi-rediscover",
        // Roll-up tallies so the audit log shows what a refresh moved, not just
        // that one ran — the same operation/schema/field counts the UI surfaces.
        ...(drift && !drift.baseline
          ? {
              driftUnchanged: drift.unchanged,
              operationsAdded: drift.counts.operationsAdded,
              operationsRemoved: drift.counts.operationsRemoved,
              operationsChanged: drift.counts.operationsChanged,
              schemasAdded: drift.counts.schemasAdded,
              schemasRemoved: drift.counts.schemasRemoved,
              schemasChanged: drift.counts.schemasChanged,
              fieldsAdded: drift.counts.fieldsAdded,
              fieldsRemoved: drift.counts.fieldsRemoved,
              fieldsRetyped: drift.counts.fieldsRetyped,
            }
          : {
              // Baseline: a first-ever discovery, OR a dropped comparison because
              // the prior snapshot no longer parsed. Stamp `priorParseFailed` so a
              // reset drift history that was actually a parse regression isn't
              // invisible in the audit trail.
              baseline: true,
              ...(drift?.priorParseFailed ? { priorParseFailed: true } : {}),
            }),
      },
    });

    return c.json(
      {
        rediscovered: true,
        operationCount: snapshot.operationCount,
        probedAt: snapshot.probedAt,
        // The drift summary so the UI can confirm what moved at the moment of
        // re-probe ("2 new operations, …" / "no changes"). `null` only if the
        // record we just wrote somehow fails projection — defensive.
        drift,
      },
      200,
    );
  }),
);

adminOpenApiDatasources.openapi(patchRoute, async (c) =>
  runHandler(c, "update openapi datasource", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { installId } = c.req.valid("param");
    const { representationMode, specRefreshInterval, groupId } = c.req.valid("json");
    const row = await loadInstall(orgId, installId);
    if (!row) {
      return c.json({ error: "not_found", message: `No OpenAPI datasource "${installId}".`, requestId }, 404);
    }

    // Collect the non-secret config fields this PATCH touches: the JSONB column
    // (snake_case) it writes, and the camelCase wire shape echoed in the response
    // + audit metadata. Each column key is from a fixed allow-set (never user
    // input) so interpolating it into the SQL is safe; the value is always bound.
    // A `null` value clears a field (writes JSON null) — used to unassign group_id.
    const updates: Record<string, string | null> = {};
    const changed: Record<string, string | null> = {};
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
    if (groupId !== undefined) {
      // #3044 — assign (string) or clear (null → JSON null, read back as
      // workspace-global) the cross-environment scope. `normalizeGroupId`
      // collapses null / "" / whitespace to the workspace-global clear.
      const value = normalizeGroupId(groupId);
      // A non-null assignment must reference an environment group that actually
      // exists in this workspace — otherwise the new scope filter hides the
      // datasource from every real environment until someone notices (Codex
      // review on #3048). Mirror the chat route's `verifyGroupBelongsToOrg`
      // org-scoped existence guard; clearing to workspace-global is never gated.
      if (value !== null) {
        const verdict = await verifyGroupBelongsToOrg(value, orgId);
        if (verdict === "not_found") {
          return c.json(
            {
              error: "invalid_connection_group",
              message: `Environment group "${value}" doesn't exist in this workspace. Create it by assigning a connection to it first, or pick an existing environment.`,
              requestId,
            },
            400,
          );
        }
        if (verdict === "error") {
          return c.json(
            { error: "internal_error", message: "Could not verify the environment group. Please retry.", requestId },
            500,
          );
        }
        // "ok" → exists; "no_db" → can't check (self-hosted without internal DB,
        // where REST installs can't exist anyway) → allow the write.
      }
      updates.group_id = value;
      changed.groupId = value;
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
