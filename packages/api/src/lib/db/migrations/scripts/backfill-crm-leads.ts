/**
 * One-shot backfill: enqueue every existing `demo_leads` row into
 * `crm_outbox` so the lead-outbox flusher dispatches them to Twenty
 * as Persons (#2736, slice 10 of 1.6.0).
 *
 * The PRD (#2738) out-of-scoped historic backfill from v1 — the runtime
 * path is forward-only — but marketing-ops wants the back-catalog in
 * Twenty for continuity. This script is the one-time bridge.
 *
 * Idempotency is paid for by the dispatcher, not the script:
 * `TwentyClient.upsertPerson` dedupes by `emails.primaryEmail`, so
 * re-running the backfill (or processing duplicate enqueues from a
 * crash mid-run) never creates duplicate Persons. We never need to
 * stamp anything on `demo_leads` to track "already-backfilled".
 *
 * Invocation:
 *   bun run atlas -- ops backfill-crm-leads [--dry-run] [--batch-size N] [--source demo]
 *
 * Or directly:
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/backfill-crm-leads.ts [--dry-run]
 *
 * Prod-run date: TBD (paste here when run).
 */

import { Client } from "pg";
import { normalizeLead, type AtlasLeadEvent, type NormalizedLead } from "@useatlas/twenty/lead-normalizer";

/** Surface every code path the script touches — keeps the unit tests
 *  decoupled from `pg.Client`. The `pg` driver's `query` returns a
 *  `{ rows }` shape; tests pass a fake that implements the same. */
export interface BackfillDB {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Default rows per transaction. Override via `--batch-size`. */
export const DEFAULT_BATCH_SIZE = 500;

/** How many normalized payloads dry-run prints as a sanity preview. */
export const DRY_RUN_SAMPLE_SIZE = 3;

/** Lead source today is always `"demo"` — `--source` is parameterized
 *  so a future sales-form-leads table can use the same harness. The
 *  normalizer's exhaustive switch is the drift gate. */
export type BackfillSource = "demo";

export interface BackfillOptions {
  readonly db: BackfillDB;
  /** When true, count + sample only — never writes. */
  readonly dryRun: boolean;
  /** Rows per transaction. Must be ≥ 1. */
  readonly batchSize: number;
  /** Source variant. Today only `"demo"`. */
  readonly source: BackfillSource;
  /**
   * Progress sink. Default `console.log`. Tests pass a collector to
   * assert progress lines without polluting test output.
   */
  readonly log?: (message: string) => void;
}

export interface BackfillStats {
  /** Rows the script walked. Matches `SELECT COUNT(*) FROM demo_leads`. */
  readonly totalRows: number;
  /** Rows actually enqueued into `crm_outbox`. Zero in dry-run. */
  readonly enqueued: number;
  /** Number of batches issued. `Math.ceil(totalRows / batchSize)`. */
  readonly batches: number;
  /** First N normalized payloads. Only populated in dry-run mode so the
   *  operator can sanity-check the transform without grepping logs. */
  readonly sample: readonly NormalizedLead[];
}

/** Row shape from the keyset cursor over `demo_leads`. Kept tight so a
 *  schema drift (new column) doesn't accidentally land in the normalized
 *  payload — the demo lead event union enumerates exactly what we send.
 *  The `[k: string]: unknown` index signature is purely to satisfy
 *  `BackfillDB.query`'s `T extends Record<string, unknown>` constraint;
 *  it doesn't loosen the read sites — every column access still types
 *  through the named field above. */
interface DemoLeadRow {
  id: string;
  email: string;
  ip_address: string | null;
  user_agent: string | null;
  [k: string]: unknown;
}

/**
 * Keyset pagination by `id` (UUID) alone. Walk order is by UUID, not
 * insertion time — which is fine for a one-shot backfill that just
 * needs to visit every row exactly once. OFFSET would risk
 * missed/duplicated rows if new demo signups slip in mid-run; the
 * keyset keeps the walk monotonic.
 *
 * Why not `(created_at, id)`: a JavaScript `Date` is millisecond-
 * precision but Postgres `timestamptz` is microsecond-precision. The
 * round-trip drops the trailing microseconds, so a bulk-INSERT row
 * batch sharing the same `now()` timestamp produced cursor values that
 * compared as STRICTLY LESS than the source rows on the next page —
 * the cursor never advanced and the loop never terminated. (Debug
 * trace: 30 rows / batchSize 10 looped past `(40/30)`, `(50/30)`, …
 * indefinitely.) UUID-only keyset has no precision loss.
 */
const FIRST_PAGE_SQL = `
  SELECT id, email, ip_address, user_agent
    FROM demo_leads
   ORDER BY id
   LIMIT $1
`;

const NEXT_PAGE_SQL = `
  SELECT id, email, ip_address, user_agent
    FROM demo_leads
   WHERE id > $1::uuid
   ORDER BY id
   LIMIT $2
`;

const COUNT_SQL = `SELECT COUNT(*)::bigint AS n FROM demo_leads`;

/**
 * Build a multi-row VALUES INSERT for one batch — one round trip per
 * batch instead of one per row. We construct the placeholders by hand
 * (`($1, $2::jsonb), ($3, $4::jsonb), …`) instead of binding `text[]`
 * arrays because the payload JSON contains `{`, `,`, `"` — characters
 * that collide with Postgres's array-literal syntax under driver-side
 * array serialization. The first cut used `UNNEST($1::text[], $2::text[])`
 * and produced wildly over-inflated insert counts because the JSON
 * payloads were parsed as multi-element array literals. Multi-row
 * VALUES with positional placeholders is the boring, correct path.
 */
function buildBulkEnqueueSql(rowCount: number): string {
  const placeholders: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * 2;
    placeholders.push(`($${base + 1}, $${base + 2}::jsonb, 'pending')`);
  }
  return `INSERT INTO crm_outbox (event_type, payload, status) VALUES ${placeholders.join(", ")} RETURNING id`;
}

/** Map a `demo_leads` row to the corresponding `AtlasLeadEvent`.
 *  Today only the demo variant — a future sales-form table will fan
 *  out a sibling mapper. */
function toLeadEvent(row: DemoLeadRow, source: BackfillSource): AtlasLeadEvent {
  switch (source) {
    case "demo":
      return {
        source: "demo",
        email: row.email,
        ip: row.ip_address,
        userAgent: row.user_agent,
      };
    default: {
      const _exhaustive: never = source;
      void _exhaustive;
      throw new Error(`Unsupported backfill source: ${String(source)}`);
    }
  }
}

/**
 * Core backfill. Pure of process-exit and stdout: returns stats, lets
 * the caller decide how to surface them (CLI handler prints + sets
 * exit code; tests assert on the return value).
 *
 * Errors propagate. The caller (CLI handler or direct `main`) catches
 * and exits non-zero. We deliberately do not swallow inside the loop
 * because a partial-progress crash + silent success is exactly the
 * "did the backfill actually finish?" anxiety the script exists to
 * remove.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillStats> {
  if (options.batchSize < 1) {
    throw new Error(`batchSize must be ≥ 1 (got ${options.batchSize})`);
  }
  const log = options.log ?? ((msg: string) => console.log(msg));

  const totalResult = await options.db.query<{ n: string }>(COUNT_SQL);
  const totalRows = Number(totalResult.rows[0]?.n ?? 0);

  if (totalRows === 0) {
    log(`[backfill-crm-leads] demo_leads is empty — nothing to enqueue`);
    return { totalRows: 0, enqueued: 0, batches: 0, sample: [] };
  }

  log(
    `[backfill-crm-leads] ${options.dryRun ? "DRY-RUN" : "ENQUEUE"} — ` +
      `${totalRows} row(s), batch size ${options.batchSize}`,
  );

  // Keyset cursor state. `null` sentinel = first page (no lower bound).
  let cursorId: string | null = null;

  let processed = 0;
  let enqueued = 0;
  let batches = 0;
  const sample: NormalizedLead[] = [];

  while (true) {
    const page: { rows: DemoLeadRow[] } =
      cursorId === null
        ? await options.db.query<DemoLeadRow>(FIRST_PAGE_SQL, [options.batchSize])
        : await options.db.query<DemoLeadRow>(NEXT_PAGE_SQL, [
            cursorId,
            options.batchSize,
          ]);
    if (page.rows.length === 0) break;

    // Flat `[event_type_0, payload_0, event_type_1, payload_1, …]` so
    // the positional placeholders in `buildBulkEnqueueSql` line up with
    // their VALUES tuples.
    const params: unknown[] = [];
    for (const row of page.rows) {
      const event = toLeadEvent(row, options.source);
      const normalized = normalizeLead(event);
      // The dispatcher receives the raw event under `payload`, then
      // re-normalizes (see `ee/src/saas-crm/index.ts:dispatchOutboxRow`).
      // Mirroring the runtime path means a normalizer change post-deploy
      // doesn't strand backfilled rows in `payload` shapes the dispatcher
      // can't interpret.
      params.push(event.source, JSON.stringify(event));

      if (options.dryRun && sample.length < DRY_RUN_SAMPLE_SIZE) {
        sample.push(normalized);
      }
    }

    if (!options.dryRun) {
      // BEGIN/COMMIT around the bulk INSERT — keeps each batch atomic
      // so a mid-batch crash doesn't leave a partial spray of outbox
      // rows. The flusher tolerates duplicates (upsertPerson dedupes)
      // but the operator's mental model is "either the batch landed
      // whole or it didn't", and that's worth the one-statement cost.
      await options.db.query("BEGIN");
      try {
        const sql = buildBulkEnqueueSql(page.rows.length);
        const result = await options.db.query<{ id: string }>(sql, params);
        await options.db.query("COMMIT");
        enqueued += result.rows.length;
      } catch (err) {
        await options.db.query("ROLLBACK").catch((rbErr) => {
          // Surfacing both keeps the actual fault visible — the
          // rollback failure is usually a connection blip, but the
          // original error is what the operator needs to debug.
          console.error(
            `[backfill-crm-leads] rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
          );
        });
        throw err;
      }
    }

    processed += page.rows.length;
    batches++;
    const last: DemoLeadRow = page.rows[page.rows.length - 1]!;
    cursorId = last.id;

    log(
      `[backfill-crm-leads] batch ${batches}: ${options.dryRun ? "would enqueue" : "enqueued"} ` +
        `${page.rows.length} row(s) (${processed}/${totalRows})`,
    );

    // A short page (page.rows.length < batchSize) means we just drained
    // the tail — short-circuit instead of issuing one more query that
    // we already know returns empty.
    if (page.rows.length < options.batchSize) break;
  }

  if (options.dryRun) {
    log(
      `[backfill-crm-leads] DRY-RUN summary — ${totalRows} row(s) would be enqueued ` +
        `across ${batches} batch(es); ${sample.length} sample payload(s) collected`,
    );
  } else {
    log(
      `[backfill-crm-leads] ✓ enqueued ${enqueued}/${totalRows} row(s) across ${batches} batch(es)`,
    );
  }

  return { totalRows, enqueued, batches, sample };
}

/** Direct invocation: `bun run packages/api/src/lib/db/migrations/scripts/backfill-crm-leads.ts`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchSize = pickFlagInt(args, "--batch-size", DEFAULT_BATCH_SIZE);
  const source = (pickFlagString(args, "--source", "demo") as BackfillSource);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[backfill-crm-leads] DATABASE_URL not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const stats = await runBackfill({
      db: client as unknown as BackfillDB,
      dryRun,
      batchSize,
      source,
    });
    if (dryRun && stats.sample.length > 0) {
      console.log(`[backfill-crm-leads] first ${stats.sample.length} normalized payload(s):`);
      for (const s of stats.sample) {
        console.log(JSON.stringify(s, null, 2));
      }
    }
  } catch (err) {
    console.error(
      `[backfill-crm-leads] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[backfill-crm-leads] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}

function pickFlagInt(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  const parsed = Number.parseInt(args[idx + 1]!, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer (got "${args[idx + 1]}")`);
  }
  return parsed;
}

function pickFlagString(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1]!;
}

// Only run main when invoked directly (not when imported by the CLI handler
// or unit tests). `import.meta.main` is the bun-native check.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[backfill-crm-leads] script crashed:", err);
    process.exit(1);
  });
}
