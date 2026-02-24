/**
 * Database connection factory.
 *
 * Supports SQLite (demo/dev) and PostgreSQL (production).
 * Set ATLAS_DB=sqlite or ATLAS_DB=postgres in your .env.
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface DBConnection {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
}

// --- SQLite adapter ---
function createSQLiteDB(): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const dbPath = process.env.ATLAS_SQLITE_PATH ?? "./data/atlas.db";
  const db = new Database(dbPath, { readonly: true });

  return {
    async query(sql: string) {
      const stmt = db.prepare(sql);
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows };
    },
    async close() {
      db.close();
    },
  };
}

// --- PostgreSQL adapter ---
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

// --- Singleton ---
let _db: DBConnection | null = null;

export function getDB(): DBConnection {
  if (!_db) {
    const dbType = process.env.ATLAS_DB ?? "sqlite";
    switch (dbType) {
      case "sqlite":
        _db = createSQLiteDB();
        break;
      case "postgres":
        _db = createPostgresDB();
        break;
      default:
        throw new Error(
          `Unknown ATLAS_DB="${dbType}". Supported: sqlite, postgres`
        );
    }
  }
  return _db;
}
