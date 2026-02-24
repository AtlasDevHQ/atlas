/**
 * Startup diagnostics.
 *
 * Validates environment configuration on first API request and returns
 * clear, actionable error messages. Never exposes secrets or stack traces.
 */

import * as fs from "fs";
import * as path from "path";
import { detectDBType, resolveSQLitePath } from "./db/connection";

export interface DiagnosticError {
  code: "MISSING_DATABASE_URL" | "DB_UNREACHABLE" | "MISSING_API_KEY" | "MISSING_SEMANTIC_LAYER";
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
const ERROR_CACHE_TTL_MS = 30_000;

/**
 * Validate the environment and return any configuration errors.
 * Results are cached permanently after a successful (no-error) check.
 * When errors exist, validation re-runs every 30s to detect fixes.
 */
export async function validateEnvironment(): Promise<DiagnosticError[]> {
  if (_cached !== null) {
    if (_cached.length === 0 || Date.now() - _cachedAt < ERROR_CACHE_TTL_MS) {
      return _cached;
    }
  }

  const errors: DiagnosticError[] = [];

  // 1. DATABASE_URL
  if (!process.env.DATABASE_URL) {
    errors.push({
      code: "MISSING_DATABASE_URL",
      message:
        "DATABASE_URL is not set. Set it to a PostgreSQL connection string (postgresql://user:pass@host:5432/dbname) or a SQLite path (file:./data/atlas.db).",
    });
  }

  // 2. API key for configured provider
  const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
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

  // 4. Database connectivity (only if DATABASE_URL is set)
  if (process.env.DATABASE_URL) {
    const dbType = detectDBType();

    if (dbType === "sqlite") {
      // SQLite: check that the file exists and is readable
      const dbPath = resolveSQLitePath(process.env.DATABASE_URL);
      if (!fs.existsSync(dbPath)) {
        errors.push({
          code: "DB_UNREACHABLE",
          message: `SQLite database not found: ${dbPath}. Run 'bun run atlas -- init --demo' to create a demo database.`,
        });
      } else {
        // Quick connectivity test
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Database } = require("bun:sqlite");
          const db = new Database(dbPath, { readonly: true });
          db.query("SELECT 1").get();
          db.close();
        } catch (err) {
          const detail = err instanceof Error ? err.message : "";
          console.error("[atlas] SQLite connection check failed:", detail);
          errors.push({
            code: "DB_UNREACHABLE",
            message: "Cannot open the SQLite database. Check file permissions and that the file is a valid database.",
          });
        }
      }
    } else {
      // PostgreSQL: existing URL validation + connection test
      if (!isValidUrl(process.env.DATABASE_URL)) {
        errors.push({
          code: "DB_UNREACHABLE",
          message: "DATABASE_URL appears malformed. Expected format: postgresql://user:pass@host:5432/dbname",
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
          console.error("[atlas] DB connection check failed:", detail);

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
            console.warn("[atlas] Pool cleanup warning:", err instanceof Error ? err.message : String(err));
          });
        }
      }
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
