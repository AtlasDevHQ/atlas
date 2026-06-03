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
 * Dispatch timing (#2874): this script bulk-INSERTs directly and runs in
 * its own process with no flusher mounted, so it does NOT ring the
 * edge-trigger doorbell that the runtime `enqueue` uses. The backfilled
 * rows are picked up by the running API pod's backstop sweep (default
 * 5 min) rather than dispatching inline — acceptable for a one-time
 * back-catalog bridge that has no latency requirement.
 *
 * Invocation:
 *   bun run atlas -- ops backfill-crm-leads [--dry-run] [--batch-size N] [--source demo]
 *
 * Or directly:
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/backfill-crm-leads.ts [--dry-run]
 */

import { Client } from "pg";
import { normalizeLead, type AtlasLeadEvent, type NormalizedLead } from "@useatlas/twenty/lead-normalizer";
import { extractEmailKey } from "../../../lead-outbox/outbox";

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

/**
 * Operator-pipeline workspace_id stamped on backfilled rows when no
 * `organization.is_operator_workspace = true` row exists in the
 * target DB. Same constant the runtime `ee/src/saas-crm/` Layer uses
 * (`ATLAS_OPERATOR_WORKSPACE_SENTINEL`); duplicated here so the
 * backfill script stays free of the ee dep — the closeout-time grep
 * gate (`scripts/check-ee-imports.sh`) would reject an EE import in
 * a core script.
 */
export const ATLAS_OPERATOR_WORKSPACE_SENTINEL = "<atlas-operator>";

/**
 * Resolve the workspace_id to stamp on backfilled rows. Reads
 * `organization.is_operator_workspace = true` from the same DB the
 * INSERTs land in; falls back to the sentinel when the table is
 * absent (managed auth disabled) or no flagged row exists. Either
 * way, the runtime dispatcher routes the row through env creds.
 */
export async function resolveOperatorWorkspaceIdForBackfill(
  db: BackfillDB,
): Promise<string> {
  try {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM organization WHERE is_operator_workspace = true LIMIT 1`,
    );
    const id = result.rows[0]?.id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch (err) {
    // Same fall-through as the runtime resolver in
    // `ee/src/saas-crm/`: a missing `organization` table or
    // transport blip should not block the backfill. Log so an
    // operator running this script sees what happened.
    console.warn(
      `[backfill-crm-leads] operator workspace lookup failed (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to sentinel "${ATLAS_OPERATOR_WORKSPACE_SENTINEL}"; dispatcher will still route through env creds`,
    );
  }
  return ATLAS_OPERATOR_WORKSPACE_SENTINEL;
}

/** Lead source today is always `"demo"` — `--source` is parameterized
 *  so a future sales-form-leads table can use the same harness. The
 *  normalizer's exhaustive switch is the drift gate. Source of truth
 *  for the CLI's `--source` validator too — derived type prevents the
 *  literal list from drifting between this module and `ops.ts`. */
export const BACKFILL_SOURCES = ["demo"] as const;
export type BackfillSource = (typeof BACKFILL_SOURCES)[number];

export interface BackfillOptions {
  readonly db: BackfillDB;
  /** When true, count + sample only — never writes. */
  readonly dryRun: boolean;
  /** Rows per transaction. Must be ≥ 1. */
  readonly batchSize: number;
  /** Source variant. Today only `"demo"`. */
  readonly source: BackfillSource;
  /**
   * Workspace id stamped on every enqueued row (#2849). The runtime
   * dispatcher uses this to pick between env creds (operator pipeline)
   * and per-tenant DB credentials. For the historic demo_leads
   * back-catalog, every row belongs to Atlas's own operator pipeline,
   * so the caller resolves the operator workspace id (or the sentinel)
   * once and passes it in. Required because crm_outbox.workspace_id
   * is NOT NULL post-0106 — there's no implicit fallback.
   */
  readonly workspaceId: string;
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
 * Why not `(created_at, id)`: JavaScript `Date` is millisecond-
 * precision but Postgres `timestamptz` is microsecond-precision. A
 * cursor value round-tripping through `Date` drops the trailing
 * microseconds, so a bulk-INSERT row batch sharing one `now()`
 * timestamp compares as strictly less than the source rows on the
 * next page and the cursor never advances. UUID-only keyset has no
 * precision loss.
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
 * batch instead of one per row. Positional placeholders
 * (`($1, $2::jsonb, $3), ($4, $5::jsonb, $6), …`) avoid binding the
 * payload JSON through `text[]`: JSON contains `{`, `,`, `"` —
 * characters that collide with Postgres's array-literal syntax and
 * cause silent row-count inflation under driver-side array
 * serialization.
 *
 * `email_key` is the third per-row column (since 0104, #2870) so the
 * historic backfill participates in per-email serialization. Without
 * it, demo_leads rows with duplicate emails would land with NULL
 * email_key, fall into `COALESCE(email_key, id::text)`'s per-id dedup
 * group, and dispatch concurrently — exactly the atlasFirstSource
 * source-swap class of bug the hotfix is designed to prevent.
 */
function buildBulkEnqueueSql(rowCount: number): string {
  const placeholders: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * 4;
    placeholders.push(
      `($${base + 1}, $${base + 2}::jsonb, $${base + 3}, $${base + 4}, 'pending')`,
    );
  }
  return `INSERT INTO crm_outbox (event_type, payload, email_key, workspace_id, status) VALUES ${placeholders.join(", ")} RETURNING id`;
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
  if (options.workspaceId.length === 0) {
    throw new Error(
      "workspaceId is required (crm_outbox.workspace_id is NOT NULL post-0106) — " +
        "resolve operator workspace via SELECT id FROM organization WHERE is_operator_workspace = true",
    );
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

    // Flat `[event_type_0, payload_0, email_key_0, workspace_id_0,
    // event_type_1, …]` so the positional placeholders in
    // `buildBulkEnqueueSql` line up with their VALUES tuples.
    // `extractEmailKey` is shared with the runtime `enqueue` so the
    // bulk path produces identical email_key values for identical
    // payloads (#2870). `workspaceId` is the same value for every row
    // in the batch — historic demo_leads all belong to the operator
    // pipeline (#2849) — but we duplicate it positionally rather than
    // factoring out a single placeholder so a future hetero-tenant
    // backfill (per-workspace `WHERE workspace_id = ...`) drops in
    // without reshaping the SQL builder.
    const params: unknown[] = [];
    for (const row of page.rows) {
      const event = toLeadEvent(row, options.source);
      const normalized = normalizeLead(event);
      // The dispatcher receives the raw event under `payload`, then
      // re-normalizes (see `ee/src/saas-crm/index.ts:dispatchOutboxRow`).
      // Mirroring the runtime path means a normalizer change post-deploy
      // doesn't strand backfilled rows in `payload` shapes the dispatcher
      // can't interpret.
      params.push(
        event.source,
        JSON.stringify(event),
        extractEmailKey({ email: event.email }),
        options.workspaceId,
      );

      if (options.dryRun && sample.length < DRY_RUN_SAMPLE_SIZE) {
        sample.push(normalized);
      }
    }

    if (!options.dryRun) {
      // Each batch is a single multi-row VALUES INSERT — Postgres treats
      // that as one statement, executed atomically without an explicit
      // transaction. We deliberately do NOT wrap with BEGIN/COMMIT: when
      // `db` is a `pg.Pool`, each `.query()` checks out a fresh
      // connection, so `BEGIN` would land on connection A and the INSERT
      // on connection B (auto-committed), producing the illusion of a
      // transaction while silently bypassing it. Single-statement
      // atomicity sidesteps the footgun and is sufficient for the
      // "batch lands whole or not at all" mental model.
      const sql = buildBulkEnqueueSql(page.rows.length);
      const result = await options.db.query<{ id: string }>(sql, params);
      // Guard against future drift: if anyone adds `ON CONFLICT DO
      // NOTHING` to the enqueue SQL, RETURNING would omit skipped rows
      // and stats would silently under-report. Today the two counts are
      // equal by construction — pin it.
      if (result.rows.length !== page.rows.length) {
        throw new Error(
          `crm_outbox enqueue returned ${result.rows.length} of ${page.rows.length} expected rows ` +
            "— likely an ON CONFLICT clause was added without updating the stats accounting",
        );
      }
      enqueued += page.rows.length;
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
  const rawSource = pickFlagString(args, "--source", "demo");
  if (!(BACKFILL_SOURCES as readonly string[]).includes(rawSource)) {
    throw new Error(
      `--source must be one of: ${BACKFILL_SOURCES.join(", ")} (got "${rawSource}")`,
    );
  }
  const source = rawSource as BackfillSource;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[backfill-crm-leads] DATABASE_URL not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const workspaceId = await resolveOperatorWorkspaceIdForBackfill(
      client as unknown as BackfillDB,
    );
    const stats = await runBackfill({
      db: client as unknown as BackfillDB,
      dryRun,
      batchSize,
      source,
      workspaceId,
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
