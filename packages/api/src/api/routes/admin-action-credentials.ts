/**
 * Workspace-tier action-target credential routes (#3766).
 *
 * Mounted at /api/v1/admin/action-credentials. Workspace-admin + MFA (via
 * `createAdminRouter`) + `requireOrgContext`, so every read and write is
 * scoped to the caller's active workspace and a cross-workspace read is
 * unrepresentable — the org id comes from the request context, never from the
 * path or body.
 *
 * This is the TENANT-facing surface: a workspace admin points Atlas's action
 * targets at THEIR Jira, without operator involvement and without a redeploy.
 * It is the sibling of `admin-operator-integrations.ts`, one tier down — that
 * router is platform-admin-gated and configures Atlas's OWN app registrations;
 * this one is workspace-admin-gated and configures a customer's own external
 * systems.
 *
 * Precedence (decided in `lib/tools/actions/credentials/resolver.ts`):
 * workspace row → `process.env` on SELF-HOSTED ONLY → throw. There is no
 * operator rung for action targets: a "platform default Jira" serving several
 * tenants is exactly the multi-tenant confusion #3766 exists to eliminate.
 *
 * Security:
 *   - Secret values are NEVER echoed back. GET returns presence + source only
 *     (`getActionTargetStatus`); the masked status carries no secret bytes.
 *   - PUT merges non-empty fields over the stored bundle (blank = preserve) so
 *     a partially-filled form can't blank a real secret.
 *   - Unknown field keys in the body are DROPPED rather than persisted — the
 *     target's spec is the allowlist, so a client cannot smuggle an arbitrary
 *     env-var name into the encrypted bundle.
 *   - The audit row records the env-var NAMES written (`fieldsSet`) plus
 *     `hasSecret`, never the raw value (same convention as
 *     `operator_integration.*`). See `ADMIN_ACTIONS.workspaceActionCredential`.
 *
 * The managed target set lives in `lib/tools/actions/credentials/targets.ts`
 * (`ACTION_TARGETS`) — the reusable one-entry seam. This router has no
 * per-target branches; it iterates the registry. Adding Linear / GitHub App /
 * Salesforce is a registry entry, not a route change.
 *
 * @see ADR-0046 — per-workspace action credentials
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  ACTION_TARGETS,
  getActionTarget,
} from "@atlas/api/lib/tools/actions/credentials/targets";
import {
  getActionTargetStatus,
  resolveActionDeployMode,
  type ActionTargetStatus,
} from "@atlas/api/lib/tools/actions/credentials/resolver";
import {
  readActionCredentials,
  saveActionCredentials,
  deleteActionCredentials,
} from "@atlas/api/lib/tools/actions/credentials/store";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-action-credentials");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FieldStatusSchema = z.object({
  envVar: z.string().openapi({ description: "Env-var name this field maps to (bundle storage key + self-host env key)." }),
  label: z.string(),
  hint: z.string(),
  secret: z.boolean().openapi({ description: "True ⇒ masked in the UI + never echoed back on read." }),
  required: z.boolean().openapi({ description: "True ⇒ the target does not resolve without it." }),
  present: z.boolean().openapi({ description: "True ⇒ resolved to a non-empty value from the winning rung." }),
  source: z.enum(["workspace", "env", "unset"]).openapi({
    description:
      "Where the resolved value came from. `env` appears on self-hosted only, and only when no workspace row wins — the rungs are never mixed.",
  }),
});

const TargetStatusSchema = z.object({
  target: z.string().openapi({ description: "Action-target slug (e.g. `jira`)." }),
  label: z.string(),
  configured: z.boolean().openapi({ description: "True ⇒ every required field resolves for this workspace." }),
  resolvedFrom: z.enum(["workspace", "env"]).nullable().openapi({
    description: "The rung that would win at execution time, or null when unconfigured.",
  }),
  fields: z.array(FieldStatusSchema),
});

const ListResponseSchema = z.object({
  deployMode: z.enum(["saas", "self-hosted"]).openapi({
    description:
      "Resolved deploy mode. On `saas` the environment rung does not exist — a target is configured only by a workspace row.",
  }),
  targets: z.array(TargetStatusSchema),
});

const UpdateBodySchema = z.object({
  fields: z.record(z.string(), z.string()).openapi({
    description:
      "Map of env-var name → value. Blank values are ignored (they preserve the stored value rather than clearing it); keys outside the target's field spec are dropped.",
  }),
  clearFields: z
    .array(z.string())
    .optional()
    .openapi({
      description:
        "Env-var names to remove from the stored bundle. Blank values in `fields` deliberately PRESERVE a stored secret, so this is the only way to unset one — without it an optional field (e.g. a default project) could only be cleared by deleting the whole target and re-entering every credential. Required fields may be listed too; the target then reports unconfigured rather than resolving a partial row.",
    }),
});

const TargetParamSchema = z.object({
  target: z.string().openapi({ param: { name: "target", in: "path" }, example: "jira" }),
});

/**
 * Widen a {@link ActionTargetStatus} into the mutable shape the OpenAPI
 * response type wants. The resolver returns `readonly` arrays and fields on
 * purpose — a status object is a snapshot no caller should mutate — but
 * `zod-openapi` infers a mutable response type from the schema, so the two
 * meet here rather than by loosening the domain type.
 */
function toStatusResponse(status: ActionTargetStatus) {
  return {
    target: status.target,
    label: status.label,
    configured: status.configured,
    resolvedFrom: status.resolvedFrom,
    fields: status.fields.map((f) => ({
      envVar: f.envVar,
      label: f.label,
      hint: f.hint,
      secret: f.secret,
      required: f.required,
      present: f.present,
      source: f.source,
    })),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listTargetsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List action targets and their per-workspace credential status",
  tags: ["Admin — Action Credentials"],
  description:
    "Masked status only — presence + winning rung per field, never a secret value.",
  responses: {
    200: { description: "Target statuses", content: { "application/json": { schema: ListResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateTargetRoute = createRoute({
  method: "put",
  path: "/{target}",
  summary: "Set this workspace's credentials for an action target",
  tags: ["Admin — Action Credentials"],
  request: {
    params: TargetParamSchema,
    body: { content: { "application/json": { schema: UpdateBodySchema } }, required: true },
  },
  responses: {
    200: { description: "Updated status", content: { "application/json": { schema: TargetStatusSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Unknown target, or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteTargetRoute = createRoute({
  method: "delete",
  path: "/{target}",
  summary: "Clear this workspace's credentials for an action target",
  tags: ["Admin — Action Credentials"],
  request: { params: TargetParamSchema },
  responses: {
    200: { description: "Updated status", content: { "application/json": { schema: TargetStatusSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Unknown target, or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminActionCredentials = createAdminRouter();

adminActionCredentials.use(requireOrgContext());
// Action credentials are a workspace security configuration surface — same
// gate as the rest of the settings surface.
adminActionCredentials.use(requirePermission("admin:settings"));

adminActionCredentials.openapi(listTargetsRoute, async (c) => {
  const { orgId, requestId } = c.get("orgContext");
  const deployMode = resolveActionDeployMode();
  try {
    // One status read per target — independent, so they run concurrently
    // rather than as a waterfall.
    const targets = await Promise.all(
      ACTION_TARGETS.map((spec) =>
        getActionTargetStatus(spec.target, { workspaceId: orgId, deployMode }),
      ),
    );
    return c.json(
      {
        deployMode,
        targets: targets
          .filter((t): t is ActionTargetStatus => t !== null)
          .map(toStatusResponse),
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, requestId },
      "Failed to read action credential status",
    );
    return c.json(
      {
        error: "internal_error",
        message: "Failed to read action credential status. Retry; if it persists the stored credentials may need re-saving.",
        requestId,
      },
      500,
    );
  }
});

adminActionCredentials.openapi(updateTargetRoute, async (c) => {
  const { orgId, requestId } = c.get("orgContext");
  const { target } = c.req.valid("param");
  const body = c.req.valid("json");
  const deployMode = resolveActionDeployMode();

  const spec = getActionTarget(target);
  if (!spec) {
    return c.json(
      { error: "not_found", message: `Unknown action target: "${target}".`, requestId },
      404,
    );
  }
  if (!hasInternalDB()) {
    return c.json(
      {
        error: "not_available",
        message:
          "Per-workspace action credentials require an internal database (DATABASE_URL). Without one, set the target's environment variables instead.",
        requestId,
      },
      404,
    );
  }

  // The spec's field list is the ALLOWLIST — a key outside it never reaches the
  // encrypted bundle. Blank values are skipped so a partially-filled form
  // preserves stored secrets rather than blanking them.
  const declared = new Set(spec.fields.map((f) => f.envVar));
  const incoming: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body.fields)) {
    if (!declared.has(key)) {
      ignored.push(key);
      continue;
    }
    if (typeof value === "string" && value.trim().length > 0) incoming[key] = value.trim();
  }
  // Same allowlist applies to removals — a caller cannot name a key outside
  // the spec, so this can never reach into another target's stored bundle.
  const cleared = (body.clearFields ?? []).filter((key) => {
    if (declared.has(key)) return true;
    ignored.push(key);
    return false;
  });
  if (ignored.length > 0) {
    log.warn(
      { orgId, target: spec.target, ignored, requestId },
      "Dropped credential fields not declared by the action target spec",
    );
  }

  try {
    const existing = (await readActionCredentials(orgId, spec.target)) ?? {};
    const merged: Record<string, string> = { ...existing, ...incoming };
    // Removals apply AFTER the merge, so a key named in both `fields` and
    // `clearFields` ends up cleared — the explicit removal wins over a value
    // that may just be a stale form field.
    for (const key of cleared) delete merged[key];
    await saveActionCredentials(orgId, spec.target, merged);

    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.workspaceActionCredential.update,
      targetType: "workspaceActionCredential",
      targetId: `${orgId}:${spec.target}`,
      // Names only, never values — see the module doc.
      metadata: {
        target: spec.target,
        fieldsSet: Object.keys(incoming),
        fieldsCleared: cleared,
        hasSecret: spec.fields.some((f) => f.secret && incoming[f.envVar] !== undefined),
      },
    });

    // Non-null by construction: `getActionTarget(target)` already resolved the
    // same slug above, and both read the one registry.
    const status = await getActionTargetStatus(spec.target, {
      workspaceId: orgId,
      deployMode,
    });
    if (!status) {
      throw new Error(`Action target "${spec.target}" vanished from the registry mid-request`);
    }
    return c.json(toStatusResponse(status), 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, target: spec.target, requestId },
      "Failed to save workspace action credentials",
    );
    return c.json(
      {
        error: "internal_error",
        message: `Failed to save ${spec.label} credentials. Retry; if it persists, check the internal database connection.`,
        requestId,
      },
      500,
    );
  }
});

adminActionCredentials.openapi(deleteTargetRoute, async (c) => {
  const { orgId, requestId } = c.get("orgContext");
  const { target } = c.req.valid("param");
  const deployMode = resolveActionDeployMode();

  const spec = getActionTarget(target);
  if (!spec) {
    return c.json(
      { error: "not_found", message: `Unknown action target: "${target}".`, requestId },
      404,
    );
  }
  if (!hasInternalDB()) {
    return c.json(
      {
        error: "not_available",
        message:
          "Per-workspace action credentials require an internal database (DATABASE_URL).",
        requestId,
      },
      404,
    );
  }

  try {
    const removed = await deleteActionCredentials(orgId, spec.target);
    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.workspaceActionCredential.delete,
      targetType: "workspaceActionCredential",
      targetId: `${orgId}:${spec.target}`,
      metadata: { target: spec.target, removed },
    });
    // Non-null by construction — same registry lookup as the guard above.
    const status = await getActionTargetStatus(spec.target, {
      workspaceId: orgId,
      deployMode,
    });
    if (!status) {
      throw new Error(`Action target "${spec.target}" vanished from the registry mid-request`);
    }
    return c.json(toStatusResponse(status), 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, target: spec.target, requestId },
      "Failed to delete workspace action credentials",
    );
    return c.json(
      {
        error: "internal_error",
        message: `Failed to clear ${spec.label} credentials. Retry; if it persists, check the internal database connection.`,
        requestId,
      },
      500,
    );
  }
});

export { adminActionCredentials };
