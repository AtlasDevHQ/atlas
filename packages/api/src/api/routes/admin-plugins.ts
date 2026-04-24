/**
 * Admin plugin management routes.
 *
 * Mounted under /api/v1/admin/plugins via admin.route().
 * Platform-admin only: plugins are global resources. Workspace admins use the
 * marketplace (admin-marketplace.ts) for per-org plugin installations.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { plugins } from "@atlas/api/lib/plugins/registry";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import { savePluginEnabled, savePluginConfig, getPluginConfig } from "@atlas/api/lib/plugins/settings";
import {
  MASKED_PLACEHOLDER,
  encryptSecretFields,
  decryptSecretFields,
  type ConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("admin-plugins");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listPluginsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Plugins"],
  summary: "List plugins",
  description: "Returns all installed plugins with their status. Platform admin only.",
  responses: {
    200: {
      description: "Plugin list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const PluginHealthResponseSchema = z.object({
  healthy: z.boolean(),
  message: z.string().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
});

const pluginHealthRoute = createRoute({
  method: "post",
  path: "/{id}/health",
  tags: ["Admin — Plugins"],
  summary: "Plugin health check",
  description: "Triggers a health check for a specific plugin. Platform admin only.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Health check result",
      content: { "application/json": { schema: PluginHealthResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const PluginToggleResponseSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  status: z.string().nullable().optional(),
  persisted: z.boolean(),
  warning: z.string().optional(),
});

const enablePluginRoute = createRoute({
  method: "post",
  path: "/{id}/enable",
  tags: ["Admin — Plugins"],
  summary: "Enable plugin",
  description: "Enables a plugin. Persists to DB if available. Platform admin only.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin enabled",
      content: { "application/json": { schema: PluginToggleResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const disablePluginRoute = createRoute({
  method: "post",
  path: "/{id}/disable",
  tags: ["Admin — Plugins"],
  summary: "Disable plugin",
  description: "Disables a plugin. Persists to DB if available. Platform admin only.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin disabled",
      content: { "application/json": { schema: PluginToggleResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getPluginSchemaRoute = createRoute({
  method: "get",
  path: "/{id}/schema",
  tags: ["Admin — Plugins"],
  summary: "Plugin config schema",
  description: "Returns the configuration schema and current values for a plugin. Platform admin only.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin schema and values",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updatePluginConfigRoute = createRoute({
  method: "put",
  path: "/{id}/config",
  tags: ["Admin — Plugins"],
  summary: "Update plugin config",
  description: "Updates the configuration for a plugin. Validates against the schema if available. Platform admin only.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Config saved",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminPlugins = createPlatformRouter();

// GET / — list all plugins
adminPlugins.openapi(listPluginsRoute, async (c) => {
  const pluginList = plugins.describe();
  return c.json({ plugins: pluginList, manageable: hasInternalDB() }, 200);
});

// POST /:id/health — plugin health check
adminPlugins.openapi(pluginHealthRoute, async (c) => {
  const { id } = c.req.valid("param");
  const requestId = c.get("requestId") as string;

  const plugin = plugins.get(id);
  if (!plugin) {
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.`, requestId }, 404);
  }

  if (!plugin.healthCheck) {
    return c.json({
      healthy: true,
      message: "Plugin does not implement healthCheck.",
      status: plugins.getStatus(id) ?? null,
    }, 200);
  }

  try {
    const result = await plugin.healthCheck();
    return c.json({
      healthy: result.healthy,
      message: result.message ?? null,
      latencyMs: result.latencyMs ?? null,
      status: plugins.getStatus(id) ?? null,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Plugin health check threw an exception");
    return c.json({
      error: "internal_error",
      healthy: false,
      message: "Plugin health check failed unexpectedly.",
      status: plugins.getStatus(id) ?? null,
      requestId,
    }, 500);
  }
});

// POST /:id/enable — enable plugin
adminPlugins.openapi(enablePluginRoute, async (c) => {
  const { id } = c.req.valid("param");
  const requestId = c.get("requestId") as string;

  const plugin = plugins.get(id);
  if (!plugin) {
    // Not-found short-circuits — no state change, no audit event.
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.`, requestId }, 404);
  }

  plugins.enable(id);

  let persisted = false;
  let warning: string | undefined;
  let persistError: string | undefined;
  if (hasInternalDB()) {
    try {
      await savePluginEnabled(id, true);
      persisted = true;
    } catch (err) {
      persistError = err instanceof Error ? err.message : String(err);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Failed to persist plugin enabled state");
      warning = "Plugin enabled in memory but could not be persisted. State will reset on restart.";
    }
  } else {
    warning = "No internal database — state will reset on restart.";
  }

  logAdminAction({
    actionType: ADMIN_ACTIONS.plugin.enable,
    targetType: "plugin",
    targetId: id,
    scope: "platform",
    status: persistError === undefined ? "success" : "failure",
    metadata: {
      pluginId: id,
      pluginSlug: id,
      enabled: true,
      persisted,
      ...(persistError !== undefined && { error: persistError }),
    },
  });

  return c.json({ id, enabled: true, status: plugins.getStatus(id) ?? null, persisted, warning }, 200);
});

// POST /:id/disable — disable plugin
adminPlugins.openapi(disablePluginRoute, async (c) => {
  const { id } = c.req.valid("param");
  const requestId = c.get("requestId") as string;

  const plugin = plugins.get(id);
  if (!plugin) {
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.`, requestId }, 404);
  }

  plugins.disable(id);

  let persisted = false;
  let warning: string | undefined;
  let persistError: string | undefined;
  if (hasInternalDB()) {
    try {
      await savePluginEnabled(id, false);
      persisted = true;
    } catch (err) {
      persistError = err instanceof Error ? err.message : String(err);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Failed to persist plugin disabled state");
      warning = "Plugin disabled in memory but could not be persisted. State will reset on restart.";
    }
  } else {
    warning = "No internal database — state will reset on restart.";
  }

  logAdminAction({
    actionType: ADMIN_ACTIONS.plugin.disable,
    targetType: "plugin",
    targetId: id,
    scope: "platform",
    status: persistError === undefined ? "success" : "failure",
    metadata: {
      pluginId: id,
      pluginSlug: id,
      enabled: false,
      persisted,
      ...(persistError !== undefined && { error: persistError }),
    },
  });

  return c.json({ id, enabled: false, status: plugins.getStatus(id) ?? null, persisted, warning }, 200);
});

// GET /:id/schema — plugin config schema
adminPlugins.openapi(getPluginSchemaRoute, async (c) => {
  const { id } = c.req.valid("param");
  const requestId = c.get("requestId") as string;

  const plugin = plugins.get(id);
  if (!plugin) {
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.`, requestId }, 404);
  }

  const schema: ConfigSchemaField[] = typeof plugin.getConfigSchema === "function"
    ? plugin.getConfigSchema()
    : [];
  const configSchema: ConfigSchema = { state: "parsed", fields: schema };

  // Build current values from plugin config + DB overrides. DB overrides are
  // stored with `secret: true` fields encrypted at rest via F-42 — decrypt
  // before merging so the inline masker sees plaintext. Failures must not
  // silently yield null/plaintext: surface as 500 so the admin UI gets a
  // diagnosable error instead of an empty input field for a live secret.
  const pluginConfig = plugin.config != null && typeof plugin.config === "object"
    ? (plugin.config as Record<string, unknown>)
    : {};
  const dbOverridesRaw = await getPluginConfig(id);
  let dbOverrides: Record<string, unknown>;
  try {
    dbOverrides = decryptSecretFields(dbOverridesRaw, configSchema);
  } catch (err) {
    log.error(
      {
        pluginId: id,
        err: err instanceof Error ? err : new Error(String(err)),
        scrubbed: errorMessage(err),
        requestId,
      },
      "Failed to decrypt plugin config secrets on schema read",
    );
    return c.json({
      error: "internal_error",
      message: "Failed to read plugin configuration — encrypted secret could not be decrypted.",
      requestId,
    }, 500);
  }
  const merged = { ...pluginConfig, ...dbOverrides };

  // Mask secret values — write paths round-trip the exact MASKED_PLACEHOLDER
  // string on save, so drift here would corrupt live credentials.
  const maskedValues: Record<string, unknown> = {};
  const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
  for (const [key, value] of Object.entries(merged)) {
    if (secretKeys.has(key) && typeof value === "string" && value.length > 0) {
      maskedValues[key] = MASKED_PLACEHOLDER;
    } else {
      maskedValues[key] = value;
    }
  }

  return c.json({
    id,
    schema,
    values: maskedValues,
    hasSchema: schema.length > 0,
    manageable: hasInternalDB(),
  }, 200);
});

// PUT /:id/config — update plugin config
adminPlugins.openapi(updatePluginConfigRoute, async (c) => runHandler(c, "save plugin configuration", async () => {
  const { id } = c.req.valid("param");
  const requestId = c.get("requestId") as string;

  const plugin = plugins.get(id);
  if (!plugin) {
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.`, requestId }, 404);
  }

  if (!hasInternalDB()) {
    return c.json({
      error: "no_internal_db",
      message: "Internal database required to save plugin configuration. Config is read-only.",
    }, 409);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in plugin config request");
    return c.json({ error: "invalid_request", message: "Request body must be valid JSON." }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "invalid_request", message: "Request body must be a JSON object." }, 400);
  }

  // Validate against schema if plugin provides one. `originals` is captured
  // so we can (a) restore masked secret placeholders to their prior value
  // and (b) compute an accurate `keysChanged` that excludes re-submitted
  // placeholders — otherwise every admin save would report apiKey as
  // rotated even when they only toggled `debug`.
  let originals: Record<string, unknown> = {};
  let configSchemaForEncrypt: ConfigSchema = { state: "absent" };
  if (typeof plugin.getConfigSchema === "function") {
    const schema = plugin.getConfigSchema();
    configSchemaForEncrypt = { state: "parsed", fields: schema };
    const schemaKeys = new Set(schema.map((f) => f.key));
    const errors: string[] = [];

    const pluginConfig = plugin.config != null && typeof plugin.config === "object"
      ? (plugin.config as Record<string, unknown>)
      : {};
    // F-42: dbOverrides comes back with `secret: true` fields encrypted.
    // Decrypt before building `originals` so the placeholder-restore branch
    // below inlays plaintext (keysChanged can then compare against the
    // submitted body value without a fake "rotation" for every save).
    // Decrypt failure emits a failure audit row so compliance queries on
    // `admin_action_log` don't miss attempted PUTs that never reached the
    // UPDATE — mirroring the marketplace PUT path.
    const dbOverridesRaw = await getPluginConfig(id);
    let dbOverrides: Record<string, unknown>;
    try {
      dbOverrides = decryptSecretFields(dbOverridesRaw, configSchemaForEncrypt);
    } catch (err) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.configUpdate,
        targetType: "plugin",
        targetId: id,
        scope: "platform",
        status: "failure",
        metadata: {
          pluginId: id,
          pluginSlug: id,
          decryptFailure: true,
          error: errorMessage(err),
        },
      });
      log.error(
        {
          pluginId: id,
          err: err instanceof Error ? err : new Error(String(err)),
          scrubbed: errorMessage(err),
          requestId,
        },
        "Failed to decrypt plugin config secrets on save-read",
      );
      return c.json({
        error: "internal_error",
        message: "Failed to read current plugin configuration — encrypted secret could not be decrypted.",
        requestId,
      }, 500);
    }
    originals = { ...pluginConfig, ...dbOverrides };

    for (const field of schema) {
      const value = body[field.key];

      if (field.secret && value === MASKED_PLACEHOLDER) {
        if (originals[field.key] !== undefined) {
          body[field.key] = originals[field.key];
        }
        continue;
      }

      if (field.required && (value === undefined || value === null || value === "")) {
        errors.push(`"${field.key}" is required.`);
        continue;
      }

      if (value === undefined || value === null) continue;

      switch (field.type) {
        case "string":
          if (typeof value !== "string") errors.push(`"${field.key}" must be a string.`);
          break;
        case "number":
          if (typeof value !== "number") errors.push(`"${field.key}" must be a number.`);
          break;
        case "boolean":
          if (typeof value !== "boolean") errors.push(`"${field.key}" must be a boolean.`);
          break;
        case "select":
          if (field.options && !field.options.includes(String(value))) {
            errors.push(`"${field.key}" must be one of: ${field.options.join(", ")}.`);
          }
          break;
      }
    }

    if (errors.length > 0) {
      return c.json({
        error: "validation_error",
        message: "Config validation failed.",
        details: errors,
      }, 400);
    }

    // Strip keys not in the schema to prevent saving unvalidated data
    for (const key of Object.keys(body)) {
      if (!schemaKeys.has(key)) {
        delete body[key];
      }
    }
  }

  // Keys only — see ADMIN_ACTIONS.plugin JSDoc. Filter out keys whose final
  // value equals the originals (happens when the admin re-submits the
  // masked placeholder for a secret they didn't rotate). Snapshotted BEFORE
  // persist so a savePluginConfig throw still emits the intended change set.
  // The comparison happens on plaintext (originals was decrypted above and
  // body was placeholder-restored above), so equality-check lines up.
  const keysChanged = Object.keys(body)
    .filter((key) => body[key] !== originals[key])
    .toSorted();

  // F-42: encrypt `secret: true` fields before persisting. Non-secret fields
  // pass through as plain JSONB so DB ops stays grep-able.
  const toPersist = encryptSecretFields(body, configSchemaForEncrypt);

  try {
    await savePluginConfig(id, toPersist);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAdminAction({
      actionType: ADMIN_ACTIONS.plugin.configUpdate,
      targetType: "plugin",
      targetId: id,
      scope: "platform",
      status: "failure",
      metadata: { pluginId: id, pluginSlug: id, keysChanged, error: message },
    });
    throw err;
  }

  logAdminAction({
    actionType: ADMIN_ACTIONS.plugin.configUpdate,
    targetType: "plugin",
    targetId: id,
    scope: "platform",
    metadata: { pluginId: id, pluginSlug: id, keysChanged },
  });

  log.info({ pluginId: id, requestId }, "Plugin config updated");
  return c.json({
    id,
    message: "Configuration saved. Changes take effect on next restart.",
  }, 200);
}));

export { adminPlugins };
