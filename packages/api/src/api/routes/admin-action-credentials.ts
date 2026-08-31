/**
 * Workspace-tier action-target credential routes (#3766).
 *
 * ⚠️ A PUT whose MERGED result would leave a required field unset is rejected
 * with 400, and persists nothing (#5564). Under ADR-0046's all-or-nothing rung
 * rule the row such a save would create does not degrade to `process.env` — it
 * SHADOWS it, so on a self-hosted deploy a half-finished form entry silently
 * breaks a target that was working from environment variables. The check lives
 * here rather than in the schema because the bundle is one AES-GCM ciphertext
 * column: Postgres cannot inspect the fields inside it, so no CHECK constraint
 * can express completeness. That is a consequence of encryption at rest, not an
 * oversight, and it is why this handler is the only thing standing between an
 * admin and that row.
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
 *   - PUT validates the MERGED bundle before persisting it, so a save cannot
 *     leave a required field unset. The validated value IS the persisted value
 *     — the merge happens once and both the check and the write read that one
 *     object, because a check that re-derives its own copy is a check that can
 *     disagree with the write.
 *   - Unknown field keys in the body are DROPPED rather than persisted — the
 *     target's spec is the allowlist, so a client cannot smuggle an arbitrary
 *     env-var name into the encrypted bundle.
 *   - The audit row records the env-var NAMES written (`fieldsSet`) plus
 *     `hasSecret`, never the raw value (same convention as
 *     `operator_integration.*`). See `ADMIN_ACTIONS.workspaceActionCredential`.
 *
 * The managed target set lives in `lib/tools/actions/credentials/targets.ts`
 * (`ACTION_TARGETS`) — the reusable one-entry seam. This router has no
 * per-target branches; it iterates the registry. Adding Linear / Salesforce is
 * a registry entry, not a route change.
 *
 * GitHub (#5555) is the one entry so far that also moved this file, and the
 * distinction is the one the seam turns on: it added a FIELD ATTRIBUTE to the
 * shared spec (`multiline`, so a PEM key renders as a textarea), which this
 * router passes through for every target alike. That is the spec growing, not
 * a branch — there is still no `if (target === …)` anywhere below.
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
  unsatisfiedRequiredFields,
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
  multiline: z.boolean().openapi({
    description:
      "True ⇒ the value spans several lines (e.g. a PEM private key), so the form should render a textarea rather than a single-line input.",
  }),
  present: z.boolean().openapi({ description: "True ⇒ resolved to a non-empty value from the winning rung." }),
  source: z.enum(["workspace", "env", "unset"]).openapi({
    description:
      "Where the resolved value came from. `env` appears on self-hosted only, and only when no workspace row wins — the rungs are never mixed.",
  }),
  stored: z.boolean().openapi({
    description:
      "True ⇒ this workspace's stored row carries a non-empty value for this field, whichever rung wins. Differs from `present` only in the two partial-row states, where nothing resolves and every field reports `source: \"unset\"` — this still says which of them the row holds. Presence only, never a value.",
  }),
});

const TargetStatusSchema = z.object({
  target: z.string().openapi({ description: "Action-target slug (e.g. `jira`)." }),
  label: z.string(),
  state: z
    .enum(["unconfigured", "workspace", "env", "partial-row", "partial-row-shadowing-env"])
    .openapi({
      description:
        "This target's single configuration state for this workspace. `unconfigured` — no stored row, and no complete environment rung. `workspace` — a complete stored row resolves. `env` — no stored row, and a complete environment rung resolves (self-hosted only). `partial-row` — a stored row is missing a required field, so the target throws at execution time. `partial-row-shadowing-env` — the same, but a complete environment rung is being shadowed by that row, so a target that previously worked is now broken (self-hosted only). Replaces the former `configured` / `resolvedFrom` pair, which could not distinguish an incomplete stored row from no row at all.",
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
        "Env-var names to remove from the stored bundle. Blank values in `fields` deliberately PRESERVE a stored secret, so this is the only way to unset one — without it an optional field (e.g. a default project) could only be cleared by deleting the whole target and re-entering every credential. Clearing a REQUIRED field is always rejected with 400 — removals apply after the merge, so naming one here leaves it unset even if the same request supplies a value, and the row that would leave behind shadows the environment rung instead of falling back to it. To replace a required value, send the new one in `fields`; to abandon the target, DELETE it, which clears the row outright and is not gated on completeness.",
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
    state: status.state,
    fields: status.fields.map((f) => ({
      envVar: f.envVar,
      label: f.label,
      hint: f.hint,
      secret: f.secret,
      required: f.required,
      multiline: f.multiline,
      present: f.present,
      source: f.source,
      stored: f.stored,
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
    400: {
      description:
        "No active organization, or the merged result would leave a required field unset. In the latter case nothing is persisted and the message names the unsatisfied fields.",
      content: { "application/json": { schema: ErrorSchema } },
    },
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

    // ── The completeness gate (#5564) ────────────────────────────────────
    //
    // Asked of `merged` — the exact object the next line persists — and asked
    // through the resolver's own predicate, so "complete enough to save" and
    // "complete enough to execute" cannot drift into two different questions.
    // Re-reading the row to check it would be a check that races its own write.
    //
    // Strict, with no exception for "the admin will finish it later": the row a
    // partial save creates does not sit inert, it SHADOWS the environment rung
    // (ADR-0046), so on self-hosted it breaks a target that was working. The
    // way out of a target an admin no longer wants is DELETE, which clears the
    // row whole and is deliberately not gated on completeness — so refusing
    // here traps nobody.
    const unsatisfied = unsatisfiedRequiredFields(spec, (key) => merged[key]);
    if (unsatisfied.length > 0) {
      const labels = spec.fields
        .filter((f) => unsatisfied.includes(f.envVar))
        .map((f) => `${f.label} (${f.envVar})`);
      log.warn(
        { orgId, target: spec.target, unsatisfied, requestId },
        "Rejected an action-credential save that would leave a partial row",
      );
      return c.json(
        {
          error: "incomplete_credentials",
          // Names only — `unsatisfied` is a list of env-var names off the spec,
          // never a stored or submitted value.
          message:
            `${spec.label} credentials are all-or-nothing: saving this would leave ${labels.join(", ")} unset, ` +
            `and the incomplete entry stops ${spec.label} actions rather than falling back to this deployment's environment. ` +
            `Supply every required field in one request, or clear the target entirely with DELETE /api/v1/admin/action-credentials/${spec.target}.`,
          requestId,
        },
        400,
      );
    }

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
