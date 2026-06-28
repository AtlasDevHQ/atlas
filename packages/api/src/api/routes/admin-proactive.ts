/**
 * Admin proactive-chat configuration routes.
 *
 * Mounted under /api/v1/admin/proactive. Enterprise-gated — every route
 * fails with `EnterpriseError` (→ 403 `enterprise_required` via
 * `classifyError`) when the feature flag is off, so AdminContentWrapper's
 * `EnterpriseUpsell` / the `<FeatureGate feature="Proactive Chat">`
 * boundary renders the upsell instead of letting a non-enterprise tenant
 * configure the agent's interjection radius.
 *
 * Surface (#2294, PRD #2291):
 *   GET    /workspace                — return-or-default-create the
 *                                       workspace row. First read
 *                                       materialises a row with
 *                                       `enabled = false` defaults so the
 *                                       admin page renders without null
 *                                       checks on every field.
 *   PUT    /workspace                — update master toggle + sensitivity
 *                                       / classifier mode / announcement
 *                                       channel / monthly cap.
 *   GET    /channels                 — list every channel override for
 *                                       the active workspace.
 *   POST   /channels                 — upsert one channel override on
 *                                       (workspaceId, channelId).
 *                                       Idempotent.
 *   DELETE /channels/:channelId      — remove one channel override.
 *
 * Persistence layout lives in migration 0073 — `workspace_proactive_config`
 * (one row per workspace) and `channel_proactive_config` (N rows per
 * workspace, unique on (workspace_id, channel_id)).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
import { requireFeatureEntitlementOrThrow } from "@atlas/api/lib/billing/feature-entitlement-guard";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { ProactiveService } from "@atlas/api/lib/effect/services";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-proactive");

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * Sensitivity enum lives next to the route file rather than in
 * `@useatlas/types` for now — the value list is duplicated in the migration
 * CHECK and the schema.ts mirror, so colocating the tuple keeps the three
 * sources of truth visibly adjacent. Promote to a shared type the second a
 * second consumer needs it.
 */
const SENSITIVITY_VALUES = ["cautious", "balanced", "eager"] as const;
const CLASSIFIER_MODE_VALUES = ["regex-prefilter", "classify-all"] as const;

const SensitivitySchema = z.enum(SENSITIVITY_VALUES);
const ClassifierModeSchema = z.enum(CLASSIFIER_MODE_VALUES);

const WorkspaceConfigSchema = z.object({
  workspaceId: z.string(),
  enabled: z.boolean(),
  sensitivity: SensitivitySchema,
  classifierMode: ClassifierModeSchema,
  announcementChannelId: z.string().nullable(),
  monthlyClassifierCap: z.number().int().nonnegative().nullable(),
  /**
   * One-shot activation announcement stamp (#2300). `null` until the
   * AnnouncementCoordinator successfully posts to
   * `announcement_channel_id`. Exposed on the wire so admin UIs can
   * surface "we already announced" affordances.
   */
  announcementPostedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const UpdateWorkspaceBodySchema = z.object({
  enabled: z.boolean().optional(),
  sensitivity: SensitivitySchema.optional(),
  classifierMode: ClassifierModeSchema.optional(),
  /** Pass `null` to clear, omit to leave unchanged. */
  announcementChannelId: z.string().nullable().optional(),
  /** Pass `null` to clear the cap, omit to leave unchanged. Non-negative. */
  monthlyClassifierCap: z.number().int().nonnegative().nullable().optional(),
});

const ChannelOverrideSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  allow: z.boolean(),
  sensitivity: SensitivitySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Partial-update semantics mirror the workspace PUT: omit a field to
 * leave the persisted value alone, pass `null` (sensitivity only) to
 * explicitly clear. This is what lets the admin table's inline editors
 * POST only the field the user touched — composing the companion field
 * from client-side row props raced concurrent edits (the refetch after
 * a save is fire-and-forget, so a quick second edit would resend the
 * first field's pre-save value and silently undo it).
 */
const UpsertChannelBodySchema = z.object({
  channelId: z.string().min(1).max(256),
  /** Omit to leave unchanged (defaults to `true` when the row is new). */
  allow: z.boolean().optional(),
  /**
   * Per-channel override on the workspace default sensitivity. Omit to
   * leave unchanged; `null` clears the override.
   */
  sensitivity: SensitivitySchema.nullable().optional(),
});

const AvailableChannelSchema = z.object({
  /** Bare platform channel id — the exact value the override row stores. */
  id: z.string(),
  /** Channel name without the leading `#`. */
  name: z.string(),
  isPrivate: z.boolean(),
  /**
   * Whether the bot is a member. An override on a non-member channel
   * can never fire (the listener only sees messages in channels the
   * bot has joined), so the picker warns on these.
   */
  isMember: z.boolean(),
});

const AvailableChannelsResponseSchema = z.object({
  /**
   * `false` when channel listing isn't possible for this workspace —
   * no chat-platform installation, or the platform call failed. The
   * admin UI degrades to manual channel-id entry; this is a soft state,
   * not an error (hence 200, not 4xx/5xx).
   *
   * Reasons are platform-neutral (#3463) and mirror
   * `ChannelDirectoryFailureReason` 1:1. `missing_scope` is the one
   * actionable value (#3466): the installed credential lacks the read
   * scope the listing needs, and only re-running the platform's OAuth
   * consent flow can widen it — UIs surface a reconnect CTA for it.
   */
  available: z.boolean(),
  reason: z.enum(["no_chat_installation", "missing_scope", "platform_error"]).nullable(),
  channels: z.array(AvailableChannelSchema),
});

// ---------------------------------------------------------------------------
// DB row → wire helpers
// ---------------------------------------------------------------------------

type WorkspaceConfigRow = {
  workspace_id: string;
  enabled: boolean;
  sensitivity: string;
  classifier_mode: string;
  announcement_channel_id: string | null;
  monthly_classifier_cap: number | null;
  announcement_posted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ChannelConfigRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  allow: boolean;
  sensitivity: string | null;
  created_at: Date;
  updated_at: Date;
};

function projectSensitivity(value: string | null): (typeof SENSITIVITY_VALUES)[number] | null {
  if (value === null) return null;
  // The CHECK constraint catches out-of-enum writes; this runtime narrowing
  // exists so a future schema drift surfaces as a logged fallback rather
  // than a type-cast lie.
  if ((SENSITIVITY_VALUES as readonly string[]).includes(value)) {
    return value as (typeof SENSITIVITY_VALUES)[number];
  }
  log.warn({ observed: value }, "Sensitivity outside enum — defaulting to balanced");
  return "balanced";
}

function projectClassifierMode(value: string): (typeof CLASSIFIER_MODE_VALUES)[number] {
  if ((CLASSIFIER_MODE_VALUES as readonly string[]).includes(value)) {
    return value as (typeof CLASSIFIER_MODE_VALUES)[number];
  }
  log.warn({ observed: value }, "Classifier mode outside enum — defaulting to regex-prefilter");
  return "regex-prefilter";
}

function workspaceRowToWire(row: WorkspaceConfigRow): z.infer<typeof WorkspaceConfigSchema> {
  return {
    workspaceId: row.workspace_id,
    enabled: row.enabled,
    sensitivity: projectSensitivity(row.sensitivity) ?? "balanced",
    classifierMode: projectClassifierMode(row.classifier_mode),
    announcementChannelId: row.announcement_channel_id,
    monthlyClassifierCap: row.monthly_classifier_cap,
    announcementPostedAt: row.announcement_posted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function channelRowToWire(row: ChannelConfigRow): z.infer<typeof ChannelOverrideSchema> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    allow: row.allow,
    sensitivity: projectSensitivity(row.sensitivity),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspace",
  tags: ["Admin — Proactive Chat"],
  summary: "Get workspace proactive config",
  description:
    "Returns the workspace's proactive-chat config. Materialises a default row (enabled=false) the first time it is read so the admin form has a stable shape.",
  responses: {
    200: {
      description: "Workspace proactive config",
      content: { "application/json": { schema: WorkspaceConfigSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateWorkspaceRoute = createRoute({
  method: "put",
  path: "/workspace",
  tags: ["Admin — Proactive Chat"],
  summary: "Update workspace proactive config",
  description:
    "Updates the workspace's proactive-chat config. Fields are independently optional — omitting one leaves the persisted value alone. Pass `null` for `announcementChannelId` / `monthlyClassifierCap` to explicitly clear.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkspaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated workspace proactive config",
      content: { "application/json": { schema: WorkspaceConfigSchema } },
    },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listChannelsRoute = createRoute({
  method: "get",
  path: "/channels",
  tags: ["Admin — Proactive Chat"],
  summary: "List channel overrides",
  description:
    "Returns every per-channel override row for the active workspace, sorted by channel id.",
  responses: {
    200: {
      description: "Channel override list",
      content: {
        "application/json": {
          schema: z.object({ channels: z.array(ChannelOverrideSchema) }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listAvailableChannelsRoute = createRoute({
  method: "get",
  path: "/channels/available",
  tags: ["Admin — Proactive Chat"],
  summary: "List channels available on the chat platform",
  description:
    "Lists the workspace's chat-platform channels (id + name + membership) so admin UIs can offer a picker instead of raw channel-id entry. Soft-degrades to `available: false` when the workspace has no chat-platform installation or the platform call fails — never a hard error. A `missing_scope` reason means the installed credential can't list channels and reconnecting the platform integration is required.",
  responses: {
    200: {
      description: "Channel listing (or a soft `available: false` envelope)",
      content: { "application/json": { schema: AvailableChannelsResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const upsertChannelRoute = createRoute({
  method: "post",
  path: "/channels",
  tags: ["Admin — Proactive Chat"],
  summary: "Upsert a channel override",
  description:
    "Creates or updates the override row for (workspaceId, channelId). Idempotent — POSTing twice with the same channelId updates the existing row rather than creating duplicates. Fields are independently optional: omit `allow` or `sensitivity` to leave the persisted value alone (new rows default to `allow: true`); pass `null` for `sensitivity` to explicitly clear the override.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpsertChannelBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Channel override upserted",
      content: { "application/json": { schema: ChannelOverrideSchema } },
    },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteChannelRoute = createRoute({
  method: "delete",
  path: "/channels/{channelId}",
  tags: ["Admin — Proactive Chat"],
  summary: "Delete a channel override",
  description: "Removes the override row for (workspaceId, channelId). Idempotent — 404 if the row was already gone.",
  request: {
    params: z.object({
      channelId: z.string().min(1).openapi({ param: { name: "channelId", in: "path" }, example: "C0123456789" }),
    }),
  },
  responses: {
    200: {
      description: "Channel override deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Override not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminProactive = createAdminRouter();
adminProactive.use(requireOrgContext());
// F-53 — proactive config lives in the settings cluster; reuse the same
// permission flag the rest of the workspace-settings surface uses. A finer
// `admin:proactive` flag can land later if the role surface needs to split.
adminProactive.use(requirePermission("admin:settings"));

/**
 * Sync enterprise gate. Sibling admin-proactive route files use
 * `runEffect` + `yield* ProactiveGate`; this file's `runHandler`-based
 * handlers can't yield the Tag (ConditionalEELayer is async via the
 * lazy EE-layer import), so the equivalent sync check is inlined.
 * Resulting `EnterpriseError` has the same `_tag` + payload as the Tag.
 */
function gateEnterprise(): void {
  if (!isEnterpriseEnabled()) {
    throw new EnterpriseError(
      "Enterprise features (proactive-chat) are not enabled. " +
        "Set ATLAS_ENTERPRISE_ENABLED=true or configure enterprise.enabled in atlas.config.ts.",
    );
  }
}

// GET /workspace — fetch (or lazily materialise) the workspace config row
adminProactive.openapi(getWorkspaceRoute, async (c) =>
  runHandler(c, "get proactive workspace config", async () => {
    const { orgId, requestId } = c.get("orgContext");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    try {
      // Materialise-or-return: ON CONFLICT touches `updated_at` to its own
      // value so RETURNING surfaces the existing row's columns (including
      // the original created_at / updated_at) — a DO NOTHING would leave
      // RETURNING empty on the conflict path and force a second SELECT.
      const rows = await internalQuery<WorkspaceConfigRow>(
        `INSERT INTO workspace_proactive_config (workspace_id)
         VALUES ($1)
         ON CONFLICT (workspace_id) DO UPDATE
           SET updated_at = workspace_proactive_config.updated_at
         RETURNING workspace_id, enabled, sensitivity, classifier_mode,
                   announcement_channel_id, monthly_classifier_cap,
                   announcement_posted_at, created_at, updated_at`,
        [orgId],
      );
      return c.json(workspaceRowToWire(rows[0]), 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId },
        "Failed to fetch proactive workspace config",
      );
      return c.json(
        { error: "internal_error", message: "Failed to fetch proactive config.", requestId },
        500,
      );
    }
  }),
);

// PUT /workspace — update workspace config
adminProactive.openapi(updateWorkspaceRoute, async (c) =>
  runHandler(c, "update proactive workspace config", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    const body = c.req.valid("json");

    try {
      // Two-step write: materialise-with-defaults then a partial UPDATE.
      // The alternative (single INSERT … ON CONFLICT DO UPDATE with
      // COALESCE) tangles field-order into parameter slots so a sixth
      // field becomes a refactor; this version keeps the partial-update
      // SET clause self-contained and the row-creation path uses the
      // migration's column defaults verbatim.
      await internalQuery(
        `INSERT INTO workspace_proactive_config (workspace_id)
         VALUES ($1)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [orgId],
      );

      // Snapshot `enabled` BEFORE the UPDATE so we can detect a
      // false→true transition for the one-shot activation announcement
      // (#2300). A pre-UPDATE SELECT is the simplest correct option —
      // doing it in the same connection would matter for serializable
      // isolation but we run read-committed and treat double-announce
      // as the DB-stamp's problem (idempotent in announceActivation).
      const priorRows = await internalQuery<{ enabled: boolean }>(
        `SELECT enabled FROM workspace_proactive_config WHERE workspace_id = $1`,
        [orgId],
      );
      const wasEnabled = priorRows[0]?.enabled ?? false;

      // Build the partial-update SET clause from the fields the caller
      // actually touched. `undefined` means "leave alone"; `null` is
      // valid only for the two nullable columns (Zod permits it at the
      // schema layer above) and is forwarded as-is.
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (body.enabled !== undefined) {
        sets.push(`enabled = $${idx++}`);
        params.push(body.enabled);
      }
      if (body.sensitivity !== undefined) {
        sets.push(`sensitivity = $${idx++}`);
        params.push(body.sensitivity);
      }
      if (body.classifierMode !== undefined) {
        sets.push(`classifier_mode = $${idx++}`);
        params.push(body.classifierMode);
      }
      if (body.announcementChannelId !== undefined) {
        sets.push(`announcement_channel_id = $${idx++}`);
        params.push(body.announcementChannelId);
      }
      if (body.monthlyClassifierCap !== undefined) {
        sets.push(`monthly_classifier_cap = $${idx++}`);
        params.push(body.monthlyClassifierCap);
      }
      // A no-touch PUT (empty body / every field undefined) still bumps
      // updated_at so the row reflects the last admin touch even when
      // nothing semantic changed. Mirrors the "save with no edits is
      // still a save" ergonomic of the rest of the admin surface.
      sets.push(`updated_at = NOW()`);
      params.push(orgId);

      const rows = await internalQuery<WorkspaceConfigRow>(
        `UPDATE workspace_proactive_config
            SET ${sets.join(", ")}
          WHERE workspace_id = $${idx}
         RETURNING workspace_id, enabled, sensitivity, classifier_mode,
                   announcement_channel_id, monthly_classifier_cap,
                   announcement_posted_at, created_at, updated_at`,
        params,
      );
      const updated = rows[0];

      log.info(
        { requestId, orgId, actorId: authResult.user?.id },
        "Proactive workspace config updated",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.workspaceUpdate,
        targetType: "proactive",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: {
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.sensitivity !== undefined && { sensitivity: body.sensitivity }),
          ...(body.classifierMode !== undefined && { classifierMode: body.classifierMode }),
          ...(body.announcementChannelId !== undefined && {
            announcementChannelId: body.announcementChannelId,
          }),
          ...(body.monthlyClassifierCap !== undefined && {
            monthlyClassifierCap: body.monthlyClassifierCap,
          }),
        },
      });

      // One-shot activation announcement (#2300). Triggers on a
      // false→true `enabled` transition when an announcement channel is
      // configured. Best-effort: failures are logged via the
      // coordinator and never fail the PUT — the row was already
      // updated and the admin should not see a 500 for a Slack hiccup.
      // The coordinator handles its own DB idempotency
      // (`announcement_posted_at` stamp), so a flap of disable +
      // re-enable does NOT re-announce.
      if (
        body.enabled === true &&
        !wasEnabled &&
        updated.announcement_channel_id !== null
      ) {
        // Capture the narrowed (non-null) channel id before the closure —
        // TS drops property-access narrowing across the Effect.gen boundary.
        const announcementChannelId = updated.announcement_channel_id;
        try {
          // Proactive logic lives in `@atlas/ee/proactive` and is reached
          // through the `ProactiveService` Tag. This `runHandler` route
          // can't `yield*` the Tag directly, so it bridges via
          // `runEnterprise` (the established non-Effect → EE-Tag path used
          // by admin-router / middleware / wizard). The EE impl resolves
          // the registered `ChatAnnouncer` internally (#3999).
          const outcome = await runEnterprise(
            Effect.gen(function* () {
              const proactiveSvc = yield* ProactiveService;
              return yield* proactiveSvc.announceActivation({
                workspaceId: orgId,
                channelId: announcementChannelId,
              });
            }),
          );
          if (outcome.posted) {
            log.info(
              { requestId, orgId, channelId: updated.announcement_channel_id },
              "Proactive activation announcement posted",
            );
          } else {
            log.info(
              { requestId, orgId, reason: outcome.reason },
              "Proactive activation announcement skipped",
            );
          }
        } catch (announceErr) {
          // Defence-in-depth: announceActivation already swallows
          // expected errors; this catch guards against a programmer
          // mistake in the coordinator surfacing through.
          log.warn(
            { requestId, orgId, err: errorMessage(announceErr) },
            "announceActivation threw unexpectedly — ignored",
          );
        }
      }

      return c.json(workspaceRowToWire(updated), 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId },
        "Failed to update proactive workspace config",
      );
      return c.json(
        { error: "internal_error", message: "Failed to update proactive config.", requestId },
        500,
      );
    }
  }),
);

// GET /channels — list channel overrides
adminProactive.openapi(listChannelsRoute, async (c) =>
  runHandler(c, "list proactive channel overrides", async () => {
    const { orgId, requestId } = c.get("orgContext");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    try {
      const rows = await internalQuery<ChannelConfigRow>(
        `SELECT id, workspace_id, channel_id, allow, sensitivity, created_at, updated_at
           FROM channel_proactive_config
          WHERE workspace_id = $1
          ORDER BY channel_id ASC`,
        [orgId],
      );
      return c.json({ channels: rows.map(channelRowToWire) }, 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId },
        "Failed to list proactive channel overrides",
      );
      return c.json(
        { error: "internal_error", message: "Failed to list channel overrides.", requestId },
        500,
      );
    }
  }),
);

// GET /channels/available — list the platform's channels for the picker
adminProactive.openapi(listAvailableChannelsRoute, async (c) =>
  runHandler(c, "list available chat channels", async () => {
    const { orgId, requestId } = c.get("orgContext");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    try {
      // Read-only platform lookup; no audit row (matches the other GETs).
      // The channel-directory port (#3463) resolves the workspace's chat
      // platform and short-TTL-caches successful listings (#3461), so
      // concurrent admin page loads cost one platform call per TTL. The
      // directory logic lives in `@atlas/ee/proactive`; this `runHandler`
      // route reaches it through the `ProactiveService` Tag via
      // `runEnterprise` (#3999).
      const result = await runEnterprise(
        Effect.gen(function* () {
          const proactiveSvc = yield* ProactiveService;
          return yield* proactiveSvc.listWorkspaceChannels(orgId);
        }),
      );
      if (!result.ok) {
        // Platform-side failure or no installation. Soft-degrade — the
        // picker falls back to manual entry. The raw platform error
        // stays in the log, never on the wire.
        log.warn(
          { requestId, orgId, reason: result.reason, detail: result.detail },
          "Channel listing unavailable — picker degraded to manual entry",
        );
        return c.json(
          { available: false, reason: result.reason, channels: [] },
          200,
        );
      }

      // Member channels first (those are the ones proactive can act in),
      // then alphabetical within each group.
      const channels = result.channels.toSorted(
        (a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name),
      );
      return c.json({ available: true, reason: null, channels }, 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId },
        "Failed to list available channels",
      );
      return c.json(
        { error: "internal_error", message: "Failed to list available channels.", requestId },
        500,
      );
    }
  }),
);

// POST /channels — upsert a channel override
adminProactive.openapi(upsertChannelRoute, async (c) =>
  runHandler(c, "upsert proactive channel override", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    const body = c.req.valid("json");

    try {
      // Partial upsert: `$5` / `$6` carry "was the field present in the
      // body" so an omitted field keeps the existing row's value on the
      // conflict path (and falls back to the column default semantics on
      // insert). `undefined` vs `null` matters for sensitivity — null is
      // an explicit clear, absence is leave-alone — so the flags can't be
      // derived from the value params.
      const allowProvided = body.allow !== undefined;
      const sensitivityProvided = body.sensitivity !== undefined;
      const rows = await internalQuery<ChannelConfigRow>(
        `INSERT INTO channel_proactive_config (workspace_id, channel_id, allow, sensitivity)
         VALUES ($1, $2, COALESCE($3, TRUE), $4)
         ON CONFLICT (workspace_id, channel_id) DO UPDATE
           SET allow = CASE WHEN $5 THEN COALESCE($3, TRUE)
                            ELSE channel_proactive_config.allow END,
               sensitivity = CASE WHEN $6 THEN $4
                                  ELSE channel_proactive_config.sensitivity END,
               updated_at = NOW()
         RETURNING id, workspace_id, channel_id, allow, sensitivity, created_at, updated_at`,
        [
          orgId,
          body.channelId,
          body.allow ?? null,
          body.sensitivity ?? null,
          allowProvided,
          sensitivityProvided,
        ],
      );

      log.info(
        { requestId, orgId, channelId: body.channelId, actorId: authResult.user?.id },
        "Proactive channel override upserted",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.channelUpsert,
        targetType: "proactive",
        targetId: body.channelId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: {
          channelId: body.channelId,
          // Mirror the workspace-update audit shape: only fields the
          // caller actually touched land in metadata, so a partial
          // sensitivity-only edit doesn't log a phantom `allow` change.
          ...(body.allow !== undefined && { allow: body.allow }),
          ...(body.sensitivity !== undefined && {
            sensitivity: body.sensitivity ?? null,
          }),
        },
      });
      return c.json(channelRowToWire(rows[0]), 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId, channelId: body.channelId },
        "Failed to upsert proactive channel override",
      );
      return c.json(
        { error: "internal_error", message: "Failed to save channel override.", requestId },
        500,
      );
    }
  }),
);

// DELETE /channels/:channelId — remove a channel override
adminProactive.openapi(deleteChannelRoute, async (c) =>
  runHandler(c, "delete proactive channel override", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    gateEnterprise();
    // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
    // where gateEnterprise() above is the gate. (#4064 / #3984)
    await requireFeatureEntitlementOrThrow(orgId, "proactive");

    const { channelId } = c.req.valid("param");

    try {
      const rows = await internalQuery<{ id: string }>(
        `DELETE FROM channel_proactive_config
          WHERE workspace_id = $1 AND channel_id = $2
          RETURNING id`,
        [orgId, channelId],
      );
      if (rows.length === 0) {
        return c.json(
          {
            error: "not_found",
            message: `Channel override for "${channelId}" not found.`,
            requestId,
          },
          404,
        );
      }

      log.info(
        { requestId, orgId, channelId, actorId: authResult.user?.id },
        "Proactive channel override deleted",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.channelDelete,
        targetType: "proactive",
        targetId: channelId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { channelId },
      });
      return c.json({ success: true }, 200);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId, channelId },
        "Failed to delete proactive channel override",
      );
      return c.json(
        { error: "internal_error", message: "Failed to delete channel override.", requestId },
        500,
      );
    }
  }),
);

export { adminProactive };
