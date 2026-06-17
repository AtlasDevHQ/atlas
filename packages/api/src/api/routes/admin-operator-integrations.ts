/**
 * Operator-tier integration credential routes (#3735, follow-up to #3704).
 *
 * Mounted at /api/v1/platform/operator-integrations. Platform-admin + MFA
 * (via `createPlatformRouter`). This is the Admin surface for Atlas's OWN
 * integration app registrations — the operator/platform tier — so a platform
 * admin can set + rotate (e.g.) the Slack OAuth app credentials from the
 * console WITHOUT a Railway redeploy. Credentials are stored encrypted at rest
 * (`operator_integration_credentials`, migration 0140) and picked up at
 * runtime via `PluginRegistry.refresh("chat-interaction")` — no process restart.
 *
 * Precedence (decided in `operator-credentials/resolver.ts`): DB row (set
 * here) → operator env var → unset. Self-host is unchanged: with no internal
 * DB every field falls through to env exactly as before.
 *
 * Security:
 *   - Secret values are NEVER echoed back. GET returns presence + source only
 *     (`getOperatorPlatformStatus`); the masked status carries no secret bytes.
 *   - PUT merges non-empty fields over the stored bundle (blank = preserve) so
 *     a partially-filled form can't blank a real secret.
 *   - The audit row records `hasSecret: true` + the env-var NAMES written
 *     (`fieldsSet`), never the raw value (same convention as
 *     `email_provider.*`). See `ADMIN_ACTIONS.operator_integration`.
 *
 * The managed platform set lives in `operator-credentials/platforms.ts`
 * (`OPERATOR_PLATFORMS`) — the reusable one-entry seam. This router has no
 * per-platform branches; it iterates the registry. Adding Discord/Teams/etc.
 * is a registry entry, not a route change. See the migration checklist in
 * `docs/development/saas-env-audit.md`.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { createLogger } from "@atlas/api/lib/logger";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { plugins } from "@atlas/api/lib/plugins/registry";
import {
  OPERATOR_PLATFORMS,
  getOperatorPlatform,
  type OperatorPlatformSpec,
} from "@atlas/api/lib/integrations/operator-credentials/platforms";
import { getOperatorPlatformStatus } from "@atlas/api/lib/integrations/operator-credentials/resolver";
import {
  readOperatorCredentials,
  readOperatorCredentialRecord,
  saveOperatorCredentials,
  deleteOperatorCredentials,
} from "@atlas/api/lib/integrations/operator-credentials/store";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("admin-operator-integrations");

/**
 * The chat plugin id whose adapters rebuild when operator chat credentials
 * change. Pinned at module scope so a rename surfaces here, not as a silent
 * no-op refresh. Mirrors `plugins/chat/src/index.ts` (`id: "chat-interaction"`).
 */
const CHAT_PLUGIN_ID = "chat-interaction";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FieldStatusSchema = z.object({
  envVar: z.string().openapi({ description: "Env-var name this field maps to (storage + adapter-builder key)." }),
  label: z.string(),
  hint: z.string(),
  secret: z.boolean().openapi({ description: "True ⇒ masked in the UI + never echoed back on read." }),
  required: z.boolean().openapi({ description: "True ⇒ part of the adapter builder's requiredEnv set." }),
  destructiveRotation: z.boolean().openapi({
    description: "True ⇒ rotating this field invalidates downstream data (e.g. stored bot tokens), forcing re-authorization. The UI warns before such a write.",
  }),
  present: z.boolean().openapi({ description: "True ⇒ resolved to a non-empty value from the DB or env." }),
  source: z.enum(["db", "env", "unset"]).openapi({ description: "Where the resolved value came from." }),
});

const PlatformStatusSchema = z.object({
  platform: z.string().openapi({ description: "Operator-tier platform slug." }),
  label: z.string(),
  configured: z.boolean().openapi({ description: "True ⇒ every required field resolved to a non-empty value." }),
  hasDbOverride: z.boolean().openapi({ description: "True ⇒ at least one field is set from the DB (Admin-set, not env)." }),
  updatedAt: z.string().nullable().openapi({ description: "ISO 8601 timestamp the DB row was last written, or null when no row exists." }),
  fields: z.array(FieldStatusSchema),
});

const PlatformSummarySchema = z.object({
  platform: z.string(),
  label: z.string(),
  configured: z.boolean(),
  hasDbOverride: z.boolean(),
});

const StatusResponseSchema = z.object({
  status: PlatformStatusSchema,
  /** True ⇒ the chat plugin rebuilt and picked up the change at runtime. */
  refreshed: z.boolean().optional(),
  /** Present only when the post-write plugin refresh failed — the credentials are saved, but the running adapter did not rebuild. */
  refreshError: z.string().optional(),
});

// PUT body: per-field new values keyed by env-var name. Every key must belong
// to the target platform; blank/whitespace-only values are PRESERVED (the
// stored secret is kept), so an admin rotating one field doesn't blank the rest.
const SetCredentialsBodySchema = z.object({
  fields: z.record(z.string(), z.string()).openapi({
    description:
      "Map of env-var name → new value for the platform's fields. Blank/omitted = preserve the stored value. Unknown keys are rejected.",
    example: { SLACK_SIGNING_SECRET: "8f14e45fceea167a5a36dedd4bea2543" },
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform — Operator Integrations"],
  summary: "List managed operator integration platforms",
  description:
    "Platform admin only. Returns the managed operator-tier integration platforms (Atlas's own app registrations) with a configured/override summary. Never returns secret values.",
  responses: {
    200: {
      description: "Managed platforms",
      content: { "application/json": { schema: z.object({ platforms: z.array(PlatformSummarySchema) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getStatusRoute = createRoute({
  method: "get",
  path: "/{platform}",
  tags: ["Platform — Operator Integrations"],
  summary: "Get masked operator credential status for a platform",
  description:
    "Platform admin only. Returns per-field presence + source (db/env/unset) and the last-rotated timestamp. Secret values are masked — only presence is reported, never the raw value.",
  responses: {
    200: { description: "Masked platform status", content: { "application/json": { schema: StatusResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Unmanaged platform slug", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const setRoute = createRoute({
  method: "put",
  path: "/{platform}",
  tags: ["Platform — Operator Integrations"],
  summary: "Set or rotate operator credentials for a platform",
  description:
    "Platform admin only. Merges non-empty fields over the stored encrypted bundle (blank = preserve), persists, then rebuilds the chat plugin at runtime (no redeploy). Secrets are never echoed back; the action is audit-logged without the raw value.",
  request: { body: { required: true, content: { "application/json": { schema: SetCredentialsBodySchema } } } },
  responses: {
    200: { description: "Credentials saved + masked status", content: { "application/json": { schema: StatusResponseSchema } } },
    400: { description: "Invalid body (unknown field key or all-blank)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Unmanaged platform slug or internal DB not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{platform}",
  tags: ["Platform — Operator Integrations"],
  summary: "Remove operator credentials for a platform (revert to env)",
  description:
    "Platform admin only. Deletes the stored DB bundle so the platform reverts to the env fallback, then rebuilds the chat plugin at runtime. Returns the post-delete masked status.",
  responses: {
    200: { description: "Credentials removed + masked status", content: { "application/json": { schema: StatusResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Unmanaged platform slug or internal DB not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PlatformStatusResponse = z.infer<typeof PlatformStatusSchema>;

/**
 * Build the masked status response for one platform: join the per-field
 * presence/source (`getOperatorPlatformStatus`) with the static field spec
 * (label/hint/destructive) and the DB row's last-rotated timestamp. Returns
 * `null` for an unmanaged slug so the caller maps it to a 404. NEVER includes
 * secret values — only presence + source.
 */
async function buildPlatformStatus(platform: string): Promise<PlatformStatusResponse | null> {
  const spec = getOperatorPlatform(platform);
  if (!spec) return null;

  // Both reads tolerate a missing internal DB (env-only status, null record).
  const [status, record] = await Promise.all([
    getOperatorPlatformStatus(platform),
    hasInternalDB() ? readOperatorCredentialRecord(platform) : Promise.resolve(null),
  ]);
  // `status` is non-null here: `spec` was found, so the slug is managed.
  if (!status) return null;

  const hintByEnvVar = new Map(spec.fields.map((f) => [f.envVar, f]));

  return {
    platform: status.platform,
    label: status.label,
    configured: status.configured,
    hasDbOverride: status.hasDbOverride,
    updatedAt: record?.updatedAt.toISOString() ?? null,
    fields: status.fields.map((f) => {
      const fieldSpec = hintByEnvVar.get(f.envVar);
      return {
        envVar: f.envVar,
        label: f.label,
        hint: fieldSpec?.hint ?? "",
        secret: f.secret,
        required: f.required,
        destructiveRotation: fieldSpec?.destructiveRotation ?? false,
        present: f.present,
        source: f.source,
      };
    }),
  };
}

/**
 * Rebuild the platform's runtime adapter so a credential write/delete is
 * picked up without a process restart. Today every managed platform is a chat
 * platform served by the `chat-interaction` plugin; a non-chat operator
 * platform (an action target, `catalogSlug === null`) has no chat plugin to
 * rebuild, so the refresh is skipped rather than firing a misleading no-op
 * against the chat plugin — its runtime pickup is handled by its own seam when
 * such a platform is added.
 *
 * A refresh failure is NOT fatal — the credentials are already persisted
 * encrypted at rest and will apply on the next boot/refresh; the route surfaces
 * the reason as a warning rather than discarding the saved write. Common
 * non-fatal reasons: the plugin isn't registered (self-host without chat) or it
 * hasn't initialized yet. The body is fully guarded (it never throws) so the
 * caller's `Effect.promise` can't turn a refresh hiccup into a 500 on an
 * already-persisted write.
 */
async function refreshPluginForPlatform(
  spec: OperatorPlatformSpec,
): Promise<{ refreshed: boolean; refreshError?: string }> {
  if (spec.catalogSlug === null) return { refreshed: false };
  try {
    const result = await plugins.refresh(CHAT_PLUGIN_ID);
    if (result.ok) return { refreshed: true };
    log.warn(
      { pluginId: CHAT_PLUGIN_ID, reason: result.reason },
      "Operator credential write saved, but chat plugin refresh failed — change applies on next boot/refresh",
    );
    return { refreshed: false, refreshError: result.reason };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      { pluginId: CHAT_PLUGIN_ID, reason },
      "Operator credential write saved, but chat plugin refresh threw — change applies on next boot/refresh",
    );
    return { refreshed: false, refreshError: reason };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminOperatorIntegrations = createPlatformRouter();

// ── List managed platforms ───────────────────────────────────────────
adminOperatorIntegrations.openapi(listRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const summaries = yield* Effect.promise(() =>
      Promise.all(
        OPERATOR_PLATFORMS.map(async (spec) => {
          const status = await getOperatorPlatformStatus(spec.platform);
          return {
            platform: spec.platform,
            label: spec.label,
            configured: status?.configured ?? false,
            hasDbOverride: status?.hasDbOverride ?? false,
          };
        }),
      ),
    );
    return c.json({ platforms: summaries }, 200);
  }), { label: "list operator integration platforms" });
});

// ── Get masked status ────────────────────────────────────────────────
adminOperatorIntegrations.openapi(getStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const platform = c.req.param("platform");

    const status = yield* Effect.promise(() => buildPlatformStatus(platform));
    if (!status) {
      return c.json({ error: "not_found", message: `Unmanaged operator platform: ${platform}`, requestId }, 404);
    }
    return c.json({ status }, 200);
  }), { label: "get operator integration status" });
});

// ── Set / rotate credentials ─────────────────────────────────────────
adminOperatorIntegrations.openapi(setRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const platform = c.req.param("platform");
    const body = c.req.valid("json");

    const spec = getOperatorPlatform(platform);
    if (!spec) {
      return c.json({ error: "not_found", message: `Unmanaged operator platform: ${platform}`, requestId }, 404);
    }

    // Writing requires the internal DB (encrypted-at-rest storage). Self-host
    // without an internal DB reads creds from env only — there's nothing to
    // write to. 404 keeps it consistent with the rest of the platform surface.
    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured — operator credentials can only be set when an internal DB is present.", requestId }, 404);
    }

    // Reject keys that don't belong to this platform's field set — a typo'd
    // env-var name would otherwise persist dead data into the bundle.
    const validEnvVars = new Set(spec.fields.map((f) => f.envVar));
    const unknownKeys = Object.keys(body.fields).filter((k) => !validEnvVars.has(k));
    if (unknownKeys.length > 0) {
      return c.json({ error: "validation_error", message: `Unknown field(s) for platform ${platform}: ${unknownKeys.join(", ")}`, requestId }, 400);
    }

    // Merge non-empty fields over the stored bundle: blank/whitespace-only =
    // preserve the stored value. Secret values are stored verbatim (no trim) so
    // a secret that legitimately contains edge whitespace is never silently
    // mangled; whitespace-only is treated as "not provided".
    const stored = (yield* Effect.promise(() => readOperatorCredentials(platform))) ?? {};
    const merged: Record<string, string> = { ...stored };
    const fieldsSet: string[] = [];
    for (const field of spec.fields) {
      const incoming = body.fields[field.envVar];
      if (typeof incoming === "string" && incoming.trim().length > 0) {
        merged[field.envVar] = incoming;
        fieldsSet.push(field.envVar);
      }
    }

    if (fieldsSet.length === 0) {
      return c.json({ error: "validation_error", message: "No non-empty fields provided — nothing to update.", requestId }, 400);
    }

    yield* Effect.tryPromise({
      try: () => saveOperatorCredentials(platform, merged),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.operator_integration.update,
            targetType: "operator_integration",
            targetId: platform,
            scope: "platform",
            status: "failure",
            // NEVER the raw value — `hasSecret` + `fieldsSet` (names only).
            metadata: { platform, fieldsSet, hasSecret: true, error: err.message },
            ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          }),
        ),
      ),
    );

    // Rebuild the running chat plugin so the rotation applies without a
    // restart. Non-fatal on failure (creds are persisted) — surfaced below.
    const refresh = yield* Effect.promise(() => refreshPluginForPlatform(spec));

    logAdminAction({
      actionType: ADMIN_ACTIONS.operator_integration.update,
      targetType: "operator_integration",
      targetId: platform,
      scope: "platform",
      metadata: { platform, fieldsSet, hasSecret: true, refreshed: refresh.refreshed },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const status = yield* Effect.promise(() => buildPlatformStatus(platform));
    // `status` is non-null: `spec` was found above, so the slug is managed.
    return c.json({ status: status!, ...refresh }, 200);
  }), { label: "set operator integration credentials" });
});

// ── Delete credentials (revert to env) ───────────────────────────────
adminOperatorIntegrations.openapi(deleteRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const platform = c.req.param("platform");

    const spec = getOperatorPlatform(platform);
    if (!spec) {
      return c.json({ error: "not_found", message: `Unmanaged operator platform: ${platform}`, requestId }, 404);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured — there are no stored operator credentials to remove.", requestId }, 404);
    }

    const removed = yield* Effect.tryPromise({
      try: () => deleteOperatorCredentials(platform),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.operator_integration.delete,
            targetType: "operator_integration",
            targetId: platform,
            scope: "platform",
            status: "failure",
            metadata: { platform, error: err.message },
            ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          }),
        ),
      ),
    );

    const refresh = yield* Effect.promise(() => refreshPluginForPlatform(spec));

    logAdminAction({
      actionType: ADMIN_ACTIONS.operator_integration.delete,
      targetType: "operator_integration",
      targetId: platform,
      scope: "platform",
      metadata: { platform, removed, refreshed: refresh.refreshed },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const status = yield* Effect.promise(() => buildPlatformStatus(platform));
    return c.json({ status: status!, ...refresh }, 200);
  }), { label: "delete operator integration credentials" });
});

export { adminOperatorIntegrations };
