/**
 * Health check route — public, no auth.
 *
 * Probes datasource and internal DB. Reports config-derived status of
 * LLM provider, semantic layer, explore backend, auth mode, scheduler,
 * and Slack. Returns both a flat `checks` object (legacy) and a
 * structured `components` object for the admin dashboard.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  validateEnvironment,
  getStartupWarnings,
  type DiagnosticError,
} from "@atlas/api/lib/startup";
import { getWhitelistedTables } from "@atlas/api/lib/semantic";
import { createLogger } from "@atlas/api/lib/logger";
import { getExploreBackendType, getActiveSandboxPluginId } from "@atlas/api/lib/tools/explore";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { getSetting } from "@atlas/api/lib/settings";

const log = createLogger("health");

// ---------------------------------------------------------------------------
// Zod schemas — exported for OpenAPI spec generation
// ---------------------------------------------------------------------------

const CheckStatusSchema = z.enum(["ok", "error", "not_configured"]);

const ComponentStatusSchema = z.enum(["healthy", "degraded", "down", "disabled"]);

const ComponentHealthSchema = z.object({
  status: ComponentStatusSchema,
  latencyMs: z.number().int().nonnegative().optional(),
  lastCheckedAt: z.string(),
  message: z.string().optional(),
  model: z.string().optional(),
  backend: z.string().optional(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  warnings: z.array(z.string()).optional(),
  brandColor: z.string().optional(),
  components: z.object({
    datasource: ComponentHealthSchema,
    internalDb: ComponentHealthSchema,
    provider: ComponentHealthSchema,
    scheduler: ComponentHealthSchema,
    sandbox: ComponentHealthSchema,
  }).optional(),
  checks: z.object({
    datasource: z.object({
      status: CheckStatusSchema,
      latencyMs: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
    provider: z.object({
      status: z.enum(["ok", "error"]),
      provider: z.string(),
      model: z.string(),
      error: z.string().optional(),
    }),
    semanticLayer: z.object({
      status: z.enum(["ok", "error"]),
      entityCount: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
    internalDb: z.object({
      status: CheckStatusSchema,
      latencyMs: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
    explore: z.object({
      backend: z.enum(["nsjail", "sidecar", "vercel-sandbox", "just-bash", "plugin"]),
      isolated: z.boolean(),
      isolationVerified: z.boolean().optional(),
      pluginId: z.string().optional(),
    }),
    auth: z.object({
      mode: z.enum(["none", "simple-key", "managed", "byot"]),
      enabled: z.boolean(),
      error: z.string().optional(),
    }),
    slack: z.object({
      enabled: z.boolean(),
      mode: z.enum(["disabled", "single-workspace", "oauth"]),
    }),
  }),
  sources: z.record(z.string(), z.object({
    status: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
    latencyMs: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
    checkedAt: z.string().optional(),
    dbType: z.string(),
  })).optional(),
});

function findDiagnostic(
  diagnostics: DiagnosticError[],
  ...codes: DiagnosticError["code"][]
): DiagnosticError | undefined {
  return diagnostics.find((d) => codes.includes(d.code));
}

const HealthErrorSchema = z.object({
  status: z.string(),
  error: z.string(),
});

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Health"],
  summary: "Health check",
  description:
    "Returns the health status of the Atlas API including checks for datasource connectivity, LLM provider, semantic layer, internal database, explore backend, auth mode, and Slack integration. " +
    "Returns HTTP 200 for 'ok' or 'degraded' status, and 503 for 'error' status.",
  responses: {
    200: {
      description:
        "Service is healthy or degraded (some optional components unavailable)",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    503: {
      description: "Service is unhealthy (critical component failure)",
      content: {
        "application/json": {
          schema: z.union([HealthResponseSchema, HealthErrorSchema]),
        },
      },
    },
  },
});

const health = new OpenAPIHono();

health.openapi(healthRoute, async (c) => {
  try {
    const diagnostics = await validateEnvironment();

    // Probe datasource with SELECT 1 — this is the authoritative real-time check.
    // Check both the env var and the ConnectionRegistry (a default datasource may
    // be configured via atlas.config.ts without ATLAS_DATASOURCE_URL).
    let dsLatencyMs: number | undefined;
    let dsProbeError: string | undefined;
    const { connections: connRegistry2, getDB, resolveDatasourceUrl } = await import("@atlas/api/lib/db/connection");
    const hasDatasource = !!resolveDatasourceUrl() || connRegistry2.list().includes("default");
    if (hasDatasource) {
      // Plugin-managed connections (e.g. Salesforce) may not support SQL probes.
      // Skip SELECT 1 for connections registered via registerDirect() with a custom validator.
      const hasCustomValidator = connRegistry2.getValidator("default");
      if (hasCustomValidator) {
        dsLatencyMs = 0;
      } else {
        try {
          const start = performance.now();
          await getDB().query("SELECT 1", 5000);
          dsLatencyMs = Math.round(performance.now() - start);
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Health check datasource probe failed",
          );
          dsProbeError = "Datasource query failed";
        }
      }
    }

    // Probe internal DB with SELECT 1
    let internalLatencyMs: number | undefined;
    let internalProbeError: string | undefined;
    if (process.env.DATABASE_URL) {
      try {
        const { getInternalDB } = await import("@atlas/api/lib/db/internal");
        const pool = getInternalDB();
        const start = performance.now();
        await pool.query("SELECT 1");
        internalLatencyMs = Math.round(performance.now() - start);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Health check internal DB probe failed",
        );
        internalProbeError = "Internal DB query failed";
      }
    }

    const { getDefaultProvider } = await import("@atlas/api/lib/providers");
    const provider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
    const entityCount = getWhitelistedTables().size;
    const exploreBackend = getExploreBackendType();
    const authMode = detectAuthMode();

    // Datasource is unhealthy if: no URL, diagnostics flagged it, OR the live probe failed
    const dsDiagnostic = findDiagnostic(
      diagnostics,
      "MISSING_DATASOURCE_URL",
      "DB_UNREACHABLE",
    );
    const hasDsError = !!dsDiagnostic || !!dsProbeError;
    const dsNotConfigured = !hasDatasource;
    const hasKeyError = !!findDiagnostic(diagnostics, "MISSING_API_KEY");
    const hasSemanticError = !!findDiagnostic(
      diagnostics,
      "MISSING_SEMANTIC_LAYER",
    );
    const hasInternalDbError =
      !!findDiagnostic(diagnostics, "INTERNAL_DB_UNREACHABLE") ||
      !!internalProbeError;
    const authDiagnostic = findDiagnostic(
      diagnostics,
      "WEAK_AUTH_SECRET",
      "INVALID_JWKS_URL",
      "MISSING_AUTH_ISSUER",
    );
    const hasAuthError = !!authDiagnostic;

    let status: "ok" | "degraded" | "error";
    if (hasDsError && !dsNotConfigured) status = "error";
    else if (
      dsNotConfigured ||
      hasKeyError ||
      hasSemanticError ||
      hasInternalDbError ||
      hasAuthError
    )
      status = "degraded";
    else status = "ok";

    const warnings = [...getStartupWarnings()];

    // Per-source health from ConnectionRegistry
    let sourcesSection: Record<string, { status: string; latencyMs?: number; message?: string; checkedAt?: string; dbType: string }> | undefined;
    try {
      const connMeta = connRegistry2.describe();
      if (connMeta.length > 0) {
        sourcesSection = {};
        for (const meta of connMeta) {
          const h = meta.health;
          // For the default source, prefer the live probe results from above
          // (the registry's cached health may be "unknown" if the connection was lazy-inited)
          const isDefault = meta.id === "default";
          const liveStatus = isDefault && hasDatasource
            ? (dsProbeError ? "unhealthy" : dsLatencyMs !== undefined ? "healthy" : undefined)
            : undefined;
          const liveLatency = isDefault ? dsLatencyMs : undefined;
          const liveMessage = isDefault ? dsProbeError : undefined;

          const effectiveStatus = liveStatus ?? h?.status ?? "unknown";
          const effectiveLatency = liveLatency ?? h?.latencyMs;
          const effectiveMessage = liveMessage ?? h?.message;

          // Scrub health messages that might contain connection credentials or internal state
          const safeMessage = effectiveMessage && !SENSITIVE_PATTERNS.test(effectiveMessage)
            ? effectiveMessage
            : effectiveMessage ? "Health check failed — check server logs for details." : undefined;
          sourcesSection[meta.id] = {
            status: effectiveStatus,
            ...(effectiveLatency !== undefined ? { latencyMs: effectiveLatency } : {}),
            ...(safeMessage ? { message: safeMessage } : {}),
            ...(h?.checkedAt ? { checkedAt: h.checkedAt.toISOString() } : {}),
            dbType: meta.dbType,
          };
        }

        // Promote overall status based on effective source health (includes live probe overrides)
        const sourceStatuses = Object.values(sourcesSection).map((s) => s.status);
        const hasUnhealthy = sourceStatuses.includes("unhealthy");
        const hasDegraded = sourceStatuses.includes("degraded");
        if (hasUnhealthy && status !== "error") status = "error";
        else if (hasDegraded && status === "ok") status = "degraded";
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to collect per-source health — sources section omitted",
      );
    }

    // Build components section for the health dashboard
    const now = new Date().toISOString();
    const schedulerEnabled = process.env.ATLAS_SCHEDULER_ENABLED === "true";

    const components = {
      datasource: {
        status: dsNotConfigured
          ? ("disabled" as const)
          : hasDsError
            ? ("down" as const)
            : ("healthy" as const),
        ...(dsLatencyMs !== undefined && { latencyMs: dsLatencyMs }),
        lastCheckedAt: now,
        ...(hasDsError && {
          message: dsProbeError ?? dsDiagnostic?.code ?? "DB_UNREACHABLE",
        }),
      },
      internalDb: {
        status: !process.env.DATABASE_URL
          ? ("disabled" as const)
          : hasInternalDbError
            ? ("down" as const)
            : ("healthy" as const),
        ...(internalLatencyMs !== undefined && { latencyMs: internalLatencyMs }),
        lastCheckedAt: now,
        ...(hasInternalDbError && {
          message: internalProbeError ?? "INTERNAL_DB_UNREACHABLE",
        }),
      },
      provider: {
        status: hasKeyError ? ("down" as const) : ("healthy" as const),
        model: process.env.ATLAS_MODEL ?? "(default)",
        lastCheckedAt: now,
        ...(hasKeyError && { message: "MISSING_API_KEY" }),
      },
      // Config-level status only — does not probe the scheduler engine at runtime
      scheduler: {
        status: schedulerEnabled ? "healthy" as const : "disabled" as const,
        lastCheckedAt: now,
      },
      // just-bash means no isolation — report degraded so operators know
      sandbox: {
        status: exploreBackend === "just-bash" ? "degraded" as const : "healthy" as const,
        backend: exploreBackend,
        lastCheckedAt: now,
        ...(exploreBackend === "just-bash" && { message: "No sandbox isolation — using just-bash fallback" }),
      },
    };

    // Brand color for frontend theming (public, no auth required)
    const brandColor = getSetting("ATLAS_BRAND_COLOR");

    const response = {
      status,
      ...(warnings.length > 0 && { warnings }),
      ...(brandColor && { brandColor }),
      components,
      checks: {
        datasource: dsNotConfigured
          ? { status: "not_configured" as const }
          : {
              status: (hasDsError ? "error" : "ok") as "error" | "ok",
              ...(dsLatencyMs !== undefined && { latencyMs: dsLatencyMs }),
              ...(hasDsError && {
                error: dsProbeError ?? dsDiagnostic?.code ?? "DB_UNREACHABLE",
              }),
            },
        provider: {
          status: (hasKeyError ? "error" : "ok") as "error" | "ok",
          provider,
          model: process.env.ATLAS_MODEL ?? "(default)",
          ...(hasKeyError && { error: "MISSING_API_KEY" }),
        },
        semanticLayer: {
          status: (hasSemanticError ? "error" : "ok") as "error" | "ok",
          entityCount,
          ...(hasSemanticError && { error: "MISSING_SEMANTIC_LAYER" }),
        },
        internalDb: !process.env.DATABASE_URL
          ? { status: "not_configured" as const }
          : {
              status: (hasInternalDbError ? "error" : "ok") as "error" | "ok",
              ...(internalLatencyMs !== undefined && {
                latencyMs: internalLatencyMs,
              }),
              ...(hasInternalDbError && {
                error: internalProbeError ?? "INTERNAL_DB_UNREACHABLE",
              }),
            },
        explore: {
          backend: exploreBackend,
          isolated: exploreBackend !== "just-bash",
          ...(exploreBackend === "plugin" && { isolationVerified: false }),
          ...(() => {
            const pluginId = exploreBackend === "plugin" ? getActiveSandboxPluginId() : null;
            return pluginId ? { pluginId } : {};
          })(),
        },
        auth: {
          mode: authMode,
          enabled: authMode !== "none",
          ...(authDiagnostic && { error: authDiagnostic.code }),
        },
        slack: {
          enabled: !!process.env.SLACK_SIGNING_SECRET,
          mode: !process.env.SLACK_SIGNING_SECRET
            ? ("disabled" as const)
            : process.env.SLACK_CLIENT_ID
              ? ("oauth" as const)
              : ("single-workspace" as const),
        },
      },
      ...(sourcesSection ? { sources: sourcesSection } : {}),
    };

    // Health response is built dynamically with many conditional fields — TypeScript
    // can't statically verify all literal string types against the Zod schema.
    if (response.status === "error") {
      return c.json(response as z.infer<typeof HealthResponseSchema>, 503);
    }
    return c.json(response as z.infer<typeof HealthResponseSchema>, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Health endpoint unexpected error",
    );
    return c.json({ status: "error" as const, error: "health_check_failed" }, 503);
  }
});

export { health };
