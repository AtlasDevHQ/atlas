/**
 * Startup diagnostics.
 *
 * Validates environment configuration on first API request and returns
 * clear, actionable error messages. Never exposes secrets or stack traces.
 */

import * as fs from "fs";
import * as path from "path";
import { detectDBType, resolveDatasourceUrl } from "./db/connection";
import { getDefaultProvider } from "./providers";
import { detectAuthMode, getAuthModeSource } from "./auth/detect";
import { createLogger } from "./logger";

const log = createLogger("startup");

export type DiagnosticCode =
  | "MISSING_DATASOURCE_URL" | "DB_UNREACHABLE" | "MISSING_API_KEY"
  | "MISSING_SEMANTIC_LAYER" | "INVALID_SCHEMA" | "INTERNAL_DB_UNREACHABLE"
  | "WEAK_AUTH_SECRET" | "INVALID_JWKS_URL" | "MISSING_AUTH_ISSUER"
  | "MISSING_AUTH_PREREQ"
  | "ACTIONS_REQUIRE_AUTH" | "ACTIONS_MISSING_CREDENTIALS";

export interface DiagnosticError {
  code: DiagnosticCode;
  message: string;
}

const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  bedrock: "AWS_ACCESS_KEY_ID",
  ollama: "", // Ollama runs locally, no API key required
  gateway: "AI_GATEWAY_API_KEY",
};

let _cached: DiagnosticError[] | null = null;
let _cachedAt = 0;
const _startupWarnings: string[] = [];
const ERROR_CACHE_TTL_MS = 30_000;

/** Non-blocking warnings collected during validation. */
export function getStartupWarnings(): readonly string[] {
  return _startupWarnings;
}

/** Reset all cached state. For testing only. */
export function resetStartupCache(): void {
  _cached = null;
  _cachedAt = 0;
  _startupWarnings.length = 0;
}

/**
 * Validate the environment and return any configuration errors.
 * Results are cached permanently after a successful (no-error) check,
 * meaning subsequent environment degradation (e.g., database going down)
 * will not be detected by this function. The health endpoint's live probes
 * (SELECT 1) provide real-time reachability checks.
 * When errors exist, validation re-runs every 30s to detect fixes.
 */
export async function validateEnvironment(): Promise<DiagnosticError[]> {
  if (_cached !== null) {
    if (_cached.length === 0 || Date.now() - _cachedAt < ERROR_CACHE_TTL_MS) {
      return _cached;
    }
  }

  const errors: DiagnosticError[] = [];

  // 1. Analytics datasource — resolve from ATLAS_DATASOURCE_URL or Neon fallback
  const resolvedDatasourceUrl = resolveDatasourceUrl();
  if (!resolvedDatasourceUrl) {
    if (process.env.ATLAS_DEMO_DATA === "true") {
      const msg =
        "ATLAS_DEMO_DATA=true but neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. " +
        "The Neon integration may not have provisioned a database. " +
        "Check your Vercel project's storage integrations.";
      log.error(msg);
      errors.push({ code: "MISSING_DATASOURCE_URL", message: msg });
    } else if (process.env.DATABASE_URL) {
      const msg =
        "DATABASE_URL is set but ATLAS_DATASOURCE_URL is not. " +
        "As of v0.5, the analytics datasource uses ATLAS_DATASOURCE_URL. " +
        "DATABASE_URL is now reserved for Atlas's internal Postgres. " +
        "Rename your analytics connection to ATLAS_DATASOURCE_URL, " +
        "or set ATLAS_DEMO_DATA=true to use the same database for demo data.";
      log.error(msg);
      errors.push({ code: "MISSING_DATASOURCE_URL", message: msg });
    } else {
      const msg =
        "ATLAS_DATASOURCE_URL is not set. Atlas can start without an analytics datasource, but queries will not work. " +
        "Set it to a PostgreSQL connection string (postgresql://user:pass@host:5432/dbname) " +
        "or a MySQL connection string (mysql://user:pass@host:3306/dbname).";
      if (!_startupWarnings.includes(msg)) {
        _startupWarnings.push(msg);
      }
      log.warn(msg);
    }
  } else if (!process.env.ATLAS_DATASOURCE_URL && process.env.ATLAS_DEMO_DATA === "true") {
    const source = process.env.DATABASE_URL_UNPOOLED ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
    log.info("Demo mode: using %s as analytics datasource", source);
  }

  // 2. API key for configured provider
  const provider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  const requiredKey = PROVIDER_KEY_MAP[provider];

  if (requiredKey === undefined) {
    // Unknown provider — providers.ts will throw a descriptive error at model init,
    // so we don't duplicate that check here.
  } else if (requiredKey && !process.env[requiredKey]) {
    let message = `${requiredKey} is not set. Atlas needs an API key for the ${provider} provider.`;
    if (provider === "gateway") {
      message += " Create one at https://vercel.com/~/ai/api-keys";
    }
    errors.push({ code: "MISSING_API_KEY", message });
  }

  // 3. Semantic layer presence
  const semanticDir = path.resolve(process.cwd(), "semantic", "entities");
  let hasEntities = false;
  try {
    const files = fs.readdirSync(semanticDir);
    hasEntities = files.some((f) => f.endsWith(".yml"));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      // Non-ENOENT errors (permissions, not a directory, etc.) — report the real problem
      errors.push({
        code: "MISSING_SEMANTIC_LAYER",
        message: `Could not read semantic layer directory: ${err instanceof Error ? err.message : String(err)}. Check file permissions.`,
      });
      hasEntities = true; // prevent duplicate "no semantic layer" error below
    }
  }
  if (!hasEntities) {
    errors.push({
      code: "MISSING_SEMANTIC_LAYER",
      message:
        "No semantic layer found. Run 'bun run atlas -- init' to generate one from your database, or 'bun run atlas -- init --demo' to load demo data.",
    });
  }

  // 4. Datasource connectivity (only if a datasource URL is resolved)
  if (resolvedDatasourceUrl) {
    let dbType: ReturnType<typeof detectDBType> | null = null;
    try {
      dbType = detectDBType(resolvedDatasourceUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err: detail }, "Unsupported datasource URL");
      errors.push({ code: "DB_UNREACHABLE", message: detail });
    }

    if (dbType === "mysql") {
      // MySQL: URL validation + connection test
      if (!isValidUrl(resolvedDatasourceUrl)) {
        errors.push({
          code: "DB_UNREACHABLE",
          message: "ATLAS_DATASOURCE_URL appears malformed. Expected format: mysql://user:pass@host:3306/dbname",
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mysql = require("mysql2/promise");
        let pool;
        try {
          pool = mysql.createPool({
            uri: resolvedDatasourceUrl,
            connectionLimit: 1,
            connectTimeout: 5000,
          });
          const conn = await pool.getConnection();
          conn.release();
        } catch (err) {
          const detail = err instanceof Error ? err.message : "";
          log.error({ err: detail }, "MySQL connection check failed");

          let message = "Cannot connect to the database. Check that the server is running and the connection string is correct.";

          if (/ECONNREFUSED/i.test(detail)) {
            message += " The connection was refused — is the MySQL server running?";
          } else if (/Access denied/i.test(detail) || /ER_ACCESS_DENIED/i.test(detail)) {
            message += " Authentication failed — check your username and password.";
          } else if (/ER_BAD_DB_ERROR/i.test(detail)) {
            message += " The specified database does not exist.";
          } else if (/timeout/i.test(detail)) {
            message += " The connection timed out — check network/firewall settings.";
          }

          errors.push({ code: "DB_UNREACHABLE", message });
        } finally {
          if (pool) {
            await pool.end().catch((err: unknown) => {
              log.warn({ err: err instanceof Error ? err.message : String(err) }, "Pool cleanup warning");
            });
          }
        }
      }
    } else if (dbType === "postgres") {
      // PostgreSQL: existing URL validation + connection test + schema validation
      const atlasSchema = process.env.ATLAS_SCHEMA;
      const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

      // Validate ATLAS_SCHEMA format before attempting connection
      if (atlasSchema && !VALID_SQL_IDENTIFIER.test(atlasSchema)) {
        errors.push({
          code: "INVALID_SCHEMA",
          message: `Invalid ATLAS_SCHEMA "${atlasSchema}". Must be a valid SQL identifier (letters, digits, underscores).`,
        });
      }

      if (!isValidUrl(resolvedDatasourceUrl)) {
        errors.push({
          code: "DB_UNREACHABLE",
          message: "ATLAS_DATASOURCE_URL appears malformed. Expected format: postgresql://user:pass@host:5432/dbname",
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Pool } = require("pg");
        const pool = new Pool({
          connectionString: resolvedDatasourceUrl,
          max: 1,
          connectionTimeoutMillis: 5000,
        });
        try {
          const client = await pool.connect();

          // Verify schema exists if ATLAS_SCHEMA is set and valid
          if (atlasSchema && atlasSchema !== "public" && VALID_SQL_IDENTIFIER.test(atlasSchema)) {
            try {
              const result = await client.query(
                "SELECT 1 FROM pg_namespace WHERE nspname = $1",
                [atlasSchema]
              );
              if (result.rows.length === 0) {
                errors.push({
                  code: "INVALID_SCHEMA",
                  message: `Schema "${atlasSchema}" does not exist in the database. Check ATLAS_SCHEMA in your .env file.`,
                });
              }
            } catch (schemaErr) {
              log.error({ err: schemaErr instanceof Error ? schemaErr.message : String(schemaErr) }, "Schema existence check failed");
              errors.push({
                code: "INVALID_SCHEMA",
                message: `Could not verify schema "${atlasSchema}". Check ATLAS_SCHEMA and database permissions.`,
              });
            }
          }

          client.release();
        } catch (err) {
          const detail = err instanceof Error ? err.message : "";
          log.error({ err: detail }, "DB connection check failed");

          let message = "Cannot connect to the database. Check that the server is running and the connection string is correct.";

          if (/ECONNREFUSED/i.test(detail)) {
            message += " The connection was refused — is the database server running?";
          } else if (/timeout/i.test(detail)) {
            message += " The connection timed out — check network/firewall settings.";
          } else if (/authentication/i.test(detail) || /password/i.test(detail)) {
            message += " Authentication failed — check your username and password.";
          }

          errors.push({ code: "DB_UNREACHABLE", message });
        } finally {
          await pool.end().catch((err: unknown) => {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Pool cleanup warning");
          });
        }
      }
    }
    // Non-core database types are validated by their respective datasource plugins.
    if (dbType && dbType !== "postgres" && dbType !== "mysql") {
      log.info(
        { dbType },
        "Non-core datasource type '%s' — connectivity validation deferred to plugin initialize()",
        dbType,
      );
    }
  }

  // 5. Internal database (DATABASE_URL) — optional, for auth/audit/settings
  if (process.env.DATABASE_URL) {
    if (!isValidUrl(process.env.DATABASE_URL)) {
      errors.push({
        code: "INTERNAL_DB_UNREACHABLE",
        message: "DATABASE_URL appears malformed. Expected format: postgresql://user:pass@host:5432/atlas",
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg");
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      try {
        const client = await pool.connect();
        client.release();
      } catch (err) {
        const detail = err instanceof Error ? err.message : "";
        log.error({ err: detail }, "Internal DB connection check failed");

        let message = "Cannot connect to the internal database (DATABASE_URL). Check that the server is running and the connection string is correct.";
        if (/ECONNREFUSED/i.test(detail)) {
          message += " The connection was refused — is the database server running?";
        } else if (/timeout/i.test(detail)) {
          message += " The connection timed out — check network/firewall settings.";
        } else if (/authentication/i.test(detail) || /password/i.test(detail)) {
          message += " Authentication failed — check your username and password.";
        }

        errors.push({ code: "INTERNAL_DB_UNREACHABLE", message });
      } finally {
        await pool.end().catch((err: unknown) => {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "Internal DB pool cleanup warning");
        });
      }
    }
  } else {
    const msg = "DATABASE_URL not set — audit log will not persist to database.";
    if (!_startupWarnings.includes(msg)) {
      _startupWarnings.push(msg);
    }
    log.warn(msg);
  }

  // Check if boot-time migration reported errors
  const { getMigrationError } = await import("@atlas/api/lib/auth/migrate");
  const migrationErr = getMigrationError();
  if (migrationErr) {
    errors.push({ code: "INTERNAL_DB_UNREACHABLE", message: migrationErr });
  }

  // 6. Auth mode diagnostics
  const authMode = detectAuthMode();
  const authSource = getAuthModeSource();
  log.info({ authMode, source: authSource }, "Auth mode: %s (%s)", authMode, authSource);

  // When mode is explicit, verify prerequisite env vars are present
  if (authSource === "explicit") {
    if (authMode === "simple-key" && !process.env.ATLAS_API_KEY) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          "ATLAS_AUTH_MODE is set to 'api-key' but ATLAS_API_KEY is not set. " +
          "Set ATLAS_API_KEY to a shared secret, or remove ATLAS_AUTH_MODE to use auto-detection.",
      });
    }
    if (authMode === "managed" && !process.env.BETTER_AUTH_SECRET) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          "ATLAS_AUTH_MODE is set to 'managed' but BETTER_AUTH_SECRET is not set. " +
          "Set BETTER_AUTH_SECRET to a random string of at least 32 characters.",
      });
    }
    if (authMode === "byot" && !process.env.ATLAS_AUTH_JWKS_URL) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          "ATLAS_AUTH_MODE is set to 'byot' but ATLAS_AUTH_JWKS_URL is not set. " +
          "Set ATLAS_AUTH_JWKS_URL to your identity provider's JWKS endpoint.",
      });
    }
  }

  if (authMode === "managed") {
    if (!process.env.DATABASE_URL) {
      errors.push({
        code: "INTERNAL_DB_UNREACHABLE",
        message:
          "Managed auth mode requires DATABASE_URL for session storage. " +
          "Set DATABASE_URL to a PostgreSQL connection string (postgresql://user:pass@host:5432/atlas).",
      });
    }
    const secret = process.env.BETTER_AUTH_SECRET ?? "";
    if (secret.length < 32) {
      errors.push({
        code: "WEAK_AUTH_SECRET",
        message:
          "BETTER_AUTH_SECRET is shorter than 32 characters. Use a cryptographically random string of at least 32 characters.",
      });
    }
    if (!process.env.BETTER_AUTH_URL) {
      const msg =
        "BETTER_AUTH_URL is not set. Better Auth will auto-detect from the request, " +
        "but setting it explicitly is recommended for production.";
      if (!_startupWarnings.includes(msg)) {
        _startupWarnings.push(msg);
      }
      log.warn(msg);
    }
  }

  if (authMode === "byot") {
    const jwksUrl = process.env.ATLAS_AUTH_JWKS_URL ?? "";
    let jwksUrlValid = false;
    try {
      new URL(jwksUrl);
      jwksUrlValid = true;
    } catch (err) {
      errors.push({
        code: "INVALID_JWKS_URL",
        message:
          `ATLAS_AUTH_JWKS_URL is not a valid URL (${err instanceof Error ? err.message : "parse error"}). Expected format: https://your-idp.com/.well-known/jwks.json`,
      });
    }

    // Reachability check — non-blocking warning since the IdP might be temporarily down
    if (jwksUrlValid) {
      try {
        const resp = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) {
          const msg = `JWKS endpoint returned HTTP ${resp.status}. Verify the URL is correct.`;
          log.warn({ jwksUrl, status: resp.status }, msg);
          if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), jwksUrl }, "JWKS endpoint unreachable during startup check");
      }
    }

    if (!process.env.ATLAS_AUTH_ISSUER) {
      errors.push({
        code: "MISSING_AUTH_ISSUER",
        message:
          "ATLAS_AUTH_ISSUER is required for BYOT auth mode. Set it to your identity provider's issuer URL (e.g. https://your-idp.com/).",
      });
    }
  }

  // Warn about orphaned auth env vars that suggest misconfiguration
  if (authMode !== "byot" && process.env.ATLAS_AUTH_ISSUER) {
    const msg = authSource === "explicit"
      ? `ATLAS_AUTH_ISSUER is set but auth mode is '${authMode}' (explicit). ` +
        "Remove ATLAS_AUTH_ISSUER, or set ATLAS_AUTH_MODE=byot to use it."
      : "ATLAS_AUTH_ISSUER is set but ATLAS_AUTH_JWKS_URL is not — BYOT auth mode is not active. " +
        "Set ATLAS_AUTH_JWKS_URL to enable BYOT, or remove ATLAS_AUTH_ISSUER.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }

  if (authMode !== "managed" && (process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_TRUSTED_ORIGINS)) {
    const msg = authSource === "explicit"
      ? `BETTER_AUTH_URL or BETTER_AUTH_TRUSTED_ORIGINS is set but auth mode is '${authMode}' (explicit). ` +
        "Remove these env vars, or set ATLAS_AUTH_MODE=managed to use them."
      : "BETTER_AUTH_URL or BETTER_AUTH_TRUSTED_ORIGINS is set but BETTER_AUTH_SECRET is not — " +
        "managed auth mode is not active. Set BETTER_AUTH_SECRET to enable managed auth.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }

  // 7. Action framework diagnostics
  if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
    log.info("Action framework enabled");

    // Actions require authentication — reject "none" auth mode
    if (authMode === "none") {
      errors.push({
        code: "ACTIONS_REQUIRE_AUTH",
        message:
          "Actions require authentication. Set ATLAS_API_KEY, BETTER_AUTH_SECRET, or ATLAS_AUTH_JWKS_URL to enable an auth mode.",
      });
    }

    // Check required credentials for registered actions (warnings only —
    // missing optional action credentials should not block chat queries)
    try {
      const { buildRegistry } = await import("@atlas/api/lib/tools/registry");
      const actionRegistry = await buildRegistry({ includeActions: true });
      const missingCreds = actionRegistry.validateActionCredentials();
      for (const { action, missing } of missingCreds) {
        const msg = `Action "${action}" missing credentials: ${missing.join(", ")}`;
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
        log.warn(msg);
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Could not validate action credentials at startup",
      );
    }

    // Warn if no internal DB for persistent tracking
    if (!process.env.DATABASE_URL) {
      const msg =
        "Action framework requires DATABASE_URL for persistent tracking. " +
        "Actions will use in-memory storage only (lost on restart).";
      if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      log.warn(msg);
    }

    // Warn about high-risk actions set to auto-approve
    try {
      const { getConfig } = await import("@atlas/api/lib/config");
      const config = getConfig();
      const actionsConfig = config?.actions;
      if (actionsConfig) {
        const highRiskActions = ["email:send", "jira:create", "salesforce:update", "salesforce:create"];
        for (const actionType of highRiskActions) {
          const perAction = actionsConfig[actionType] as { approval?: string } | undefined;
          if (perAction?.approval === "auto") {
            const msg = `${actionType} configured for auto-approve — ensure you understand the risk`;
            if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
            log.warn(msg);
          }
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Could not validate action config at startup",
      );
    }
  }

  // 8. Slack integration — optional, informational only
  if (process.env.SLACK_SIGNING_SECRET) {
    const slackMode = process.env.SLACK_CLIENT_ID ? "oauth" : "single-workspace";
    log.info({ slackMode }, "Slack integration enabled");
  }

  // 9. Sandbox plugins — log any registered sandbox plugins before built-in pre-flight
  try {
    const { plugins: pluginRegistry } = await import("@atlas/api/lib/plugins/registry");
    try {
      const sandboxPlugins = pluginRegistry.getByType("sandbox");
      for (const sp of sandboxPlugins) {
        const security = (sp as { security?: Record<string, unknown> }).security;
        log.info(
          {
            pluginId: sp.id,
            version: sp.version,
            ...(security ? { security } : {}),
          },
          "Sandbox plugin registered: %s",
          sp.name ?? sp.id,
        );
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to enumerate sandbox plugins",
      );
    }
  } catch {
    // Plugin registry module not available — skip
  }

  // 10. Sandbox pre-flight (explore tool isolation)
  const isVercel = process.env.ATLAS_RUNTIME === "vercel" || !!process.env.VERCEL;
  if (isVercel) {
    log.info("Explore tool: Vercel sandbox active");
  } else if (process.env.ATLAS_SANDBOX === "nsjail") {
    // Explicit nsjail — probe and warn/error, no sidecar check
    try {
      const { findNsjailBinary, testNsjailCapabilities } = await import(
        "@atlas/api/lib/tools/explore-nsjail"
      );
      const { markNsjailFailed } = await import(
        "@atlas/api/lib/tools/explore"
      );
      const nsjailPath = findNsjailBinary();
      if (nsjailPath) {
        const semanticRoot = path.resolve(process.cwd(), "semantic");
        const capResult = await testNsjailCapabilities(nsjailPath, semanticRoot);
        if (capResult.ok) {
          log.info("Explore tool: nsjail sandbox active");
        } else {
          markNsjailFailed();
          const msg =
            `nsjail explicitly requested (ATLAS_SANDBOX=nsjail) but namespace creation failed: ${capResult.error}. ` +
            "This platform may not support Linux namespaces. " +
            "Set ATLAS_SANDBOX= (empty) to allow fallback to just-bash, or check platform documentation for namespace support.";
          log.error(msg);
          if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
        }
      } else {
        const msg =
          "ATLAS_SANDBOX=nsjail is set but nsjail binary was not found. " +
          "Install nsjail or set ATLAS_NSJAIL_PATH to the binary location.";
        log.error(msg);
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn({ err: detail }, "Sandbox pre-flight check skipped");
    }
  } else if (process.env.ATLAS_SANDBOX_URL) {
    // Sidecar is the intended backend — skip nsjail entirely (no noisy warnings)
    const sidecarUrl = process.env.ATLAS_SANDBOX_URL;
    const { markSidecarFailed } = await import(
      "@atlas/api/lib/tools/explore"
    );
    try {
      const healthUrl = new URL("/health", sidecarUrl).toString();
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        log.info({ url: sidecarUrl }, "Explore tool: sidecar sandbox active");
      } else {
        markSidecarFailed();
        const msg =
          `Sidecar health check returned HTTP ${resp.status} at ${sidecarUrl}. ` +
          "Check that the sandbox-sidecar service is running and healthy.";
        log.error(msg);
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      }
    } catch (err) {
      markSidecarFailed();
      const detail = err instanceof Error ? err.message : String(err);
      const msg =
        `Sidecar unreachable at ${sidecarUrl}: ${detail}. ` +
        "The sidecar may not be running yet — explore will retry on first use.";
      log.error(msg);
      if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    }
  } else {
    // Auto-detect nsjail, fall back to just-bash
    let nsjailActive = false;
    try {
      const { findNsjailBinary, testNsjailCapabilities } = await import(
        "@atlas/api/lib/tools/explore-nsjail"
      );
      const { markNsjailFailed } = await import(
        "@atlas/api/lib/tools/explore"
      );
      const nsjailPath = findNsjailBinary();
      if (nsjailPath) {
        const semanticRoot = path.resolve(process.cwd(), "semantic");
        const capResult = await testNsjailCapabilities(nsjailPath, semanticRoot);
        if (capResult.ok) {
          log.info("Explore tool: nsjail sandbox active");
          nsjailActive = true;
        } else {
          markNsjailFailed();
          const msg =
            `nsjail available but namespace creation failed: ${capResult.error} — ` +
            "falling back to just-bash (no process isolation).";
          log.warn(msg);
          if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn({ err: detail }, "Sandbox pre-flight check skipped");
    }

    if (!nsjailActive) {
      log.info(
        "Explore tool: just-bash (no process isolation). Install nsjail or configure ATLAS_SANDBOX_URL for sandboxed execution.",
      );
    }
  }

  _cached = errors;
  _cachedAt = Date.now();
  return errors;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
