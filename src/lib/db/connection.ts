/**
 * Database connection factory.
 *
 * PostgreSQL via `pg` Pool with statement_timeout per query.
 * Requires DATABASE_URL in environment.
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface DBConnection {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
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

// --- Singleton ---
let _db: DBConnection | null = null;

export function getDB(): DBConnection {
  if (!_db) {
    _db = createPostgresDB();
  }
  return _db;
}
