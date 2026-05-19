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

/**
 * The exact SQL we expect `wipeTenantPublicTables` to run. Pulled into a
 * constant so tests pin the literal — drift here would silently truncate
 * different tables than the operator expects.
 */
export const WIPE_TRUNCATE_SQL = `DO $$
DECLARE
  tables text;
BEGIN
  SELECT string_agg(format('public.%I', t.tablename), ', ')
    INTO tables
    FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename NOT IN ('__atlas_migrations', 'region_migrations');
  IF tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY CASCADE';
  END IF;
END $$;`;

/**
 * Issue the TRUNCATE-public-tables statement. Pure function over a client —
 * callers handle the wipe-gate (ATLAS_WIPE_OK + --confirm) before invocation.
 */
export async function wipeTenantPublicTables(
  client: TenantPgClient,
): Promise<void> {
  await client.query(WIPE_TRUNCATE_SQL);
}

/**
 * Belt-and-braces gate. Returns null if the operator passed BOTH the
 * --confirm flag AND ATLAS_WIPE_OK=1; otherwise an error message explaining
 * which gate is missing. Exported so the unit test can pin the contract.
 */
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
    await wipeTenantPublicTables(client as unknown as TenantPgClient);
    // Quick sanity: count the auth user table — should be 0 post-wipe.
    const r = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM "user"',
    );
    console.log(`[ops:wipe] ✓ done — user table now has ${r.rows[0]?.n ?? "?"} rows`);
  } catch (err) {
    console.error(
      `[ops:wipe] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
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
