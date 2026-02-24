/**
 * Startup diagnostics.
 *
 * Validates environment configuration on first API request and returns
 * clear, actionable error messages. Never exposes secrets or stack traces.
 */

import * as fs from "fs";
import * as path from "path";

export interface DiagnosticError {
  code: "MISSING_DATABASE_URL" | "DB_UNREACHABLE" | "MISSING_API_KEY" | "MISSING_SEMANTIC_LAYER";
  message: string;
}

const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  bedrock: "AWS_ACCESS_KEY_ID",
  ollama: "", // Ollama runs locally, no API key required
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
        "DATABASE_URL is not set. Set it to your PostgreSQL connection string (e.g., postgresql://user:pass@host:5432/dbname).",
    });
  }

  // 2. API key for configured provider
  const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
  const requiredKey = PROVIDER_KEY_MAP[provider];

  if (requiredKey === undefined) {
    // Unknown provider — providers.ts will throw a descriptive error at model init,
    // so we don't duplicate that check here.
  } else if (requiredKey && !process.env[requiredKey]) {
    errors.push({
      code: "MISSING_API_KEY",
      message: `${requiredKey} is not set. Atlas needs an API key for the ${provider} provider.`,
    });
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
        "No semantic layer found. Run 'bun run atlas -- init' to generate one from your database.",
    });
  }

  // 4. Database connectivity (only if DATABASE_URL is set)
  if (process.env.DATABASE_URL) {
    // Quick format check before attempting a connection
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
        await pool.end().catch(() => {});
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
