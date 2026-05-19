/**
 * atlas ops — operator-only tools that touch tenant data.
 *
 * Subcommands:
 *   wipe   TRUNCATE every public table in the tenant DB (excluding migration
 *          bookkeeping) with RESTART IDENTITY CASCADE. DESTRUCTIVE — gated by
 *          --confirm + ATLAS_WIPE_OK=1. No backup taken; wrap with pg_dump
 *          yourself.
 *
 * Wipe replaces internal/wipe-prod.sh's per-DB logic; the script's
 * Railway-credential fetching and 3-region orchestration are operator concerns
 * that live in shell. The CLI wipes one DB per invocation so the SQL surface
 * stays testable.
 */
import { getFlag } from "../../lib/cli-utils";
import type { TenantPgClient } from "../../lib/tenant-db";

/** Tables that must survive a wipe — migration bookkeeping. */
export const WIPE_EXCLUDED_TABLES = [
  "__atlas_migrations",
  "region_migrations",
] as const;

/** SQL listing every public table not in the exclusion set. Derived from
 *  WIPE_EXCLUDED_TABLES so there's one source of truth — the table names
 *  are static identifiers, not operator input, so interpolation is safe. */
export const WIPE_LIST_TABLES_SQL = `SELECT tablename FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename NOT IN (${WIPE_EXCLUDED_TABLES.map((t) => `'${t}'`).join(", ")})
 ORDER BY tablename`;

/**
 * Run the wipe end-to-end: list the public tables not in the exclusion set,
 * then `TRUNCATE … RESTART IDENTITY CASCADE` in a single statement. Returns
 * the list of tables actually truncated so the handler can warn when zero
 * tables matched (typo'd DB URL) instead of logging a misleading "done".
 *
 * Table names are read from `pg_tables` (system catalog, not operator input)
 * and quoted with `pg`'s `escapeIdentifier`, so the `EXECUTE` is safe.
 */
export async function wipeTenantPublicTables(
  client: TenantPgClient,
): Promise<{ tablesTruncated: readonly string[] }> {
  const tables = await client.query<{ tablename: string }>(WIPE_LIST_TABLES_SQL);
  const names = tables.rows.map((r) => r.tablename);
  if (names.length === 0) {
    return { tablesTruncated: [] };
  }
  // pg_tables returns the unquoted identifier; quote for the EXECUTE.
  const list = names.map((n) => `public.${quoteIdent(n)}`).join(", ");
  await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  return { tablesTruncated: names };
}

/** Postgres identifier quoting — doubles any embedded `"` and wraps in `"`. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Exported so unit tests can pin the double-confirm contract. */
export function checkWipeGate(args: string[], env: NodeJS.ProcessEnv): string | null {
  if (env.ATLAS_WIPE_OK !== "1") {
    return "Refusing to wipe: set ATLAS_WIPE_OK=1 in the env to confirm.";
  }
  if (!args.includes("--confirm")) {
    return "Refusing to wipe: pass --confirm to acknowledge the double-confirm gate.";
  }
  return null;
}

/** Resolve which DB URL to wipe — explicit --database-url wins over the env. */
export function resolveWipeUrl(args: string[], env: NodeJS.ProcessEnv): string | null {
  const explicit = getFlag(args, "--database-url");
  if (explicit) return explicit;
  return env.ATLAS_TEAM_PG_URL || env.DATABASE_URL || null;
}

async function handleWipe(args: string[]): Promise<void> {
  const gateError = checkWipeGate(args, process.env);
  if (gateError) {
    console.error(`[ops:wipe] ${gateError}`);
    process.exit(1);
  }
  const url = resolveWipeUrl(args, process.env);
  if (!url) {
    console.error(
      "[ops:wipe] No DB URL available. Pass --database-url or set ATLAS_TEAM_PG_URL / DATABASE_URL.",
    );
    process.exit(1);
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log(
      `[ops:wipe] truncating public tables (excluding ${WIPE_EXCLUDED_TABLES.join(", ")})…`,
    );
    const { tablesTruncated } = await wipeTenantPublicTables(
      client as unknown as TenantPgClient,
    );
    if (tablesTruncated.length === 0) {
      // Wiping nothing is suspicious — almost always a wrong-DB typo. Exit
      // with a distinct code (2) so chained scripts can branch on it.
      console.warn(
        "[ops:wipe] ⚠ zero tables matched — wrong DB? Nothing was truncated.",
      );
      process.exitCode = 2;
      return;
    }
    // Quick sanity: count the auth user table — should be 0 post-wipe.
    const r = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM "user"',
    );
    console.log(
      `[ops:wipe] ✓ truncated ${tablesTruncated.length} table(s) — user table now has ${r.rows[0]?.n ?? "?"} rows`,
    );
  } catch (err) {
    console.error(
      `[ops:wipe] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[ops:wipe] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}

export async function handleOps(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "wipe") return handleWipe(args);

  console.error(
    "Usage: atlas ops <wipe> [options]\n\n" +
      "Subcommands:\n" +
      "  wipe   TRUNCATE every public table in the tenant DB. DESTRUCTIVE — requires ATLAS_WIPE_OK=1 + --confirm.\n",
  );
  process.exit(1);
}
