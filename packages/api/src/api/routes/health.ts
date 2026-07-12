/**
 * Health check route — public, no auth.
 *
 * Probes datasource and internal DB. Reports config-derived status of
 * LLM provider, semantic layer, explore backend, auth mode, scheduler,
 * and Slack. Returns both a flat `checks` object (legacy) and a
 * structured `components` object for the admin dashboard.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
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
import { getApiRegion, getMisroutedCount } from "@atlas/api/lib/residency/misrouting";
import { getConfig } from "@atlas/api/lib/config";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { getUserRole } from "@atlas/api/lib/auth/permissions";
import type { PluginStatus } from "@atlas/api/lib/plugins/registry";

// Canonical plugin lifecycle states for the /health wire format. The
// `satisfies readonly PluginStatus[]` clause is a compile-time witness
// that this array stays in lockstep with the registry's PluginStatus
// type — adding a state to one and forgetting the other fails to
// compile. Local rather than exported from registry.ts to avoid forcing
// every test that mocks `@atlas/api/lib/plugins/registry` to add the
// new export (Bun's mock.module is process-global and irreversible).
const PLUGIN_STATUSES = [
  "registered",
  "initializing",
  "healthy",
  "unhealthy",
  "teardown",
] as const satisfies readonly PluginStatus[];

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

// Per-item status enum derived from the canonical PLUGIN_STATUSES array in
// the registry. This keeps the wire format and the registry's PluginStatus
// type in lockstep — adding a state in one place automatically widens the
// other (the registry's `satisfies` clause is the static link).
const PluginItemHealthSchema = z.object({
  id: z.string().min(1),
  status: z.enum(PLUGIN_STATUSES),
  message: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});

// Plugin aggregate is never `down` — that path is reserved for the
// datasource (#1981 / SaaS-503 contract). Narrowing the inherited
// `ComponentHealthSchema` enum to `healthy | degraded | disabled` encodes
// that invariant in the wire format and prevents a future contributor
// from setting `pluginsComponent.status = "down"`.
const PluginsComponentSchema = ComponentHealthSchema.omit({
  status: true,
  model: true,
  backend: true,
}).extend({
  status: z.enum(["healthy", "degraded", "disabled"]),
  items: z.array(PluginItemHealthSchema).optional(),
});

type PluginsComponent = z.infer<typeof PluginsComponentSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  region: z.string().optional(),
  misroutedRequests: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()).optional(),
  // #3184 — present only when atlas.config.ts requested SaaS mode but
  // enterprise wasn't enabled, so the deploy mode silently downgraded to
  // self-hosted (all SaaS contracts skipped). Surfaces the downgrade beyond
  // the CRITICAL boot log; promotes overall status to at least `degraded`.
  deployModeDowngraded: z.object({ reason: z.string() }).optional(),
  brandColor: z.string().optional(),
  components: z.object({
    datasource: ComponentHealthSchema,
    internalDb: ComponentHealthSchema,
    provider: ComponentHealthSchema,
    scheduler: ComponentHealthSchema,
    sandbox: ComponentHealthSchema,
    plugins: PluginsComponentSchema,
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

// Roles that may see the full per-source fleet breakdown. Mirrors adminAuth's
// role gate in api/routes/middleware.ts (#3685).
const OPERATOR_ROLES = new Set<string>(["admin", "owner", "platform_admin"]);

/**
 * Whether the request carries an operator signal authorizing the full
 * per-source fleet breakdown on /health (#3685).
 *
 * Reuses the existing auth dispatcher — the SAME signal the admin health
 * dashboard sends (session cookie, managed mode) and self-hosted operators send
 * (`ATLAS_API_KEY` bearer, simple-key) — rather than inventing a new one:
 *   - mode "none" (local-dev / self-hosted no-auth) is an implicit operator,
 *     matching adminAuth's treatment.
 *   - an authenticated admin/owner/platform_admin (managed or simple-key) is an
 *     operator.
 * Anyone else (no credentials, expired session, non-admin member) is anonymous.
 *
 * `authenticateRequest` normalizes validator failures to an unauthenticated
 * result rather than throwing, but we still wrap defensively and fail CLOSED to
 * anonymous: a public health probe must never leak the fleet because the auth
 * layer errored.
 */
async function isOperatorHealthRequest(req: Request): Promise<boolean> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth.authenticated) return false;
    if (auth.mode === "none") return true;
    // Resolve the EFFECTIVE role, not the raw field: simple-key auth leaves
    // `user.role` undefined unless ATLAS_API_KEY_ROLE is set, and the documented
    // `admin` default is applied by getUserRole (AUTH_MODE_DEFAULT_ROLE), not
    // stamped on the user. Reading the raw field treated the common self-hosted
    // operator (bare ATLAS_API_KEY) as anonymous, stripping the fleet view (#3685).
    return OPERATOR_ROLES.has(getUserRole(auth.user));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Operator-signal check failed on /health — treating caller as anonymous",
    );
    return false;
  }
}

/**
 * The region's own datasource view of a per-source health map — the single
 * `default` entry, or `undefined` when this region has no `default` registered.
 * Strips the cross-region fleet from the anonymous /health response (#3685)
 * while leaving the operator view untouched.
 */
function ownRegionSources<T>(
  all: Record<string, T>,
): Record<string, T> | undefined {
  return "default" in all ? { default: all.default } : undefined;
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

const health = new OpenAPIHono({ defaultHook: validationHook });

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

    // SaaS treats the internal DB as critical infrastructure (auth, org,
    // billing, settings, audit, scheduler all live there). A pod that can't
    // reach it must fail the LB probe (#1981). Self-hosted leaves it optional.
    // Fall back to the env var so a probe hitting a SaaS pod before
    // `loadConfig()` resolves still fails closed instead of returning 200.
    const isSaas =
      getConfig()?.deployMode === "saas" ||
      process.env.ATLAS_DEPLOY_MODE === "saas";
    const internalDbBlocksProbe = hasInternalDbError && isSaas;

    let status: "ok" | "degraded" | "error";
    if ((hasDsError && !dsNotConfigured) || internalDbBlocksProbe) status = "error";
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

    // Per-source health from ConnectionRegistry. The bare `describe()`
    // enumerates only native/bare pools; published plugin datasources
    // (clickhouse / snowflake / bigquery / elasticsearch) register in a
    // separate per-workspace map, so we union them in via
    // `describeAllWorkspacePlugins()` — otherwise the operator fleet view (and
    // the `NN / NN live` count) silently omitted them (#3844). The breakdown is
    // operator-gated below (#3685); anonymous callers are stripped to the
    // region's own `default` (or nothing if none is registered).
    let sourcesSection: Record<string, { status: string; latencyMs?: number; message?: string; checkedAt?: string; dbType: string }> | undefined;
    try {
      // Plugin pools first, bare entries last: on a NON-`default` install_id
      // collision the bare entry's cached health wins the last write into
      // `sourcesSection[meta.id]`. (`default` is protected independently by the
      // live-probe precedence below — `liveStatus ?? h?.status` — not by this
      // order.) Plugin install_ids are clickhouse/snowflake/etc., so a collision
      // with a bare entry is rare in practice.
      const connMeta = [...connRegistry2.describeAllWorkspacePlugins(), ...connRegistry2.describe()];
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

        // Per-source health is ADVISORY for every source EXCEPT the region's own
        // primary datasource (`default`). `default` is the only platform-critical
        // source, and it already gates the 503 LB contract (#1981) via the live
        // SELECT 1 probe folded into the base `status` computation above. A
        // NON-default source — a tenant's connection-group datasource, a secondary
        // env group, a cross-region fleet member — being unhealthy or degraded is a
        // tenant-/fleet-scoped condition: it stays visible in the operator `sources`
        // breakdown below and in the per-workspace Admin → Connections view, but it
        // MUST NOT move the shared region's top-level status. Letting it would either
        // 503 the whole region (LB removal for every tenant) or trip every operator's
        // platform alert because one workspace fat-fingered a connection host.
        // Multi-tenant health isolation — no promotion off non-`default` sources.
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to collect per-source health — sources section omitted",
      );
    }

    // Build components section for the health dashboard
    const now = new Date().toISOString();
    // Scheduler status derives from the RESOLVED CONFIG — the same source the
    // engine fiber starts from (`makeSchedulerLive` → `config.scheduler.backend`)
    // — so `/health` reflects what actually runs. Reading `ATLAS_SCHEDULER_ENABLED`
    // here diverged from the engine on the file-config deploy, mislabeling a live
    // fiber as "disabled" in EU/APAC (#4623). `scheduler` is present in the
    // resolved config iff the scheduler is configured (backend bun/webhook/vercel).
    const schedulerEnabled = getConfig()?.scheduler != null;

    // #1987 — aggregate plugin healthcheck results into a `plugins` component.
    // Plugin failures NEVER escalate to 503 — that path is reserved for the
    // datasource (everywhere) and the internal DB (SaaS only, see #1981). A
    // misbehaving plugin should be observable in the dashboard, not page oncall.
    //
    // Default to "disabled" so any future code path that forgets to assign
    // still produces a coherent response.
    let pluginsComponent: PluginsComponent = { status: "disabled", lastCheckedAt: now };
    let pluginAggregateDegraded = false;
    try {
      const { plugins } = await import("@atlas/api/lib/plugins/registry");
      const registered = plugins.describe();
      if (registered.length > 0) {
        // #3201 — `/health` is public + unauthenticated, so a monitor poll
        // loop / request burst would otherwise fan out one live upstream
        // probe per credential-backed plugin on every request. The *Cached
        // variant serves a short-TTL liveness snapshot (configurable via
        // ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS) so repeated hits probe each
        // upstream at most once per window. An unhealthy plugin still
        // surfaces — failing results are cached verbatim, not masked.
        const probe = await plugins.healthCheckAllCached();
        const items = registered.map((p) => {
          const result = probe.get(p.id);
          // /health is public, no auth (file header) — every operator-facing
          // string from a third-party plugin must run through the same
          // SENSITIVE_PATTERNS scrub used by the source section above.
          // Plugins commonly throw with connection strings or API keys
          // baked into the message; we drop the original and substitute a
          // generic string so the credential never reaches an unauthenticated
          // caller.
          const rawMessage = result?.message;
          const safeMessage = rawMessage
            ? SENSITIVE_PATTERNS.test(rawMessage)
              ? "Health check failed — check server logs for details."
              : rawMessage
            : undefined;
          return {
            id: p.id,
            // result.status is typed as PluginStatus (registry contract).
            // Falling back to the descriptor's status covers the
            // plugin-without-healthCheck branch in healthCheckAll.
            status: result?.status ?? p.status,
            ...(safeMessage && { message: safeMessage }),
            ...(result?.latencyMs !== undefined && { latencyMs: result.latencyMs }),
          };
        });
        const anyUnhealthy = items.some((p) => p.status === "unhealthy");
        pluginAggregateDegraded = anyUnhealthy;
        pluginsComponent = {
          status: anyUnhealthy ? "degraded" : "healthy",
          lastCheckedAt: now,
          items,
        };
      }
    } catch (err) {
      // healthCheckAllCached() at the registry level throwing is
      // operator-significant — the per-plugin try/catch in
      // PluginRegistry.healthCheckAll already catches individual probe
      // failures, so reaching this branch implies module load failure,
      // registry corruption, or an iterator bug. A rejected probe is not
      // cached, so the next request re-probes rather than serving a stale
      // failure. log.error (not warn) so the structured-log scraper paged on
      // errors picks it up. /health still returns — the dashboard is most
      // needed when things are broken. The hardcoded message is safe (no
      // plugin-supplied content).
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Plugin healthCheckAllCached() failed at the registry level — surfacing plugins component as degraded",
      );
      pluginAggregateDegraded = true;
      pluginsComponent = {
        status: "degraded",
        lastCheckedAt: now,
        message: "Plugin health probe failed — see server logs",
      };
    }

    // Plugin aggregate degradation promotes top-level status from ok → degraded
    // but NEVER from degraded/error → error. The overall HTTP status code is
    // unchanged (still 200) — only the dashboard label shifts.
    if (pluginAggregateDegraded && status === "ok") status = "degraded";

    // #3184 — config-file SaaS→self-hosted downgrade. When atlas.config.ts
    // requested saas but enterprise wasn't enabled, applyDeployMode() stamps
    // a reason onto the resolved config. Surface it on /health and promote
    // ok → degraded so a headless box shows the silent downgrade beyond the
    // CRITICAL log. Never escalates to error (the box still serves traffic as
    // self-hosted), so the HTTP status stays 200.
    const deployModeDowngraded = getConfig()?.deployModeDowngraded;
    if (deployModeDowngraded && status === "ok") status = "degraded";

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
      // Config-level status only — does not probe the scheduler engine at runtime,
      // but derives from the SAME `config.scheduler` the engine starts from, so
      // `healthy` here means the fiber is running in this region. The scheduler
      // runs per-region against each region's own internal DB (#4623), so all
      // regions with a configured backend report `healthy`; `disabled` means no
      // scheduler backend is configured (e.g. self-hosted without one). The
      // customer-facing task-creation route is co-gated on the same config, so a
      // region that reports `disabled` also 404s task creation — no task is ever
      // written that would silently never fire.
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
      plugins: pluginsComponent,
    };

    // #3685 — gate the per-source fleet breakdown. `sourcesSection` above
    // enumerates EVERY registered datasource (in the US region that's the whole
    // multi-region fleet — us-prod, eu-prod, apac-prod, __demo__, default) with
    // per-DB latencies. That breakdown is reconnaissance surface for an
    // unauthenticated caller, so only operators receive it. Anonymous callers
    // get the aggregate `status` plus the region's own datasource (`default`) —
    // the shape EU/APAC already return. The aggregate `status` itself reflects
    // only platform-critical infra (the `default` datasource + SaaS internal DB),
    // not non-`default` sources (see the multi-tenant-isolation note above), so a
    // tenant's unhealthy connection never changes it for any caller.
    const isOperator = await isOperatorHealthRequest(c.req.raw);
    const visibleSources = sourcesSection
      ? isOperator
        ? sourcesSection
        : ownRegionSources(sourcesSection)
      : undefined;

    // Brand color for frontend theming (public, no auth required)
    const brandColor = getSetting("ATLAS_BRAND_COLOR");

    // Region identity for monitoring / misrouting detection
    const region = getApiRegion();
    const misroutedRequests = getMisroutedCount();

    const response = {
      status,
      ...(region && { region }),
      ...(misroutedRequests > 0 && { misroutedRequests }),
      ...(warnings.length > 0 && { warnings }),
      ...(deployModeDowngraded && { deployModeDowngraded }),
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
      ...(visibleSources ? { sources: visibleSources } : {}),
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
