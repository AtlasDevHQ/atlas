/**
 * Startup diagnostics.
 *
 * Validates environment configuration on first API request and returns
 * clear, actionable error messages. Never exposes secrets or stack traces.
 */

import * as fs from "fs";
import * as path from "path";
import { matchError } from "@useatlas/types";
import { detectDBType, resolveDatasourceUrl } from "./db/connection";
import { maskConnectionUrl } from "./security";
import { getDefaultProvider, getMissingProviderConfig, isSupportedProvider } from "./providers";
import { detectAuthMode, getAuthModeSource } from "./auth/detect";
import { resolvePasskeyRpId } from "./auth/rpid";
import { getWebOrigin } from "./web-origin";
import { createLogger } from "./logger";
import { errorMessage } from "./audit/error-scrub";
import { getSemanticRoot as getDefaultSemanticRoot } from "./semantic/files";

const log = createLogger("startup");

export type DiagnosticCode =
  | "MISSING_DATASOURCE_URL" | "DB_UNREACHABLE" | "MISSING_API_KEY"
  | "MISSING_SEMANTIC_LAYER" | "INVALID_SCHEMA" | "INTERNAL_DB_UNREACHABLE"
  | "WEAK_AUTH_SECRET" | "INVALID_JWKS_URL" | "MISSING_AUTH_ISSUER"
  | "MISSING_AUTH_PREREQ"
  | "ACTIONS_REQUIRE_AUTH" | "ACTIONS_MISSING_CREDENTIALS"
  | "INVALID_RP_ID"
  | "INVALID_CONFIG";

export interface DiagnosticError {
  code: DiagnosticCode;
  message: string;
}

// The provider required-config SSOT lives in ./providers (#3178/#3200) so the
// SaaS boot guard (`ProviderKeyGuardLive`) and this per-request diagnostic agree
// on what "configured" means without this module's heavy request-path graph.
// Imported above: `getMissingProviderConfig` (set-based) + `isSupportedProvider`.

const PROVIDER_SIGNUP_URL: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gateway: "https://vercel.com/~/ai/api-keys",
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

  // 1. Analytics datasource URL presence
  const resolvedDatasourceUrl = resolveDatasourceUrl();
  checkDatasourceUrlPresence(errors, resolvedDatasourceUrl);

  // 2. API key for configured provider
  checkProviderApiKey(errors);

  // 3. Semantic layer presence
  checkSemanticLayerPresence(errors);

  // 4. Datasource connectivity (only if a datasource URL is resolved)
  if (resolvedDatasourceUrl) {
    await checkDatasourceConnectivity(errors, resolvedDatasourceUrl);
  }

  // 5. Internal database (DATABASE_URL) — optional, for auth/audit/settings
  await checkInternalDbConnectivity(errors);

  // Check if boot-time migration reported errors
  const { getMigrationError } = await import("@atlas/api/lib/auth/migrate");
  const migrationErr = getMigrationError();
  if (migrationErr) {
    errors.push({ code: "INTERNAL_DB_UNREACHABLE", message: migrationErr });
  }

  // 5.5. Config file validation (atlas.config.ts)
  await checkConfigFile(errors);

  // 6. Auth mode diagnostics + 6.5. encryption key check
  const authMode = await checkAuthModeDiagnostics(errors);

  // 7. Action framework diagnostics
  if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
    await checkActionFramework(errors, authMode);
  }

  // 8. Slack integration — optional, informational only
  if (process.env.SLACK_SIGNING_SECRET) {
    const slackMode = process.env.SLACK_CLIENT_ID ? "oauth" : "single-workspace";
    log.info({ slackMode }, "Slack integration enabled");
  }

  // 9. Sandbox plugins + 10. Sandbox pre-flight
  await logSandboxPlugins();
  await checkSandboxPreFlight();

  _cached = errors;
  _cachedAt = Date.now();
  return errors;
}

// ── Startup validation helpers ──────────────────────────────────────────

function checkDatasourceUrlPresence(
  errors: DiagnosticError[],
  resolvedDatasourceUrl: string | undefined,
): void {
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
}

function checkProviderApiKey(errors: DiagnosticError[]): void {
  const provider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();

  // Unknown provider (typo / unsupported vendor): `resolveSelection()` throws at
  // model init on every chat/query, so without a diagnostic `/health` would stay
  // green while the agent is dead. Surface it (#3206 CodeRabbit) — the SaaS boot
  // guard already hard-fails this via `ProviderUnsupportedError`; self-hosted
  // keeps booting but the diagnostic flags the misconfig. `getMissingProviderConfig`
  // returns `[]` for an unknown provider, so the set check below cannot catch it.
  if (!isSupportedProvider(provider)) {
    errors.push({
      code: "INVALID_CONFIG",
      message:
        `ATLAS_PROVIDER="${provider}" is not a supported provider — model initialization will fail on ` +
        `every chat/query. Set ATLAS_PROVIDER to one of: anthropic, openai, bedrock, ollama, ` +
        `openai-compatible, gateway.`,
    });
    return;
  }

  // Required-config as a SET (#3200): Bedrock needs an access key AND a secret
  // (all-or-none with the AWS credential-provider chain); openai-compatible
  // needs its base URL. A single-key check passed these then 503'd at first chat.
  const missing = getMissingProviderConfig(provider);
  if (missing.length === 0) return;

  const isPlural = missing.length > 1;
  let message =
    `${missing.join(", ")} ${isPlural ? "are" : "is"} not set. ` +
    `Atlas needs ${isPlural ? "these" : "this"} for the "${provider}" provider. ` +
    `Set ${isPlural ? "them" : "it"} in your .env file.`;
  const signupUrl = PROVIDER_SIGNUP_URL[provider];
  if (signupUrl) {
    message += ` Get an API key at ${signupUrl}`;
  }
  errors.push({ code: "MISSING_API_KEY", message });
}

function checkSemanticLayerPresence(errors: DiagnosticError[]): void {
  const semanticDir = path.join(getDefaultSemanticRoot(), "entities");
  let hasEntities = false;
  try {
    const files = fs.readdirSync(semanticDir);
    hasEntities = files.some((f) => f.endsWith(".yml"));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      errors.push({
        code: "MISSING_SEMANTIC_LAYER",
        message: `Could not read semantic layer directory: ${errorMessage(err)}. Check file permissions.`,
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
}

async function checkDatasourceConnectivity(
  errors: DiagnosticError[],
  resolvedDatasourceUrl: string,
): Promise<void> {
  let dbType: ReturnType<typeof detectDBType> | null = null;
  try {
    dbType = detectDBType(resolvedDatasourceUrl);
  } catch (err) {
    const detail = errorMessage(err);
    log.error({ err: detail }, "Unsupported datasource URL");
    errors.push({ code: "DB_UNREACHABLE", message: detail });
  }

  if (dbType === "mysql") {
    await checkMysqlConnectivity(errors, resolvedDatasourceUrl);
  } else if (dbType === "postgres") {
    await checkPostgresConnectivity(errors, resolvedDatasourceUrl);
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

async function checkMysqlConnectivity(
  errors: DiagnosticError[],
  url: string,
): Promise<void> {
  if (!isValidUrl(url)) {
    errors.push({
      code: "DB_UNREACHABLE",
      message: "ATLAS_DATASOURCE_URL appears malformed. Expected format: mysql://user:pass@host:3306/dbname",
    });
    return;
  }

  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require("mysql2/promise");
  let pool;
  try {
    pool = mysql.createPool({
      uri: url,
      connectionLimit: 1,
      connectTimeout: 5000,
    });
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    log.error({ err: detail }, "MySQL connection check failed");

    const maskedUrl = maskConnectionUrl(url);
    const matched = matchError(err);
    let message: string;
    if (matched) {
      message = `Cannot connect to ${maskedUrl}. ${matched.message}`;
    } else if (/Access denied/i.test(detail) || /ER_ACCESS_DENIED/i.test(detail)) {
      message = `Cannot connect to ${maskedUrl}. Authentication failed — check your username and password.`;
    } else if (/ER_BAD_DB_ERROR/i.test(detail)) {
      let dbHint = "";
      try {
        const noDatabaseUrl = url.replace(/\/[^/?#]+(?=[?#]|$)/, "/");
        const listPool = mysql.createPool({
          uri: noDatabaseUrl,
          connectionLimit: 1,
          connectTimeout: 5000,
        });
        try {
          const listConn = await listPool.getConnection();
          const [dbRows] = await listConn.query(
            "SELECT schema_name FROM information_schema.schemata " +
            "WHERE schema_name NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema') " +
            "ORDER BY schema_name"
          );
          const schemas = (dbRows as Array<{ schema_name: string }>).map(r => r.schema_name);
          if (schemas.length > 0) {
            dbHint = ` Available databases: ${schemas.join(", ")}.`;
          }
          listConn.release();
        } finally {
          await listPool.end().catch(() => {});
        }
      } catch {
        // Database listing failed — fall back to generic message
      }
      message = `Cannot connect to ${maskedUrl}. The specified database does not exist.${dbHint}`;
    } else {
      message = `Cannot connect to ${maskedUrl}. Check the connection string and ensure the database is running.`;
    }

    errors.push({ code: "DB_UNREACHABLE", message });
  } finally {
    if (pool) {
      await pool.end().catch((err: unknown) => {
        log.warn({ err: errorMessage(err) }, "Pool cleanup warning");
      });
    }
  }
}

async function checkPostgresConnectivity(
  errors: DiagnosticError[],
  url: string,
): Promise<void> {
  const atlasSchema = process.env.ATLAS_SCHEMA;
  const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  // Validate ATLAS_SCHEMA format before attempting connection
  if (atlasSchema && !VALID_SQL_IDENTIFIER.test(atlasSchema)) {
    errors.push({
      code: "INVALID_SCHEMA",
      message: `Invalid ATLAS_SCHEMA "${atlasSchema}". Must be a valid SQL identifier (letters, digits, underscores).`,
    });
  }

  if (!isValidUrl(url)) {
    errors.push({
      code: "DB_UNREACHABLE",
      message: "ATLAS_DATASOURCE_URL appears malformed. Expected format: postgresql://user:pass@host:5432/dbname",
    });
    return;
  }

  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: url,
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
          let schemaHint = "";
          try {
            const schemasResult = await client.query(
              "SELECT schema_name FROM information_schema.schemata " +
              "WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') " +
              "AND schema_name NOT LIKE 'pg_temp_%' AND schema_name NOT LIKE 'pg_toast_temp_%' " +
              "ORDER BY schema_name"
            );
            const schemas = schemasResult.rows.map(
              (r: { schema_name: string }) => r.schema_name
            );
            if (schemas.length > 0) {
              schemaHint = ` Available schemas: ${schemas.join(", ")}.`;
            }
          } catch {
            // Schema listing failed — fall back to generic message
          }
          errors.push({
            code: "INVALID_SCHEMA",
            message: `Schema "${atlasSchema}" does not exist in the database.${schemaHint} Check ATLAS_SCHEMA in your .env file.`,
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

    const maskedUrl = maskConnectionUrl(url);
    const matched = matchError(err);
    let message: string;
    if (matched) {
      message = `Cannot connect to ${maskedUrl}. ${matched.message}`;
    } else if (/authentication/i.test(detail) || /password/i.test(detail)) {
      message = `Cannot connect to ${maskedUrl}. Authentication failed — check your username and password.`;
    } else {
      message = `Cannot connect to ${maskedUrl}. Check the connection string and ensure the database is running.`;
    }

    errors.push({ code: "DB_UNREACHABLE", message });
  } finally {
    await pool.end().catch((err: unknown) => {
      log.warn({ err: errorMessage(err) }, "Pool cleanup warning");
    });
  }
}

async function checkInternalDbConnectivity(errors: DiagnosticError[]): Promise<void> {
  if (process.env.DATABASE_URL) {
    if (!isValidUrl(process.env.DATABASE_URL)) {
      errors.push({
        code: "INTERNAL_DB_UNREACHABLE",
        message: "DATABASE_URL appears malformed. Expected format: postgresql://user:pass@host:5432/atlas",
      });
    } else {
      // oxlint-disable-next-line @typescript-eslint/no-require-imports
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

        const maskedUrl = maskConnectionUrl(process.env.DATABASE_URL!);
        const matched = matchError(err);
        let message: string;
        if (matched) {
          message = `Cannot connect to internal database at ${maskedUrl}. ${matched.message}`;
        } else if (/authentication/i.test(detail) || /password/i.test(detail)) {
          message = `Cannot connect to internal database at ${maskedUrl}. Authentication failed — check your username and password.`;
        } else {
          message = `Cannot connect to internal database at ${maskedUrl}. Check the connection string and ensure the database is running.`;
        }

        errors.push({ code: "INTERNAL_DB_UNREACHABLE", message });
      } finally {
        await pool.end().catch((err: unknown) => {
          log.warn({ err: errorMessage(err) }, "Internal DB pool cleanup warning");
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
}

async function checkConfigFile(errors: DiagnosticError[]): Promise<void> {
  try {
    const configMod = await import("@atlas/api/lib/config");
    if (typeof configMod.loadConfig === "function" && !configMod.getConfig()) {
      await configMod.loadConfig();
    }
    // #3184 follow-up: a config-file `deployMode: "saas"` that silently
    // downgraded to self-hosted (enterprise off) previously surfaced ONLY as a
    // CRITICAL log + a `/health` flag — not in the diagnostics warnings array
    // that the startup surface aggregates. Mirror the other startup warnings so
    // an operator paging on `getStartupWarnings()` sees the downgrade reason
    // alongside the rest. (The env-var path fails boot via EnterpriseGuardLive.)
    const downgrade = configMod.getConfig()?.deployModeDowngraded;
    if (downgrade) {
      const msg = `Deploy-mode downgrade: ${downgrade.reason}`;
      if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    }
  } catch (err) {
    const detail = errorMessage(err);
    log.error({ err: detail }, "Config validation failed");
    errors.push({ code: "INVALID_CONFIG", message: detail });
  }
}

async function checkAuthModeDiagnostics(errors: DiagnosticError[]): Promise<string> {
  const authMode = detectAuthMode();
  const authSource = getAuthModeSource();
  log.info({ authMode, source: authSource }, "Auth mode: %s (%s)", authMode, authSource);

  // When mode is pinned (explicit env var or config file), verify prerequisite env vars
  if (authSource === "explicit" || authSource === "config") {
    const source = authSource === "config" ? "atlas.config.ts" : "ATLAS_AUTH_MODE";
    if (authMode === "simple-key" && !process.env.ATLAS_API_KEY) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          `Auth mode is 'api-key' (from ${source}) but ATLAS_API_KEY is not set. ` +
          "Set ATLAS_API_KEY to a shared secret, or change auth to 'auto'.",
      });
    }
    if (authMode === "managed" && !process.env.BETTER_AUTH_SECRET) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          `Auth mode is 'managed' (from ${source}) but BETTER_AUTH_SECRET is not set. ` +
          "Set BETTER_AUTH_SECRET to a random string of at least 32 characters.",
      });
    }
    if (authMode === "byot" && !process.env.ATLAS_AUTH_JWKS_URL) {
      errors.push({
        code: "MISSING_AUTH_PREREQ",
        message:
          `Auth mode is 'byot' (from ${source}) but ATLAS_AUTH_JWKS_URL is not set. ` +
          "Set ATLAS_AUTH_JWKS_URL to your identity provider's JWKS endpoint.",
      });
    }
  }

  if (authMode === "managed") {
    checkManagedAuthMode(errors);
  }

  if (authMode === "byot") {
    await checkByotAuthMode(errors);
  }

  // Warn about orphaned auth env vars that suggest misconfiguration
  warnOrphanedAuthVars(authMode, authSource);

  // 6.5. Connection encryption key check — only relevant when internal DB stores connection URLs
  if (
    process.env.DATABASE_URL &&
    !process.env.ATLAS_ENCRYPTION_KEY &&
    !process.env.ATLAS_ENCRYPTION_KEYS &&
    !process.env.BETTER_AUTH_SECRET
  ) {
    const msg =
      "No encryption key available for connection URLs. Set ATLAS_ENCRYPTION_KEYS (preferred) or ATLAS_ENCRYPTION_KEY " +
      "to encrypt connection credentials at rest.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }

  // 6.6. F-47 SaaS deprecation: BETTER_AUTH_SECRET doubling as the
  // at-rest encryption key entangles session-signing with data-at-rest
  // encryption. Rotating the session key (a routine Better Auth step)
  // would silently destroy every encrypted credential. Nudge SaaS
  // operators toward a dedicated key; leave self-hosted quiet because
  // the fallback is a valid dev-friendly default.
  const isSaas = process.env.ATLAS_DEPLOY_MODE === "saas";
  if (
    isSaas &&
    !process.env.ATLAS_ENCRYPTION_KEYS &&
    !process.env.ATLAS_ENCRYPTION_KEY &&
    process.env.BETTER_AUTH_SECRET
  ) {
    const msg =
      "ATLAS_DEPLOY_MODE=saas but no ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY is set — " +
      "falling back to BETTER_AUTH_SECRET for at-rest encryption. This entangles session signing " +
      "with data encryption and blocks key rotation. Set ATLAS_ENCRYPTION_KEYS to a dedicated value. " +
      "See docs/platform-ops/encryption-key-rotation.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }

  return authMode;
}

function checkManagedAuthMode(errors: DiagnosticError[]): void {
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
        `BETTER_AUTH_SECRET must be at least 32 characters (currently ${secret.length}). ` +
        "Generate one with: openssl rand -base64 32",
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

  // WebAuthn rpID validity (#3045). The passkey plugin's rpID throw lives in
  // `buildPlugins()`, which only runs lazily (first managed-auth request / boot
  // migration, where the migration path catches the throw into a generic log).
  // Resolve it here too so an rpID that can't be valid for the configured web
  // origin surfaces as an eager, actionable startup diagnostic (on /health and
  // route 503s) instead of an opaque browser-side error later. resolvePasskeyRpId
  // is the single source of truth — it throws only on an explicit-but-invalid
  // ATLAS_RPID; the derived path and a null origin never throw.
  try {
    resolvePasskeyRpId(process.env, getWebOrigin());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface in the server log too, not just the diagnostics response —
    // resolvePasskeyRpId throws (it doesn't log) and the lazy buildPlugins
    // path buries the same throw under a generic "migration failed" line, so
    // without this the misconfig is invisible in logs.
    log.warn({ err: message }, "Invalid WebAuthn rpID for the configured web origin");
    errors.push({ code: "INVALID_RP_ID", message });
  }
}

async function checkByotAuthMode(errors: DiagnosticError[]): Promise<void> {
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
      log.warn({ err: errorMessage(err), jwksUrl }, "JWKS endpoint unreachable during startup check");
    }
  }

  if (!process.env.ATLAS_AUTH_ISSUER) {
    errors.push({
      code: "MISSING_AUTH_ISSUER",
      message:
        "ATLAS_AUTH_ISSUER is required for BYOT auth mode. Set it to your identity provider's issuer URL (e.g. https://your-idp.com/).",
    });
  }

  if (process.env.ATLAS_AUTH_AUDIENCE === "") {
    const msg =
      "ATLAS_AUTH_AUDIENCE is set to an empty string — audience validation will be skipped. " +
      "Remove the variable entirely if audience checking is not needed, or set it to a valid audience value.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }
}

function warnOrphanedAuthVars(authMode: string, authSource: string | null): void {
  if (authMode !== "byot" && process.env.ATLAS_AUTH_ISSUER) {
    const pinned = authSource === "explicit" || authSource === "config";
    const msg = pinned
      ? `ATLAS_AUTH_ISSUER is set but auth mode is '${authMode}' (${authSource}). ` +
        "Remove ATLAS_AUTH_ISSUER, or change auth to 'byot' to use it."
      : "ATLAS_AUTH_ISSUER is set but ATLAS_AUTH_JWKS_URL is not — BYOT auth mode is not active. " +
        "Set ATLAS_AUTH_JWKS_URL to enable BYOT, or remove ATLAS_AUTH_ISSUER.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }

  if (authMode !== "managed" && (process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_TRUSTED_ORIGINS)) {
    const pinned = authSource === "explicit" || authSource === "config";
    const msg = pinned
      ? `BETTER_AUTH_URL or BETTER_AUTH_TRUSTED_ORIGINS is set but auth mode is '${authMode}' (${authSource}). ` +
        "Remove these env vars, or change auth to 'managed' to use them."
      : "BETTER_AUTH_URL or BETTER_AUTH_TRUSTED_ORIGINS is set but BETTER_AUTH_SECRET is not — " +
        "managed auth mode is not active. Set BETTER_AUTH_SECRET to enable managed auth.";
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    log.warn(msg);
  }
}

async function checkActionFramework(errors: DiagnosticError[], authMode: string): Promise<void> {
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
  // missing optional action credentials should not block chat queries).
  //
  // SaaS skips this check: per the #3766 config model, action targets
  // (Jira, Linear, GitHub, Salesforce, …) are per-workspace-only on SaaS —
  // there is no platform/global default env credential.
  // `validateActionCredentials()` checks each *registered* action's required
  // keys against the global env, so on SaaS it would report those globals
  // (e.g. a registered Jira action's JIRA_*) missing and surface them as
  // spurious /api/health warnings for a credential model SaaS isn't supposed
  // to use (#3905). Read the *resolved* deploy mode (not raw env): a `saas`
  // request that downgraded to self-hosted because enterprise wasn't enabled
  // resolves to `self-hosted` here and is still validated. Core/platform
  // globals (AI gateway, sandbox) are unaffected — they aren't action
  // credentials. Self-host behavior is unchanged. Out of scope: per-workspace
  // resolution and dropping global-env registration on SaaS (#3766).
  try {
    const { getConfig } = await import("@atlas/api/lib/config");
    if (getConfig()?.deployMode !== "saas") {
      const { buildRegistry } = await import("@atlas/api/lib/tools/registry");
      const { registry: actionRegistry } = await buildRegistry({ includeActions: true });
      const missingCreds = actionRegistry.validateActionCredentials();
      for (const { action, missing } of missingCreds) {
        const msg = `Action "${action}" missing credentials: ${missing.join(", ")}`;
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
        log.warn(msg);
      }
    }
  } catch (err) {
    // #4940 — this catch used to be one of five that made `buildRegistry`'s
    // "fatal misconfiguration" throws non-fatal in practice. The Python-without-
    // sandbox case no longer reaches it on a guarded boot (`PythonSandboxGuardLive`
    // fails the boot Layer first), so what lands here is a genuinely unexpected
    // registry failure — and warning rather than aborting startup is right for a
    // credential DIAGNOSTIC, which is all this block is.
    log.warn(
      { err: errorMessage(err) },
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
      { err: errorMessage(err) },
      "Could not validate action config at startup",
    );
  }
}

async function logSandboxPlugins(): Promise<void> {
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
        { err: errorMessage(err) },
        "Failed to enumerate sandbox plugins",
      );
    }
  } catch {
    // Plugin registry module not available — skip
  }
}

async function checkSandboxPreFlight(): Promise<void> {
  try {
    const { getConfig: getAtlasConfig } = await import("@atlas/api/lib/config");
    const sandboxPriority = getAtlasConfig()?.sandbox?.priority;
    if (sandboxPriority) {
      log.info(
        { priority: sandboxPriority },
        "Custom sandbox priority configured: %s",
        sandboxPriority.join(" > "),
      );
    }
  } catch (err) {
    const isModuleErr = err != null && typeof err === "object" && "code" in err
      && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (!isModuleErr) {
      log.warn(
        { err: errorMessage(err) },
        "Failed to read sandbox priority from config",
      );
    }
  }

  // This dispatch picks WHICH LOCAL RESOURCE IS WORTH PROBING — it does not
  // decide which backend is active. Those were the same question until #2383
  // added off-Vercel Vercel Sandbox support (VERCEL_TOKEN plus a team/project
  // id from env — or, since #3706, from `sandbox.vercel` in atlas.config.ts).
  // That shape sets none of the host-detection vars and has nothing local to
  // probe, so a Railway deploy lands on the auto-detect arm — and naming the
  // backend from this dispatch is what made boot log "no process isolation"
  // there while /api/health correctly reported `vercel-sandbox` (#4824).
  //
  // Each probe is also load-bearing beyond its logging; see autoDetectNsjail().
  const isVercelHost = process.env.ATLAS_RUNTIME === "vercel" || !!process.env.VERCEL;
  let pinnedNsjail: PinnedNsjailOutcome = "not-probed";
  if (!isVercelHost) {
    // On a Vercel host the default chain always resolves vercel-sandbox, so
    // there is nothing local worth probing. Two pre-existing holes: a Vercel
    // host that ALSO sets ATLAS_SANDBOX / ATLAS_SANDBOX_URL, or one pinned via
    // `sandbox.priority`, skips that backend's probe entirely — so health can
    // name a backend nothing verified.
    if (process.env.ATLAS_SANDBOX === "nsjail") {
      pinnedNsjail = await checkExplicitNsjail();
    } else if (process.env.ATLAS_SANDBOX_URL) {
      await checkSidecarHealth();
    } else {
      await autoDetectNsjail();
    }
  }

  // The probe outcome decides only what boot says ALONGSIDE the resolved-backend
  // line — never whether that line is emitted. Hoisting the delegation out of
  // the switch makes "every arm delegates" structural rather than a comment a
  // future arm can forget: this is the #4824 invariant stated positively, that
  // boot names what the ONE resolver says and so cannot disagree with
  // /api/health, which reads the same resolver.
  //
  // Arms that logged a bespoke line INSTEAD were the residual disagreement
  // (#4834). Both bespoke lines were nsjail-specific, which misreported the
  // deployment that sets BOTH `ATLAS_SANDBOX=nsjail` and a `sandbox.priority`
  // pin: `planSandboxSelection` gives `configPriority` absolute precedence, so
  // `ATLAS_SANDBOX` is ignored entirely there and the nsjail-only advice named a
  // backend that was never in play, while the real resolution went unlogged.
  // The `hard-fail` line is now gone. The `unverified` caveat below survives —
  // ACCEPTED RESIDUE, not an oversight. Two things are wrong with it under a
  // `configPriority` that outranks `ATLAS_SANDBOX`: it speaks of "the pin",
  // which is not the chain in play, and — unlike the `isolationVerified` field
  // in logResolvedExploreBackend — it is NOT gated on the resolved backend, so
  // it can raise an UNVERIFIED line against a correctly isolated
  // vercel-sandbox deployment. The two halves of one concern are gated
  // differently on purpose: the structured field feeds alerting and had to be
  // exact, while gating this line too needs the probe to know the resolved
  // chain, which is a separate change. The resolver line that follows names the
  // real backend meanwhile.
  if (pinnedNsjail === "unverified") {
    // The probe threw, so `_nsjailFailed` is untouched — and if the binary IS
    // present the resolver still names `nsjail`, exactly what /api/health will
    // report. (With the binary absent it names `fail-closed`, since #4834's
    // predicate probes rather than trusting the pin; `unverified` is reachable
    // that way because both dynamic imports run BEFORE findNsjailBinary().)
    //
    // Logged FIRST so the resolved-backend line that follows is read as
    // qualified: nsjail may be attempted, but nobody confirmed it works.
    // Suppressing that line instead is what left boot silent while health named
    // a backend — the same disagreement one notch softer.
    log.error(
      "Explore tool: isolation UNVERIFIED — the pinned nsjail probe could not complete. " +
        "The pin is still armed, so explore will attempt nsjail and fail if it cannot initialize.",
    );
  }

  // Absent a `sandbox.priority` pin AND an available vercel-sandbox, the
  // resolver reaches `fail-closed` on its own for both failing arms, from
  // different facts: "hard-fail" because `isBackendAvailable` probes the binary
  // and finds none (#4834), "capability-failed" because markNsjailFailed() ran
  // and, since #4829, no longer deletes the pin's hard-fail step. Neither needs
  // this code to tell it.
  //
  // Both carve-outs are real. An outranking `configPriority` resolves its own
  // list, legitimately `just-bash` when the operator kept it (config steps are
  // all `hardFail: false`, so nothing short-circuits). And the default chain
  // puts the soft vercel-sandbox step AHEAD of the pin's hard-fail step, so an
  // off-Vercel deploy with Vercel credentials resolves `vercel-sandbox` even
  // under the pin (#2383/#3706, `planSandboxSelection`).
  //
  // What holds in every case is the weaker and more useful claim: whatever the
  // resolver names here, /api/health names the same, because both read that one
  // resolver.
  //
  // The binary-missing specifics ("Install nsjail or set ATLAS_NSJAIL_PATH") are
  // not lost with the bespoke line: checkExplicitNsjail() already recorded them
  // as a startup warning, and formatSandboxFailClosed() adds the pin-scoped
  // remediation.
  await logResolvedExploreBackend(pinnedNsjail);
}

/**
 * Emit the ONE line naming the explore backend this process will actually use,
 * read from the same `getExploreBackendType()` that `/api/health` reports.
 *
 * Two ordering dependencies, both real:
 *
 * 1. **After the probes.** `getExploreBackendType()` consults `_nsjailFailed` /
 *    `_sidecarFailed`, so resolving first would report a degraded chain
 *    optimistically.
 * 2. **After `checkConfigFile()`.** `snapshotExploreSandboxEnv()` reads
 *    `getConfig()?.sandbox?.priority`;
 *    an unresolved config silently yields a different chain. Holds today
 *    because `checkConfigFile()` is step 5.5 of `validateEnvironment()` and the
 *    pre-flight is step 10 — sequential awaits in the same function.
 *
 * Sharing the resolver means boot and health cannot disagree *about the same
 * inputs*. They can still differ later in the process's life, legitimately:
 * sandbox-plugin detection is lazy (`_activeSandboxPluginId` is unset until the
 * first explore call, so a plugin-isolated deploy is not named `plugin` here),
 * and a backend can be marked failed at request time.
 *
 * The "no process isolation" warning is deliberately preserved for a genuine
 * `just-bash` deployment — that deployment really has no isolation and the line
 * is the correct and valuable thing to say there. What changed is that it is now
 * gated on the RESOLVED backend rather than on "we couldn't find nsjail".
 *
 * A `fail-closed` resolution takes a third branch: neither "X active" nor "no
 * process isolation" is true of a deployment where explore refuses every
 * request, and saying the latter would be #4824's false claim at inverted
 * polarity (#4828).
 */
async function logResolvedExploreBackend(
  /**
   * What the pinned-nsjail probe concluded, so this function can qualify its own
   * line. Taking the domain value rather than a pre-computed flag is what lets
   * it apply the verdict ONLY to the backend the probe actually spoke about —
   * see the `nsjail` check below.
   *
   * Required, not defaulted: the delegation was hoisted out of a switch so that
   * "every arm delegates" is structural rather than a comment a future arm can
   * forget, and the same reasoning applies here — a default would let a second
   * caller drop the caveat silently.
   */
  probe: PinnedNsjailOutcome,
): Promise<void> {
  try {
    const { getExploreBackendType, snapshotExploreSandboxEnv } = await import(
      "@atlas/api/lib/tools/explore"
    );
    const { BACKEND_ISOLATION, planSandboxSelection, describeSandboxFailClosed } = await import(
      "@atlas/api/lib/tools/backends/selection"
    );
    const backend = getExploreBackendType();
    if (backend === "fail-closed") {
      // No backend will construct — explore refuses every request. Recorded as a
      // startup warning (not just a log line) because it is a total tool outage,
      // and /api/health reports the same `fail-closed` from the same resolver.
      //
      // The detailed advice is built from a freshly-planned snapshot rather than
      // from the generic "install nsjail or configure ATLAS_SANDBOX_URL" line:
      // under a `sandbox.priority` pin that excludes both, that advice is
      // impossible to act on and hides the real cause (#4828). This second plan
      // equals the one the resolver used because `planSandboxSelection` is pure
      // and nothing mutates its inputs (`process.env`, `getConfig()`,
      // `_nsjailFailed`) across the intervening awaits.
      //
      // `deployMode` is passed straight through, undefined and all: `loadConfig`
      // assigns `_resolved` only after `applyDeployMode`, so a non-null
      // `getConfig()` always carries a resolved mode — and the only branch that
      // reads it (the just-bash escape hatch) is reachable only via
      // `configPriority`, which itself requires a non-null config.
      //
      // `describeSandboxFailClosed` owns the failure arm for message building —
      // shared with `/admin/sandbox`, which reports the same outage on the same
      // inputs and must degrade to the same words (#4837). Keeping that arm out
      // of the outer catch is the point: the resolution is already known to be
      // fail-closed, and letting a message-building throw fall through would
      // downgrade the single most severe state to "posture UNKNOWN" — a vaguer
      // claim with misdirecting remediation, and one that is simply false here
      // (health reports fail-closed correctly from the resolver alone; it never
      // calls this formatter).
      //
      // The config read sits inside the thunk for that reason. The explore
      // import above does NOT, deliberately: it precedes
      // `getExploreBackendType()`, so if it fails there is no known state to
      // downgrade and "posture UNKNOWN" is the honest report.
      const { message: msg, failureDetail } = await describeSandboxFailClosed(async () => {
        const { getConfig: getAtlasConfig } = await import("@atlas/api/lib/config");
        const env = snapshotExploreSandboxEnv();
        return {
          plan: planSandboxSelection(env),
          env,
          deployMode: getAtlasConfig()?.deployMode,
        };
      });
      // Scrubbed here, not in the seam: `describeSandboxFailClosed`'s catch arm
      // is contracted never to throw, so it takes no imports and returns the raw
      // text. A pg/better-auth error echoing a connection string is exactly what
      // `errorMessage` exists to keep out of this field.
      log.error({ backend, ...(failureDetail && { err: errorMessage(failureDetail) }) }, msg);
      if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      return;
    }
    if (BACKEND_ISOLATION[backend] === "unsandboxed") {
      log.info(
        { backend },
        "Explore tool: %s (no process isolation). Install nsjail or configure ATLAS_SANDBOX_URL for sandboxed execution.",
        backend,
      );
    } else if (probe === "unverified" && backend === "nsjail") {
      // `backend === "nsjail"` is the load-bearing half. The probe only ever
      // examined nsjail, so its inconclusive verdict says nothing about any
      // other backend — and `checkSandboxPreFlight` runs it whenever
      // `ATLAS_SANDBOX=nsjail`, INCLUDING when a `sandbox.priority` outranks the
      // pin and resolves, say, vercel-sandbox. Stamping `isolationVerified:
      // false` there would raise a false UNVERIFIED alert against a correctly
      // isolated deployment, on the one field added to be trustworthy.
      //
      // The two branches above deliberately drop the field even when the
      // unverified probe WAS about nsjail: a `fail-closed` or unsandboxed
      // resolution is already self-describing, and the stronger claim wins.
      //
      // Name collision worth knowing: `checks.explore.isolationVerified` in
      // `api/routes/health.ts` uses this identifier for a DIFFERENT condition —
      // "this is a plugin backend whose isolation claim Atlas has not audited" —
      // and health does not carry it for the unverified-nsjail case at all. The
      // posture still reaches health, but as startup-warning text, not a field.
      log.warn(
        { backend, isolationVerified: false },
        "Explore tool: %s selected, but isolation is UNVERIFIED — the boot probe could not complete.",
        backend,
      );
    } else {
      log.info({ backend }, "Explore tool: %s active", backend);
    }
  } catch (err) {
    // Deliberately does NOT fall back to the just-bash line: asserting "no
    // process isolation" when we simply failed to resolve the backend is
    // exactly the false claim #4824 was filed about. Surfaced as a startup
    // warning because the same throw breaks /api/health's own reporting, so
    // the isolation posture of this process is genuinely unknown.
    const msg =
      `Could not resolve the active explore backend: ${errorMessage(err)}. ` +
      "The sandbox isolation posture of this process is UNKNOWN and /api/health " +
      "will fail to report it. Check sandbox.priority in atlas.config.ts.";
    log.error(msg);
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
  }
}

/**
 * Outcome of probing the explicitly pinned nsjail backend. A boolean collapsed
 * states whose operator advice differs: binary missing, namespaces denied, probe
 * inconclusive.
 *
 * Binary-missing and namespaces-denied both REFUSE since #4829 (neither degrades
 * to an unsandboxed backend), and the resolver reports `fail-closed` for each —
 * reached independently of this type, so nothing here has to stay in sync with
 * it. `unverified` is genuinely open: the probe threw, so nsjail may well work
 * and the pin stays armed.
 *
 * Every arm delegates to `logResolvedExploreBackend()`; the outcome decides only
 * what boot says ALONGSIDE that line, never whether the resolved backend is
 * named at all (#4834).
 */
type PinnedNsjailOutcome =
  /**
   * No probe ran: `checkSandboxPreFlight` keeps this on a Vercel host and on
   * the sidecar / auto-detect branches. A separate member rather than a second
   * meaning for `"usable"`, so "the probe passed" is a truthful check for
   * whoever needs it next instead of an invariant held only by a doc comment.
   */
  | "not-probed"
  /** Namespaces verified; the pin holds. */
  | "usable"
  /**
   * Binary absent. The pin's hard-fail step stands (it always does since #4829)
   * and `isBackendAvailable` reports the step unavailable because it probes the
   * binary (#4834), so reporting resolves `fail-closed` — WITHOUT this arm
   * marking a runtime failure it did not observe. (Absent an outranking
   * `configPriority`, which resolves its own list instead.) Differs from
   * `"capability-failed"` in the operator advice `checkExplicitNsjail` records
   * as a startup warning — here the binary is missing, there it is present but
   * the platform denies namespaces. No consumer branches on that difference
   * today; only `"unverified"` is read.
   */
  | "hard-fail"
  /**
   * Binary present, namespaces broken. `markNsjailFailed()` has run, which marks
   * the backend unusable WITHOUT deleting the pin's hard-fail step (#4829) — so
   * the pin holds and explore fails closed rather than degrading (again, absent
   * an outranking `configPriority`).
   */
  | "capability-failed"
  /** The probe itself threw; isolation is neither confirmed nor refuted. */
  | "unverified";

/** Probe the explicitly pinned nsjail backend (`ATLAS_SANDBOX=nsjail`). */
async function checkExplicitNsjail(): Promise<PinnedNsjailOutcome> {
  let outcome: PinnedNsjailOutcome = "usable";
  try {
    const { findNsjailBinary, testNsjailCapabilities } = await import(
      "@atlas/api/lib/tools/explore-nsjail"
    );
    const { markNsjailFailed } = await import(
      "@atlas/api/lib/tools/explore"
    );
    const nsjailPath = findNsjailBinary();
    if (nsjailPath) {
      const semanticRoot = getDefaultSemanticRoot();
      const capResult = await testNsjailCapabilities(nsjailPath, semanticRoot);
      if (capResult.ok) {
        // Probe result only. Must NOT start with "Explore tool:" —
        // logResolvedExploreBackend() owns that prefix, and the tests read it.
        log.info("nsjail namespace capabilities verified");
      } else {
        // Marks nsjail unusable for BOTH construction and reporting. Since #4829
        // the planner no longer treats that flag as permission to drop the pin,
        // so explore fails closed here instead of running unsandboxed —
        // logResolvedExploreBackend() then reports `fail-closed`.
        markNsjailFailed();
        outcome = "capability-failed";
        const msg =
          `nsjail explicitly requested (ATLAS_SANDBOX=nsjail) but namespace creation failed: ${capResult.error}. ` +
          "This platform may not support Linux namespaces. Explore will refuse every request while the pin stands. " +
          "Set ATLAS_SANDBOX= (empty) to allow fallback to just-bash, or check platform documentation for namespace support.";
        log.error(msg);
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      }
    } else {
      // Deliberately does NOT call markNsjailFailed(), and #4834 REAFFIRMED that
      // rather than reversing it. The original reason (marking would delete the
      // pin's hard-fail step and degrade the box to unsandboxed just-bash) was
      // removed by #4829 — the step now stands regardless. The reason that still
      // holds is the narrower one #4824 pinned: the flag means "this backend
      // broke at RUNTIME", and an absent binary is a configuration state.
      //
      // #4834 considered marking here anyway, to stop `/api/health` naming
      // `nsjail` for a pin with no binary, and rejected it: that fix would work
      // only where this probe RUNS, and it does not run for every deployment
      // (`checkSandboxPreFlight` skips it on a Vercel host, and a
      // `sandbox.priority` pin outranks `ATLAS_SANDBOX` entirely). Honest
      // reporting must not be contingent on a probe. The predicate was fixed
      // instead — `isBackendAvailable` now means CONSTRUCTIBLE, so the resolver
      // reports `fail-closed` here from the binary's absence alone, with no
      // help from this arm and no fabricated runtime failure.
      outcome = "hard-fail";
      const msg =
        "ATLAS_SANDBOX=nsjail is set but nsjail binary was not found. " +
        "Install nsjail or set ATLAS_NSJAIL_PATH to the binary location.";
      log.error(msg);
      if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    }
  } catch (err) {
    // Isolation is UNVERIFIED, not refuted: `_nsjailFailed` is deliberately
    // untouched (unlike the capability-failed arm), so if the binary IS present
    // the resolver still names `nsjail` — matching /api/health, which reads the
    // same predicate. The caveat line the caller logs first is what keeps that
    // from reading as confirmed isolation.
    const msg =
      `Could not verify the pinned nsjail sandbox (ATLAS_SANDBOX=nsjail): ${errorMessage(err)}. ` +
      "Isolation is UNVERIFIED. Check the nsjail installation or set ATLAS_NSJAIL_PATH.";
    log.error(msg);
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
    outcome = "unverified";
  }
  return outcome;
}

async function checkSidecarHealth(): Promise<void> {
  // Caller guarantees ATLAS_SANDBOX_URL is set
  const sidecarUrl = process.env.ATLAS_SANDBOX_URL!;
  const { markSidecarFailed } = await import(
    "@atlas/api/lib/tools/explore"
  );
  try {
    const healthUrl = new URL("/health", sidecarUrl).toString();
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      // Probe result only — see the "Explore tool:" prefix note above.
      log.info({ url: sidecarUrl }, "Sandbox sidecar healthy at %s", sidecarUrl);
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
    const detail = errorMessage(err);
    const msg =
      `Sidecar unreachable at ${sidecarUrl}: ${detail}. ` +
      "The sidecar may not be running yet — explore will retry on first use.";
    log.error(msg);
    if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
  }
}

/**
 * Auto-detect branch of the sandbox pre-flight.
 *
 * The probe runs whenever this arm is reached, regardless of which backend
 * ultimately wins, because it is load-bearing beyond its own logging: a failed
 * namespace test calls `markNsjailFailed()`, and that flag gates
 * `tryCreateBackend("nsjail")` (`lib/tools/explore.ts`) as well as
 * `isBackendAvailable("nsjail")`. Short-circuiting it — the tempting "we
 * already know the backend, skip the probe" fix — would leave `_nsjailFailed`
 * unset, so a host whose winning backend fails to construct at request time
 * would fall through to a known-broken nsjail instead of skipping it (#4824).
 */
async function autoDetectNsjail(): Promise<void> {
  try {
    const { findNsjailBinary, testNsjailCapabilities } = await import(
      "@atlas/api/lib/tools/explore-nsjail"
    );
    const { markNsjailFailed } = await import(
      "@atlas/api/lib/tools/explore"
    );
    const nsjailPath = findNsjailBinary();
    if (nsjailPath) {
      const semanticRoot = getDefaultSemanticRoot();
      const capResult = await testNsjailCapabilities(nsjailPath, semanticRoot);
      if (!capResult.ok) {
        markNsjailFailed();
        const msg =
          `nsjail available but namespace creation failed: ${capResult.error} — ` +
          "falling back to the next backend in the sandbox priority chain.";
        log.warn(msg);
        if (!_startupWarnings.includes(msg)) _startupWarnings.push(msg);
      }
    }
  } catch (err) {
    const detail = errorMessage(err);
    log.warn({ err: detail }, "Sandbox pre-flight check skipped");
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
