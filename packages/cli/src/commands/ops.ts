/**
 * atlas ops — operator-only tools that touch tenant data.
 *
 * Subcommands:
 *   wipe                   TRUNCATE every public table in the tenant DB (excluding
 *                          migration bookkeeping) with RESTART IDENTITY CASCADE.
 *                          DESTRUCTIVE — gated by --confirm + ATLAS_WIPE_OK=1. No
 *                          backup taken; wrap with pg_dump yourself.
 *   backfill-crm-leads     Enqueue every existing `demo_leads` row into `crm_outbox`
 *                          so the lead-outbox flusher dispatches them to Twenty as
 *                          Persons. Re-runs are safe — `TwentyClient.upsertPerson`
 *                          dedupes by primary email. See #2736.
 *
 * Wipe replaces internal/wipe-prod.sh's per-DB logic; the script's
 * Railway-credential fetching and 3-region orchestration are operator concerns
 * that live in shell. The CLI wipes one DB per invocation so the SQL surface
 * stays testable.
 */
import {
  runBackfill,
  DEFAULT_BATCH_SIZE,
  BACKFILL_SOURCES,
  type BackfillSource,
} from "@atlas/api/lib/db/migrations/scripts/backfill-crm-leads";
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

/** Exported for tests — parses `--batch-size N` with a positive-integer
 *  invariant. Returns the default when the flag is entirely absent; throws
 *  when the flag is present without a value (e.g. `--batch-size --dry-run`
 *  or `--batch-size` at end of args) OR present with a malformed value.
 *  Loud-failing on missing values matters more here than for typical
 *  optional CLI flags — this command writes to `crm_outbox`, and silently
 *  defaulting to 500 on an operator typo would hide intent. */
export function parseBatchSize(args: string[], fallback: number = DEFAULT_BATCH_SIZE): number {
  const raw = getFlag(args, "--batch-size");
  if (raw === undefined) {
    if (args.includes("--batch-size")) {
      throw new Error("--batch-size requires a value (e.g. --batch-size 500)");
    }
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--batch-size requires a positive integer (got "${raw}")`);
  }
  return n;
}

/** Exported for tests — validates `--source` against `BACKFILL_SOURCES`.
 *  Same loud-failing rule as `parseBatchSize`: throws when the flag is
 *  present without a value, throws on unknown values, defaults only when
 *  the flag is entirely absent. */
export function parseBackfillSource(
  args: string[],
  fallback: BackfillSource = "demo",
): BackfillSource {
  const raw = getFlag(args, "--source");
  if (raw === undefined) {
    if (args.includes("--source")) {
      throw new Error(
        `--source requires a value — one of: ${BACKFILL_SOURCES.join(", ")}`,
      );
    }
    return fallback;
  }
  if (!(BACKFILL_SOURCES as readonly string[]).includes(raw)) {
    throw new Error(
      `--source must be one of: ${BACKFILL_SOURCES.join(", ")} (got "${raw}")`,
    );
  }
  return raw as BackfillSource;
}

/** Resolve which DB URL to backfill against — explicit --database-url
 *  wins over ATLAS_TEAM_PG_URL, which wins over DATABASE_URL. Same
 *  precedence as `wipe` so operators don't have to remember a second rule. */
export function resolveBackfillUrl(args: string[], env: NodeJS.ProcessEnv): string | null {
  const explicit = getFlag(args, "--database-url");
  if (explicit) return explicit;
  return env.ATLAS_TEAM_PG_URL || env.DATABASE_URL || null;
}

async function handleBackfillCrmLeads(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  let batchSize: number;
  let source: BackfillSource;
  try {
    batchSize = parseBatchSize(args);
    source = parseBackfillSource(args);
  } catch (err) {
    console.error(
      `[ops:backfill-crm-leads] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const url = resolveBackfillUrl(args, process.env);
  if (!url) {
    console.error(
      "[ops:backfill-crm-leads] No DB URL available. Pass --database-url or set ATLAS_TEAM_PG_URL / DATABASE_URL.",
    );
    process.exit(1);
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const stats = await runBackfill({
      db: client as unknown as Parameters<typeof runBackfill>[0]["db"],
      dryRun,
      batchSize,
      source,
    });
    if (dryRun && stats.sample.length > 0) {
      console.log(
        `[ops:backfill-crm-leads] first ${stats.sample.length} normalized payload(s):`,
      );
      for (const s of stats.sample) {
        console.log(JSON.stringify(s, null, 2));
      }
    }
  } catch (err) {
    console.error(
      `[ops:backfill-crm-leads] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[ops:backfill-crm-leads] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}

export async function handleOps(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "wipe") return handleWipe(args);
  if (subcommand === "backfill-crm-leads") return handleBackfillCrmLeads(args);

  console.error(
    "Usage: atlas ops <wipe|backfill-crm-leads> [options]\n\n" +
      "Subcommands:\n" +
      "  wipe                 TRUNCATE every public table in the tenant DB. DESTRUCTIVE — requires ATLAS_WIPE_OK=1 + --confirm.\n" +
      "  backfill-crm-leads   Enqueue every demo_leads row into crm_outbox for dispatch to Twenty.\n" +
      "                       Flags: --dry-run, --batch-size N (default 500), --source demo, --database-url <url>\n",
  );
  process.exit(1);
}
