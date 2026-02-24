/**
 * Database connection factory.
 *
 * Supports PostgreSQL (via `pg` Pool) and SQLite (via `bun:sqlite`).
 * Dispatches based on DATABASE_URL format:
 *   - `postgresql://` or `postgres://` → PostgreSQL
 *   - Anything else (file:path, relative path, absolute path) → SQLite
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface DBConnection {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
}

export type DBType = "postgres" | "sqlite";

/**
 * Detect database type from a connection string or DATABASE_URL.
 * PostgreSQL URLs start with `postgresql://` or `postgres://`.
 * Everything else is treated as SQLite.
 */
export function detectDBType(url?: string): DBType {
  const connStr = url ?? process.env.DATABASE_URL ?? "";
  if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) {
    return "postgres";
  }
  return "sqlite";
}

/**
 * Resolve a SQLite path from DATABASE_URL.
 * Handles file: URIs (file:./path, file:///path, file://host/path)
 * and plain paths. Resolves relative paths against cwd.
 */
export function resolveSQLitePath(url: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require("path");
  let p = url;

  if (p.startsWith("file:")) {
    // Handle proper file:// URIs (file:///path, file://host/path)
    if (p.startsWith("file://")) {
      try {
        const parsed = new URL(p);
        p = parsed.pathname;
      } catch {
        // Malformed file:// URI — strip prefix and resolve
        p = p.slice(7);
      }
    } else {
      // Handle file:./relative or file:/absolute
      p = p.slice(5);
    }
  }

  if (!p.startsWith("/")) {
    p = pathMod.resolve(process.cwd(), p);
  }
  return p;
}

function createPostgresDB(): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
  });

  return {
    async query(sql: string, timeoutMs = 30000) {
      const client = await pool.connect();
      try {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        const result = await client.query(sql);
        const columns = result.fields.map(
          (f: { name: string }) => f.name
        );
        return { columns, rows: result.rows };
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

let _sqliteTimeoutWarned = false;

function createSQLiteDB(): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite");
  const dbPath = resolveSQLitePath(process.env.DATABASE_URL ?? "atlas.db");

  let db;
  try {
    // Open readonly for defense-in-depth — SQL validation already blocks
    // mutations, but readonly mode prevents bypass if a parser bug is found.
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[atlas] Failed to open SQLite database:", detail);
    throw new Error(
      "Cannot open the SQLite database. Check that the file exists, has correct permissions, " +
      "and is not locked by another process. See server logs for details.",
      { cause: err }
    );
  }

  if (!_sqliteTimeoutWarned && process.env.ATLAS_QUERY_TIMEOUT) {
    console.warn(
      `[atlas] SQLite does not support per-query timeouts. ` +
      `ATLAS_QUERY_TIMEOUT (${process.env.ATLAS_QUERY_TIMEOUT}ms) is ignored for SQLite.`
    );
    _sqliteTimeoutWarned = true;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async query(sql: string, _timeoutMs?: number) {
      // SQLite does not support per-query timeouts natively; bun:sqlite
      // runs synchronously. Auto-LIMIT provides partial mitigation.
      const stmt = db.query(sql);
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = stmt.columnNames as string[];
      return { columns, rows };
    },
    async close() {
      db.close();
    },
  };
}

// --- Singleton ---
let _db: DBConnection | null = null;

export function getDB(): DBConnection {
  if (!_db) {
    _db = detectDBType() === "sqlite" ? createSQLiteDB() : createPostgresDB();
  }
  return _db;
}
