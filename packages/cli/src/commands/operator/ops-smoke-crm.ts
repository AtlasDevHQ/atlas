/**
 * `atlas-operator ops smoke-crm` — automated CRM lead-capture verification.
 *
 * Mechanizes the 10-persona manual repro from PR #2865's comment thread:
 * inject leads BELOW the form/Turnstile layer via `enqueue`, wait for the
 * flusher to drain, then assert against Twenty REST that the resulting
 * Persons + Notes match what the fixture declared.
 *
 * Scope (per issue #2866):
 *   - Below Turnstile only — no form-layer scripting (manual A5/A6).
 *   - Live-network: talks to a real Twenty workspace. NOT part of per-PR CI,
 *     but it IS run automatically as the post-deploy Staging Smoke gate
 *     (`.github/workflows/staging-smoke.yml`, added in staging slice #2898)
 *     against the staging DB + Twenty — and ad-hoc by an operator locally.
 *   - Unit tests cover fixture parsing + diff reporting; the live Twenty
 *     round-trip and the inline `/rest/noteTargets` join run only against a
 *     real workspace (local invocation or the staging-smoke job).
 *
 * Flow:
 *   1. Parse args + fixture.
 *   2. Optional wipe (--wipe-twenty + ATLAS_SMOKE_WIPE_OK=1 double-confirm).
 *   3. Enqueue each persona via `enqueue` from @atlas/api/lib/lead-outbox.
 *   4. Poll crm_outbox by the enqueued IDs until all reach done/dead, bound
 *      by --timeout-seconds.
 *   5. List Twenty → build observed state → diff against expected → exit.
 */
import { enqueue } from "@atlas/api/lib/lead-outbox/outbox";

import { getFlag } from "../../../lib/cli-utils";
import { loadFixture, FixtureParseError } from "../../../lib/smoke-crm/fixture";
import {
  buildExpectedState,
  computeDiff,
  formatDiff,
  isClean,
  type ObservedNote,
  type ObservedPerson,
  type ObservedState,
} from "../../../lib/smoke-crm/diff";
import { createTwentyAdmin } from "../../../lib/smoke-crm/twenty-admin";
import type { LeadEvent } from "@useatlas/twenty/lead-normalizer";

const DEFAULT_TIMEOUT_SECONDS = 60;
const POLL_INTERVAL_MS = 1_000;

/** Args block — kept as a struct so unit tests can construct one without `process.argv` cosplay. */
export interface SmokeCrmArgs {
  readonly personasPath: string;
  readonly wipeTwenty: boolean;
  readonly twentyBaseUrl: string;
  readonly twentyApiKey: string;
  readonly timeoutSeconds: number;
  readonly databaseUrl: string;
}

/**
 * Exit codes — pinned so chained scripts can branch on the failure mode:
 *   0  clean
 *   1  argument / fixture / parse error (USAGE — operator fixable on the CLI line)
 *   2  outbox drain timed out
 *   3  diff dirty (dispatcher misbehaved or Twenty wasn't reachable)
 *   4  wipe phase failed (operator data corruption guard)
 *   5  infrastructure failure — tenant DB unreachable, enqueue INSERT failed,
 *      or poll query errored. Distinct from USAGE so chained scripts don't
 *      treat "Postgres is down" the same as "bad argv".
 */
export const SMOKE_EXIT = {
  OK: 0,
  USAGE: 1,
  TIMEOUT: 2,
  DIFF: 3,
  WIPE_FAIL: 4,
  INFRA: 5,
} as const;

// ─────────────────────────────────────────────────────────────────────
//  Arg parsing (unit-tested in isolation)
// ─────────────────────────────────────────────────────────────────────

function parsePositiveInt(raw: string, flag: string): number | { error: string } {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return { error: `${flag} must be a positive integer (got "${raw}")` };
  return n;
}

/**
 * Parse the CLI args. Returns either the struct or an actionable error
 * string. Pure — never touches `process.env` directly (caller passes env).
 *
 * Required:
 *   --personas <path>
 * Optional with sane defaults from `env`:
 *   --twenty-base-url     | TWENTY_BASE_URL          | https://api.twenty.com
 *   --twenty-api-key      | TWENTY_API_KEY           | (required if not in env)
 *   --database-url        | ATLAS_TEAM_PG_URL | DATABASE_URL (required if not in env)
 *   --timeout-seconds N   | (default 60)
 *   --wipe-twenty         (boolean — needs ATLAS_SMOKE_WIPE_OK=1)
 */
export function parseSmokeCrmArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): SmokeCrmArgs | { error: string } {
  const personasPath = getFlag(args, "--personas");
  if (!personasPath) {
    return { error: "--personas <path> is required" };
  }
  const wipeTwenty = args.includes("--wipe-twenty");
  const twentyBaseUrl =
    getFlag(args, "--twenty-base-url") ??
    env.TWENTY_BASE_URL ??
    "https://api.twenty.com";
  const twentyApiKey = getFlag(args, "--twenty-api-key") ?? env.TWENTY_API_KEY ?? "";
  if (!twentyApiKey) {
    return {
      error:
        "Twenty API key is required: pass --twenty-api-key or set TWENTY_API_KEY in the env",
    };
  }
  const databaseUrl =
    getFlag(args, "--database-url") ??
    env.ATLAS_TEAM_PG_URL ??
    env.DATABASE_URL ??
    "";
  if (!databaseUrl) {
    return {
      error:
        "Tenant DB URL is required: pass --database-url or set ATLAS_TEAM_PG_URL / DATABASE_URL",
    };
  }
  const timeoutRaw = getFlag(args, "--timeout-seconds");
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (timeoutRaw !== undefined) {
    const parsed = parsePositiveInt(timeoutRaw, "--timeout-seconds");
    if (typeof parsed === "object") return parsed;
    timeoutSeconds = parsed;
  }
  return {
    personasPath,
    wipeTwenty,
    twentyBaseUrl,
    twentyApiKey,
    timeoutSeconds,
    databaseUrl,
  };
}

/**
 * Double-confirm gate for the destructive wipe phase. Mirrors the
 * `checkWipeGate` rule in ops.ts: requires BOTH `ATLAS_SMOKE_WIPE_OK=1`
 * in the env AND `--wipe-twenty` on the command line. Returns null when
 * cleared, otherwise an actionable string.
 *
 * This gate fires ONLY when `--wipe-twenty` was passed. A smoke run
 * without the flag skips the wipe phase entirely and bypasses this check.
 */
export function checkSmokeWipeGate(
  args: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  if (!args.includes("--wipe-twenty")) return null;
  if (env.ATLAS_SMOKE_WIPE_OK !== "1") {
    return "Refusing to wipe Twenty: set ATLAS_SMOKE_WIPE_OK=1 in the env to confirm.";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  Outbox polling (unit-testable — depends only on the OutboxDB shape)
// ─────────────────────────────────────────────────────────────────────

/** Minimal db surface this command needs — matches `OutboxDB` plus the poll SELECT. */
export interface SmokeCrmDB {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

interface OutboxPollRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: "pending" | "in_flight" | "done" | "dead";
  readonly last_error: string | null;
}

/**
 * Result of `pollOutboxUntilDrained`. `statuses` carries the latest status
 * for every id THE DB returned a row for; ids never seen in any poll
 * response land in `missingFromDb` instead — silently dropping those
 * would let an out-of-band TRUNCATE / DELETE corrupt the smoke report
 * (the timeout would print only "the rows that survived" and the gap
 * would not be visible to the operator).
 */
export interface PollResult {
  readonly statuses: ReadonlyMap<string, "done" | "dead" | "pending" | "in_flight">;
  readonly missingFromDb: ReadonlyArray<string>;
  readonly deadErrors: ReadonlyArray<{ id: string; error: string }>;
  readonly timedOut: boolean;
}

/**
 * Poll `crm_outbox` for the given ids until every row reaches a terminal
 * state (`done` or `dead`) or the timeout is hit. Empty `ids` returns
 * immediately — the caller might be running a no-personas dry-run.
 */
export async function pollOutboxUntilDrained(
  db: SmokeCrmDB,
  ids: ReadonlyArray<string>,
  timeoutSeconds: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = () => Date.now(),
): Promise<PollResult> {
  if (ids.length === 0) {
    return {
      statuses: new Map(),
      missingFromDb: [],
      deadErrors: [],
      timedOut: false,
    };
  }
  const deadline = now() + timeoutSeconds * 1_000;
  while (true) {
    const rows = await db.query<OutboxPollRow>(
      `SELECT id, status, last_error FROM crm_outbox WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const statuses = new Map<string, OutboxPollRow["status"]>();
    for (const r of rows) statuses.set(r.id, r.status);
    const deadErrors: { id: string; error: string }[] = [];
    let allDone = true;
    for (const id of ids) {
      const s = statuses.get(id);
      if (!s || s === "pending" || s === "in_flight") {
        allDone = false;
        continue;
      }
      if (s === "dead") {
        deadErrors.push({
          id,
          error: rows.find((r) => r.id === id)?.last_error ?? "(no last_error recorded)",
        });
      }
    }
    const missingFromDb = ids.filter((id) => !statuses.has(id));
    if (allDone) {
      return { statuses, missingFromDb, deadErrors, timedOut: false };
    }
    if (now() >= deadline) {
      return { statuses, missingFromDb, deadErrors, timedOut: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Handler — wires it all together
// ─────────────────────────────────────────────────────────────────────

/**
 * Top-level CLI entry point. Exit codes use `SMOKE_EXIT`. Catches every
 * known failure shape and prints an actionable message; an unhandled
 * defect bubbles out to bin/atlas-operator.ts's top-level catch.
 *
 * Uses `process.exitCode = X; return;` rather than `process.exit(X)` so
 * the `finally` block runs and the pg client is cleanly closed even on
 * error paths.
 */
export async function handleOpsSmokeCrm(args: string[]): Promise<void> {
  const parsed = parseSmokeCrmArgs(args, process.env);
  if ("error" in parsed) {
    console.error(`[ops:smoke-crm] ${parsed.error}`);
    process.exitCode = SMOKE_EXIT.USAGE;
    return;
  }
  const gateError = checkSmokeWipeGate(args, process.env);
  if (gateError) {
    console.error(`[ops:smoke-crm] ${gateError}`);
    process.exitCode = SMOKE_EXIT.USAGE;
    return;
  }

  let events: LeadEvent[];
  try {
    events = loadFixture(parsed.personasPath);
  } catch (err) {
    if (err instanceof FixtureParseError) {
      console.error(`[ops:smoke-crm] fixture error: ${err.message}`);
      process.exitCode = SMOKE_EXIT.USAGE;
      return;
    }
    throw err;
  }
  console.log(
    `[ops:smoke-crm] loaded ${events.length} persona(s) from ${parsed.personasPath}`,
  );

  const admin = createTwentyAdmin({
    baseUrl: parsed.twentyBaseUrl,
    apiKey: parsed.twentyApiKey,
  });

  if (parsed.wipeTwenty) {
    try {
      const result = await admin.wipeWorkspace({ dryRun: false });
      if (result.dryRun) {
        // Defensive — we asked for dryRun=false. If the underlying client
        // returns the dry-run shape anyway, the wipe didn't run.
        console.error(
          `[ops:smoke-crm] wipe returned dry-run result despite dryRun=false — refusing to proceed`,
        );
        process.exitCode = SMOKE_EXIT.WIPE_FAIL;
        return;
      }
      const truncated =
        result.truncated.notes || result.truncated.people || result.truncated.companies
          ? ` (truncated: notes=${result.truncated.notes} people=${result.truncated.people} companies=${result.truncated.companies})`
          : "";
      console.log(
        `[ops:smoke-crm] wiped Twenty workspace — notes=${result.notesDeleted} ` +
          `people=${result.peopleDeleted} companies=${result.companiesDeleted}${truncated}`,
      );
      if (result.errors.length > 0) {
        // Per-record delete failures surface to the operator but don't abort —
        // the post-wipe strict-clean diff (see computeDiff call below) catches
        // any residual rows that actually matter for the smoke result.
        console.warn(
          `[ops:smoke-crm] wipe completed with ${result.errors.length} per-record error(s)`,
        );
        for (const e of result.errors) {
          console.warn(`  - ${e.objectType} ${e.id} (HTTP ${e.status}): ${e.message}`);
        }
      }
    } catch (err) {
      console.error(
        `[ops:smoke-crm] wipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = SMOKE_EXIT.WIPE_FAIL;
      return;
    }
  }

  // Connect to the tenant DB for the enqueue + poll phases. The connect
  // itself can fail (DB down, wrong URL) — surface that as INFRA, not as
  // an unhandled rejection at the top of bin/atlas-operator.ts.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: parsed.databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `[ops:smoke-crm] tenant DB connect failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = SMOKE_EXIT.INFRA;
    return;
  }
  try {
    const db: SmokeCrmDB = {
      async query<T extends Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<T[]> {
        const r = await client.query(sql, params);
        return r.rows as T[];
      },
    };

    // Smoke-test rows route through the operator pipeline — every
    // persona is part of Atlas's own lead-capture flow, just executed
    // via CLI for end-to-end verification (#2849). Resolve the operator
    // workspace_id from the same tenant DB the dispatcher will read at
    // claim time so the dispatcher's per-row routing key matches what
    // the production enqueue path would have stamped on a real demo
    // /signup. Falls back to the sentinel when the lookup yields nothing
    // (CI fixture / fresh region with no operator org backfilled).
    const operatorWorkspaceIdResolver = await import(
      "@atlas/api/lib/db/migrations/scripts/backfill-crm-leads"
    );
    const operatorWorkspaceId =
      await operatorWorkspaceIdResolver.resolveOperatorWorkspaceIdForBackfill({
        async query<T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<{ rows: T[] }> {
          const r = await client.query(sql, params);
          return { rows: r.rows as T[] };
        },
      });
    const enqueuedIds: string[] = [];
    try {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const id = await enqueue(db, {
          eventType: event.source,
          payload: event as unknown as Record<string, unknown>,
          workspaceId: operatorWorkspaceId,
        });
        enqueuedIds.push(id);
      }
    } catch (err) {
      // Persona-N attribution matters here — `crm_outbox` schema breakage
      // or pg pool failure is invisible without knowing how far we got.
      console.error(
        `[ops:smoke-crm] enqueue failed at persona ${enqueuedIds.length + 1}/${events.length}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = SMOKE_EXIT.INFRA;
      return;
    }
    console.log(
      `[ops:smoke-crm] enqueued ${enqueuedIds.length} outbox row(s) — waiting up to ${parsed.timeoutSeconds}s for the flusher to drain`,
    );

    let drainResult;
    try {
      drainResult = await pollOutboxUntilDrained(
        db,
        enqueuedIds,
        parsed.timeoutSeconds,
      );
    } catch (err) {
      console.error(
        `[ops:smoke-crm] outbox poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = SMOKE_EXIT.INFRA;
      return;
    }
    if (drainResult.timedOut) {
      const statusList = [...drainResult.statuses.entries()]
        .map(([id, s]) => `${id.slice(0, 8)}=${s}`)
        .join(", ");
      const missingList =
        drainResult.missingFromDb.length > 0
          ? ` missing-from-db=[${drainResult.missingFromDb
              .map((id) => id.slice(0, 8))
              .join(", ")}]`
          : "";
      console.error(
        `[ops:smoke-crm] timed out waiting for crm_outbox to drain — final statuses: ${statusList}${missingList}`,
      );
      process.exitCode = SMOKE_EXIT.TIMEOUT;
      return;
    }
    if (drainResult.deadErrors.length > 0) {
      console.error(
        `[ops:smoke-crm] ${drainResult.deadErrors.length} row(s) dead-lettered before assertion:`,
      );
      for (const d of drainResult.deadErrors) {
        console.error(`  - ${d.id}: ${d.error}`);
      }
      // Still continue to the diff phase — the dead rows will surface as
      // missing Persons / Notes, which is the more useful diagnostic.
    } else {
      console.log(`[ops:smoke-crm] all ${enqueuedIds.length} row(s) reached status=done`);
    }

    // Assertion phase: read Twenty and diff.
    let observed: ObservedState;
    try {
      const persons: ObservedPerson[] = await admin.listAllPeople();
      const notes: ObservedNote[] = await admin.listAllNotes();
      observed = { persons, notes };
    } catch (err) {
      console.error(
        `[ops:smoke-crm] failed to list Twenty workspace: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = SMOKE_EXIT.DIFF;
      return;
    }

    const expected = buildExpectedState(events);
    // Strict mode when --wipe-twenty is set: a wiped workspace should be
    // deterministic afterwards, so residual rows / duplicates flip from
    // informational to dirty. Closes Codex P2-A.
    const diff = computeDiff(expected, observed, {
      requireCleanWorkspace: parsed.wipeTwenty,
    });
    const totals = {
      expectedPersons: expected.persons.length,
      observedPersons: observed.persons.length,
      expectedNotes: expected.notes.length,
      observedNotes: observed.notes.length,
    };
    const report = formatDiff(diff, { totals });
    if (isClean(diff)) {
      console.log(report);
      process.exitCode = SMOKE_EXIT.OK;
      return;
    }
    console.error(report);
    process.exitCode = SMOKE_EXIT.DIFF;
    return;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[ops:smoke-crm] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}
