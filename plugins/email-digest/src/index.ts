/**
 * Email Digest Interaction Plugin for Atlas.
 *
 * Provides subscription management API routes for users to subscribe
 * to metric digests delivered via email on a daily or weekly schedule.
 *
 * Subscriptions are stored in the internal database. The plugin exports
 * `generateDigest`, `renderDigestEmail`, and `sendEmail` for use by an
 * external scheduler that dispatches digest emails at the configured
 * frequency.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { emailDigestPlugin } from "@useatlas/email-digest";
 *
 * export default defineConfig({
 *   plugins: [
 *     emailDigestPlugin({
 *       from: "Atlas <digest@myco.com>",
 *       transport: "sendgrid",
 *       apiKey: process.env.SENDGRID_API_KEY!,
 *       executeMetric: async (name) => {
 *         // Run the metric query and return results
 *         return { name, value: 42 };
 *       },
 *     }),
 *   ],
 * });
 * ```
 */

import { Hono } from "hono";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { EmailDigestConfigSchema } from "./config";
import type { EmailDigestPluginConfig, MetricResult } from "./config";

// Re-export types for consumers
export type { EmailDigestPluginConfig, MetricResult } from "./config";
export type { DigestSubscription, DigestPayload } from "./digest";
export type { DigestEmailContent } from "./templates";

// ---------------------------------------------------------------------------
// DB schema for plugin table (used by plugin migration system)
// ---------------------------------------------------------------------------

const DIGEST_SUBSCRIPTIONS_SCHEMA = {
  digest_subscriptions: {
    fields: {
      user_id: { type: "string" as const, required: true },
      email: { type: "string" as const, required: true },
      metrics: { type: "string" as const, required: true }, // JSON array stored as JSONB in PostgreSQL
      frequency: { type: "string" as const, required: true },
      delivery_hour: { type: "number" as const, required: true },
      timezone: { type: "string" as const, required: true },
      enabled: { type: "boolean" as const, required: true },
    },
  },
};

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------

/**
 * Parse a display-name format email (e.g. "Atlas <digest@co.com>")
 * into separate name and email fields for the SendGrid API.
 */
function parseFromAddress(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2] };
  return { email: from };
}

async function sendEmail(
  config: EmailDigestPluginConfig,
  to: string,
  subject: string,
  html: string,
  text: string,
  log: PluginLogger,
): Promise<boolean> {
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parseFromAddress(config.from),
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch((bodyErr) => {
        log.warn({ err: bodyErr instanceof Error ? bodyErr.message : String(bodyErr) }, "Could not read SendGrid error response body");
        return "";
      });
      log.error({ to, status: resp.status, body: body.slice(0, 200) }, "SendGrid delivery failed");
      return false;
    }
    return true;
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    log.error(
      { to, transport: config.transport, timeout: isTimeout, err: err instanceof Error ? err.message : String(err) },
      "Email delivery error",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

interface RouteDeps {
  db: AtlasPluginContext["db"];
  log: PluginLogger;
  config: EmailDigestPluginConfig;
}

/**
 * Require the x-atlas-user-id header on all routes.
 * Returns 401 if missing to prevent silent auth bypass.
 */
function requireUserId(c: { req: { header(name: string): string | undefined } }): string | null {
  return c.req.header("x-atlas-user-id") ?? null;
}

function createDigestRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const { db, log } = deps;

  // Middleware: require internal DB
  app.use("*", async (c, next) => {
    if (!db) {
      return c.json({ error: "Internal database not configured" }, 503);
    }
    await next();
  });

  app.get("/digest/subscriptions", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return c.json({ error: "Authentication required — x-atlas-user-id header missing" }, 401);

    try {
      const result = await db!.query(
        `SELECT id, user_id, email, metrics, frequency, delivery_hour, timezone, enabled, created_at, updated_at
         FROM digest_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      const subscriptions = result.rows.map((row) => parseSubscriptionRow(row, log));
      return c.json({ subscriptions });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to list subscriptions");
      return c.json({ error: "Failed to list subscriptions" }, 500);
    }
  });

  app.post("/digest/subscriptions", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return c.json({ error: "Authentication required — x-atlas-user-id header missing" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { metrics, frequency, deliveryHour, timezone, email } = body as {
      metrics?: string[];
      frequency?: string;
      deliveryHour?: number;
      timezone?: string;
      email?: string;
    };

    if (!Array.isArray(metrics) || metrics.length === 0) {
      return c.json({ error: "metrics must be a non-empty array of metric names" }, 400);
    }
    if (frequency !== "daily" && frequency !== "weekly") {
      return c.json({ error: "frequency must be 'daily' or 'weekly'" }, 400);
    }
    if (typeof deliveryHour !== "number" || deliveryHour < 0 || deliveryHour > 23) {
      return c.json({ error: "deliveryHour must be an integer 0-23" }, 400);
    }
    if (!email || typeof email !== "string") {
      return c.json({ error: "email is required" }, 400);
    }

    const tz = timezone ?? "UTC";
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await db!.execute(
        `INSERT INTO digest_subscriptions (id, user_id, email, metrics, frequency, delivery_hour, timezone, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, userId, email, JSON.stringify(metrics), frequency, deliveryHour, tz, true, now, now],
      );
      log.info({ subscriptionId: id, userId, frequency }, "Digest subscription created");
      return c.json({ id, metrics, frequency, deliveryHour, timezone: tz, email, enabled: true }, 201);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to create subscription");
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  });

  app.put("/digest/subscriptions/:id", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return c.json({ error: "Authentication required — x-atlas-user-id header missing" }, 401);
    const subId = c.req.param("id");

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      // Verify ownership
      const existing = await db!.query(
        `SELECT id FROM digest_subscriptions WHERE id = $1 AND user_id = $2`,
        [subId, userId],
      );
      if (existing.rows.length === 0) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (body.metrics !== undefined) {
        if (!Array.isArray(body.metrics) || body.metrics.length === 0) {
          return c.json({ error: "metrics must be a non-empty array" }, 400);
        }
        updates.push(`metrics = $${paramIdx++}`);
        params.push(JSON.stringify(body.metrics));
      }
      if (body.frequency !== undefined) {
        if (body.frequency !== "daily" && body.frequency !== "weekly") {
          return c.json({ error: "frequency must be 'daily' or 'weekly'" }, 400);
        }
        updates.push(`frequency = $${paramIdx++}`);
        params.push(body.frequency);
      }
      if (body.deliveryHour !== undefined) {
        if (typeof body.deliveryHour !== "number" || body.deliveryHour < 0 || body.deliveryHour > 23) {
          return c.json({ error: "deliveryHour must be an integer 0-23" }, 400);
        }
        updates.push(`delivery_hour = $${paramIdx++}`);
        params.push(body.deliveryHour);
      }
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== "string" || body.timezone.length === 0) {
          return c.json({ error: "timezone must be a non-empty string" }, 400);
        }
        updates.push(`timezone = $${paramIdx++}`);
        params.push(body.timezone);
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return c.json({ error: "enabled must be a boolean" }, 400);
        }
        updates.push(`enabled = $${paramIdx++}`);
        params.push(body.enabled);
      }
      if (body.email !== undefined) {
        if (typeof body.email !== "string" || body.email.length === 0) {
          return c.json({ error: "email must be a non-empty string" }, 400);
        }
        updates.push(`email = $${paramIdx++}`);
        params.push(body.email);
      }

      if (updates.length === 0) {
        return c.json({ error: "No fields to update" }, 400);
      }

      updates.push(`updated_at = $${paramIdx++}`);
      params.push(new Date().toISOString());
      params.push(subId);
      params.push(userId);

      await db!.execute(
        `UPDATE digest_subscriptions SET ${updates.join(", ")} WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}`,
        params,
      );
      log.info({ subscriptionId: subId }, "Digest subscription updated");
      return c.json({ updated: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to update subscription");
      return c.json({ error: "Failed to update subscription" }, 500);
    }
  });

  app.delete("/digest/subscriptions/:id", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return c.json({ error: "Authentication required — x-atlas-user-id header missing" }, 401);
    const subId = c.req.param("id");

    try {
      const existing = await db!.query(
        `SELECT id FROM digest_subscriptions WHERE id = $1 AND user_id = $2`,
        [subId, userId],
      );
      if (existing.rows.length === 0) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      await db!.execute(
        `DELETE FROM digest_subscriptions WHERE id = $1 AND user_id = $2`,
        [subId, userId],
      );
      log.info({ subscriptionId: subId }, "Digest subscription deleted");
      return c.json({ deleted: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to delete subscription");
      return c.json({ error: "Failed to delete subscription" }, 500);
    }
  });

  return app;
}

function parseSubscriptionRow(row: Record<string, unknown>, log?: PluginLogger) {
  let metrics: string[] = [];
  try {
    const raw = typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics;
    if (Array.isArray(raw)) metrics = raw;
  } catch (err) {
    log?.warn(
      { subscriptionId: row.id, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse metrics JSON — defaulting to empty array",
    );
  }
  return {
    id: row.id as string,
    userId: row.user_id as string,
    email: row.email as string,
    metrics,
    frequency: row.frequency as string,
    deliveryHour: row.delivery_hour as number,
    timezone: row.timezone as string,
    enabled: row.enabled as boolean,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildEmailDigestPlugin(
  config: EmailDigestPluginConfig,
): AtlasInteractionPlugin<EmailDigestPluginConfig> {
  let log: PluginLogger | null = null;
  let initialized = false;
  let pluginDb: AtlasPluginContext["db"] = null;
  let schemaReady = false;

  return {
    id: "email-digest-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Email Digest",
    config,

    schema: DIGEST_SUBSCRIPTIONS_SCHEMA,

    routes(app) {
      const deps: RouteDeps = {
        db: pluginDb,
        log: log ?? {
          info: (...args: unknown[]) => console.info("[email-digest]", ...args),
          warn: (...args: unknown[]) => console.warn("[email-digest]", ...args),
          error: (...args: unknown[]) => console.error("[email-digest]", ...args),
          debug: () => {},
        },
        config,
      };

      const digestRoutes = createDigestRoutes(deps);
      app.route("", digestRoutes);
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error("Email digest plugin already initialized — call teardown() first");
      }

      log = ctx.logger;
      pluginDb = ctx.db;

      // Safety-net table creation — the plugin migration system uses the
      // declarative `schema` above, but this ensures the table exists even
      // when the migration system is not active (e.g. standalone usage).
      if (ctx.db) {
        await ctx.db.execute(`
          CREATE TABLE IF NOT EXISTS digest_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            metrics JSONB NOT NULL DEFAULT '[]',
            frequency TEXT NOT NULL DEFAULT 'daily',
            delivery_hour INTEGER NOT NULL DEFAULT 9,
            timezone TEXT NOT NULL DEFAULT 'UTC',
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await ctx.db.execute(`
          CREATE INDEX IF NOT EXISTS idx_digest_subs_user ON digest_subscriptions(user_id)
        `);
        await ctx.db.execute(`
          CREATE INDEX IF NOT EXISTS idx_digest_subs_enabled ON digest_subscriptions(enabled, frequency)
        `);
        schemaReady = true;
      }

      ctx.logger.info(`Email digest plugin initialized (transport: ${config.transport})`);
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized) {
        return {
          healthy: false,
          message: "Email digest plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (!pluginDb) {
        return {
          healthy: false,
          message: "Internal database not available — subscriptions cannot be managed",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (!schemaReady) {
        return {
          healthy: false,
          message: "Database schema not ready — table creation may have failed",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      try {
        await pluginDb.query("SELECT 1 FROM digest_subscriptions LIMIT 0", []);
        return { healthy: true, latencyMs: Math.round(performance.now() - start) };
      } catch (err) {
        return {
          healthy: false,
          message: `Table probe failed: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },

    async teardown() {
      log = null;
      pluginDb = null;
      initialized = false;
      schemaReady = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * plugins: [emailDigestPlugin({ from: "Atlas <digest@co.com>", transport: "sendgrid", apiKey: "...", executeMetric })]
 * ```
 */
export const emailDigestPlugin = createPlugin<
  EmailDigestPluginConfig,
  AtlasInteractionPlugin<EmailDigestPluginConfig>
>({
  configSchema: EmailDigestConfigSchema,
  create: buildEmailDigestPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildEmailDigestPlugin };

// Export building blocks for external orchestration (scheduler, custom pipelines, tests)
export { generateDigest } from "./digest";
export { renderDigestEmail } from "./templates";
export { sendEmail, parseFromAddress };
