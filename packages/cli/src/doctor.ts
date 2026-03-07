/**
 * Atlas Doctor — validate environment, connectivity, and configuration.
 *
 * Runs independent checks and reports results with pass/fail/warn indicators.
 * Exit 0 if all checks pass (warnings are OK), exit 1 if any critical check fails.
 */

import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";

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
        client.release();
        return {
          status: "pass",
          name: "Database connectivity",
          detail: `Connected (${version})`,
        };
      } finally {
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
        await pool.end().catch(() => {});
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let fix = "Check that the database server is running and the connection string is correct";
    if (/ECONNREFUSED/i.test(detail)) {
      fix = "Database connection refused — is the server running?";
    } else if (/timeout/i.test(detail)) {
      fix = "Connection timed out — check network/firewall settings";
    } else if (/authentication|password|access denied/i.test(detail)) {
      fix = "Authentication failed — check username and password in your connection string";
    }
    return {
      status: "fail",
      name: "Database connectivity",
      detail: "Connection failed",
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

export function checkSemanticLayer(): CheckResult {
  const semanticDir = path.resolve("semantic");
  const entitiesDir = path.join(semanticDir, "entities");
  const metricsDir = path.join(semanticDir, "metrics");

  if (!fs.existsSync(semanticDir)) {
    return {
      status: "fail",
      name: "Semantic layer",
      detail: "semantic/ directory not found",
      fix: "Run 'bun run atlas -- init' to generate a semantic layer, or 'bun run atlas -- init --demo' for demo data",
    };
  }

  let entityCount = 0;
  let metricCount = 0;
  const parseErrors: string[] = [];

  // Count and validate entities
  if (fs.existsSync(entitiesDir)) {
    const entityFiles = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
    for (const file of entityFiles) {
      try {
        const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
        // Lazy-load js-yaml only when needed
        const yaml = require("js-yaml");
        const doc = yaml.load(content);
        if (doc && typeof doc === "object" && "table" in doc) {
          entityCount++;
        } else {
          parseErrors.push(`${file}: missing 'table' field`);
        }
      } catch (err) {
        parseErrors.push(`${file}: ${err instanceof Error ? err.message : "parse error"}`);
      }
    }
  }

  // Count metrics (also check per-source subdirectories)
  if (fs.existsSync(metricsDir)) {
    metricCount = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yml")).length;
  }

  // Also check per-source subdirectories for entities
  try {
    const entries = fs.readdirSync(semanticDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "entities" && entry.name !== "metrics") {
        const subEntities = path.join(semanticDir, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          const subFiles = fs.readdirSync(subEntities).filter((f) => f.endsWith(".yml"));
          entityCount += subFiles.length;
        }
        const subMetrics = path.join(semanticDir, entry.name, "metrics");
        if (fs.existsSync(subMetrics)) {
          metricCount += fs.readdirSync(subMetrics).filter((f) => f.endsWith(".yml")).length;
        }
      }
    }
  } catch {
    // Ignore errors reading subdirectories
  }

  if (entityCount === 0) {
    return {
      status: "fail",
      name: "Semantic layer",
      detail: "No entity files found",
      fix: "Run 'bun run atlas -- init' to generate entity YAMLs from your database",
    };
  }

  if (parseErrors.length > 0) {
    return {
      status: "warn",
      name: "Semantic layer",
      detail: `${entityCount} entities, ${metricCount} metrics (${parseErrors.length} parse error${parseErrors.length > 1 ? "s" : ""})`,
      fix: `Fix: ${parseErrors[0]}`,
    };
  }

  return {
    status: "pass",
    name: "Semantic layer",
    detail: `${entityCount} entities, ${metricCount} metrics`,
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
      await pool.end().catch(() => {});
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let fix = "Check that the database server is running and DATABASE_URL is correct";
    if (/ECONNREFUSED/i.test(detail)) {
      fix = "Database connection refused — is the server running?";
    } else if (/authentication|password/i.test(detail)) {
      fix = "Authentication failed — check username and password in DATABASE_URL";
    }
    return {
      status: "fail",
      name: "Internal DB",
      detail: "Connection failed",
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return pc.green("✓");
    case "fail":
      return pc.red("✗");
    case "warn":
      return pc.yellow("⚠");
  }
}

export function renderResults(results: CheckResult[]): void {
  const maxNameLen = Math.max(...results.map((r) => r.name.length));

  p.intro(pc.bold("Atlas Doctor"));

  for (const result of results) {
    const icon = statusIcon(result.status);
    const name = result.name.padEnd(maxNameLen);
    console.log(`  ${icon} ${name}  ${result.detail}`);
    if (result.fix) {
      console.log(`    ${pc.dim("→")} ${pc.dim(result.fix)}`);
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [];

  // Run all checks independently
  results.push(checkDatasourceUrl());
  results.push(await checkDatabaseConnectivity());
  results.push(checkProvider());
  results.push(checkSemanticLayer());
  results.push(checkSandbox());
  results.push(await checkInternalDb());

  renderResults(results);

  // Exit 1 only for critical failures (env vars, DB connectivity, provider)
  const hasCriticalFailure = results.some(
    (r) =>
      r.status === "fail" &&
      // Sandbox and Internal DB are optional
      r.name !== "Sandbox" &&
      r.name !== "Internal DB",
  );

  return hasCriticalFailure ? 1 : 0;
}
