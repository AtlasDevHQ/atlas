/**
 * Atlas Doctor — individual check functions for environment, connectivity, and configuration.
 *
 * These checks are consumed by validate.ts which handles rendering and exit codes.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
  fix?: string;
}

/** Check names that are non-critical — failures don't cause exit 1 in doctor mode. */
export const NON_CRITICAL_CHECKS = new Set(["Sandbox", "Internal DB"]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  bedrock: "AWS_ACCESS_KEY_ID",
  ollama: "",
  gateway: "AI_GATEWAY_API_KEY",
};

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-opus-4-6-v1:0",
  ollama: "llama3.1",
  gateway: "anthropic/claude-opus-4.6",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mask a connection string for safe display.
 * Shows scheme, host, port, and database name — strips credentials.
 */
export function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(":", "");
    const host = parsed.hostname;
    const port = parsed.port;
    const dbName = parsed.pathname.replace(/^\//, "");
    const portPart = port ? `:${port}` : "";
    return `${scheme}://${host}${portPart}/${dbName}`;
  } catch {
    return "(invalid URL)";
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkDatasourceUrl(): CheckResult {
  const url = process.env.ATLAS_DATASOURCE_URL;
  if (url) {
    return {
      status: "pass",
      name: "ATLAS_DATASOURCE_URL",
      detail: maskConnectionString(url),
    };
  }

  // Check demo-data fallback
  if (process.env.ATLAS_DEMO_DATA === "true") {
    const fallback = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
    if (fallback) {
      return {
        status: "pass",
        name: "ATLAS_DATASOURCE_URL",
        detail: `via ATLAS_DEMO_DATA (${maskConnectionString(fallback)})`,
      };
    }
  }

  return {
    status: "fail",
    name: "ATLAS_DATASOURCE_URL",
    detail: "Not set",
    fix: "Set ATLAS_DATASOURCE_URL to a database connection string (e.g. postgresql://user:pass@host:5432/dbname)",
  };
}

export async function checkDatabaseConnectivity(): Promise<CheckResult> {
  const url =
    process.env.ATLAS_DATASOURCE_URL ||
    (process.env.ATLAS_DEMO_DATA === "true"
      ? process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
      : undefined);

  if (!url) {
    return {
      status: "fail",
      name: "Database connectivity",
      detail: "No datasource URL configured",
      fix: "Set ATLAS_DATASOURCE_URL first",
    };
  }

  // Detect DB type
  let dbType: string;
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    dbType = "postgres";
  } else if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
    dbType = "mysql";
  } else {
    // For non-core DB types, we can't easily test connectivity here
    const scheme = url.split("://")[0] || "unknown";
    return {
      status: "warn",
      name: "Database connectivity",
      detail: `${scheme}:// — connectivity check not supported (plugin databases validated at runtime)`,
    };
  }

  try {
    if (dbType === "postgres") {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: url,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      try {
        const client = await pool.connect();
        const versionResult = await client.query("SELECT version()");
        const versionStr = String(versionResult.rows[0]?.version ?? "");
        // Extract short version like "PostgreSQL 16.1"
        const match = versionStr.match(/^(PostgreSQL\s+[\d.]+)/);
        const version = match ? match[1] : versionStr.slice(0, 40);

        // Verify ATLAS_SCHEMA exists if configured
        const atlasSchema = process.env.ATLAS_SCHEMA;
        if (atlasSchema && atlasSchema !== "public") {
          try {
            const schemaResult = await client.query(
              "SELECT 1 FROM pg_namespace WHERE nspname = $1",
              [atlasSchema]
            );
            if (schemaResult.rows.length === 0) {
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
              client.release();
              return {
                status: "fail",
                name: "Database connectivity",
                detail: `Schema "${atlasSchema}" does not exist`,
                fix: `Check ATLAS_SCHEMA in your .env file.${schemaHint}`,
              };
            }
          } catch {
            client.release();
            return {
              status: "fail",
              name: "Database connectivity",
              detail: `Could not verify schema "${atlasSchema}"`,
              fix: "Check ATLAS_SCHEMA and database permissions",
            };
          }
        }

        client.release();
        return {
          status: "pass",
          name: "Database connectivity",
          detail: `Connected (${version})`,
        };
      } finally {
        // intentionally ignored: pool teardown errors are non-critical during diagnostics
        await pool.end().catch(() => {});
      }
    } else {
      // mysql
      const mysql = await import("mysql2/promise");
      const pool = mysql.createPool({
        uri: url,
        connectionLimit: 1,
        connectTimeout: 5000,
      });
      try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query("SELECT version() AS v");
        const version = (rows as Array<{ v: string }>)[0]?.v ?? "unknown";
        conn.release();
        return {
          status: "pass",
          name: "Database connectivity",
          detail: `Connected (MySQL ${version})`,
        };
      } finally {
        // intentionally ignored: pool teardown errors are non-critical during diagnostics
        await pool.end().catch(() => {});
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    let fix = "Check that the database server is running and the connection string is correct";
    if (/ECONNREFUSED/i.test(errMsg)) {
      fix = "Database connection refused — is the server running?";
    } else if (/timeout/i.test(errMsg)) {
      fix = "Connection timed out — check network/firewall settings";
    } else if (/authentication|password|access denied/i.test(errMsg)) {
      fix = "Authentication failed — check username and password in your connection string";
    } else if (dbType === "mysql" && /ER_BAD_DB_ERROR/i.test(errMsg)) {
      fix = "Database not found — check the database name in your connection string";
      try {
        const mysql = await import("mysql2/promise");
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
            fix = `Database not found. Available databases: ${schemas.join(", ")}.`;
          }
          listConn.release();
        } finally {
          await listPool.end().catch(() => {});
        }
      } catch {
        // Database listing failed — keep generic fix message
      }
    }
    return {
      status: "fail",
      name: "Database connectivity",
      detail: `Connection failed: ${errMsg}`,
      fix,
    };
  }
}

export function checkProvider(): CheckResult {
  const provider = process.env.ATLAS_PROVIDER ?? (process.env.VERCEL ? "gateway" : "anthropic");
  const model = process.env.ATLAS_MODEL ?? PROVIDER_DEFAULTS[provider] ?? "unknown";
  const requiredKey = PROVIDER_KEY_MAP[provider];

  if (requiredKey === undefined) {
    return {
      status: "warn",
      name: "LLM provider",
      detail: `Unknown provider "${provider}"`,
      fix: `Supported providers: ${Object.keys(PROVIDER_KEY_MAP).join(", ")}`,
    };
  }

  // Ollama has no key requirement
  if (requiredKey === "") {
    return {
      status: "pass",
      name: "LLM provider",
      detail: `${provider} (${model})`,
    };
  }

  if (process.env[requiredKey]) {
    return {
      status: "pass",
      name: "LLM provider",
      detail: `${provider} (${model})`,
    };
  }

  return {
    status: "fail",
    name: "LLM provider",
    detail: `${requiredKey} not set`,
    fix: `Set ${requiredKey} in your .env file`,
  };
}

export function checkSandbox(): CheckResult {
  // Vercel runtime
  if (process.env.ATLAS_RUNTIME === "vercel" || process.env.VERCEL) {
    return {
      status: "pass",
      name: "Sandbox",
      detail: "Vercel sandbox (Firecracker VM)",
    };
  }

  // Explicit nsjail
  if (process.env.ATLAS_SANDBOX === "nsjail") {
    const nsjailPath = process.env.ATLAS_NSJAIL_PATH || findOnPath("nsjail");
    if (nsjailPath) {
      return {
        status: "pass",
        name: "Sandbox",
        detail: `nsjail (${nsjailPath})`,
      };
    }
    return {
      status: "fail",
      name: "Sandbox",
      detail: "ATLAS_SANDBOX=nsjail but nsjail binary not found",
      fix: "Install nsjail or set ATLAS_NSJAIL_PATH to the binary location",
    };
  }

  // Sidecar
  if (process.env.ATLAS_SANDBOX_URL) {
    return {
      status: "pass",
      name: "Sandbox",
      detail: `Sidecar (${process.env.ATLAS_SANDBOX_URL})`,
    };
  }

  // Auto-detect nsjail on PATH
  const nsjailPath = findOnPath("nsjail");
  if (nsjailPath) {
    return {
      status: "pass",
      name: "Sandbox",
      detail: `nsjail auto-detected (${nsjailPath})`,
    };
  }

  return {
    status: "warn",
    name: "Sandbox",
    detail: "No sandbox configured (using just-bash fallback)",
    fix: "Install nsjail or set ATLAS_SANDBOX_URL for isolated execution",
  };
}

export async function checkInternalDb(): Promise<CheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      status: "warn",
      name: "Internal DB",
      detail: "DATABASE_URL not set (auth, audit, and settings will not persist)",
      fix: "Set DATABASE_URL to a PostgreSQL connection string for persistent auth and audit",
    };
  }

  try {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      const client = await pool.connect();

      // Check which Atlas tables exist
      const tablesResult = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('audit_log', 'scheduled_tasks', 'user', 'session', 'account', 'verification')`,
      );
      const tables = tablesResult.rows.map((r: { tablename: string }) => r.tablename);
      client.release();

      if (tables.length === 0) {
        return {
          status: "warn",
          name: "Internal DB",
          detail: `Connected (${maskConnectionString(url)}) — no Atlas tables found`,
          fix: "Tables are auto-created on first API start",
        };
      }

      return {
        status: "pass",
        name: "Internal DB",
        detail: `Connected (${tables.join(", ")})`,
      };
    } finally {
      // intentionally ignored: pool teardown errors are non-critical during diagnostics
      await pool.end().catch(() => {});
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    let fix = "Check that the database server is running and DATABASE_URL is correct";
    if (/ECONNREFUSED/i.test(errMsg)) {
      fix = "Database connection refused — is the server running?";
    } else if (/timeout/i.test(errMsg)) {
      fix = "Connection timed out — check network/firewall settings";
    } else if (/authentication|password|access denied/i.test(errMsg)) {
      fix = "Authentication failed — check username and password in DATABASE_URL";
    }
    return {
      status: "fail",
      name: "Internal DB",
      detail: `Connection failed: ${errMsg}`,
      fix,
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function findOnPath(binary: string): string | null {
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found in this dir
    }
  }
  return null;
}

