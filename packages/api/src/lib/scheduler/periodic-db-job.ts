/**
 * periodic-db-job.ts — the shared cycle skeleton for scheduler jobs that walk
 * an internal-DB working set once per tick (#4195).
 *
 * ## Relationship to `registerPeriodicFiber` (arch-win #100 / #4130)
 * These are two composable seams, not competitors:
 *
 *   - `registerPeriodicFiber` (lib/effect/layers.ts) SCHEDULES a fiber: it owns
 *     the interval (`Schedule.spaced` + `forkScoped`), the per-tick span, the
 *     `withFiberDeathLog`, and the enablement gate. It answers *when* a tick runs
 *     and *that* the loop keeps running.
 *   - `runPeriodicDbCycle` (this module) SHAPES one tick *when that tick is a DB
 *     cycle*: guard on an internal DB → scan a bounded working set → apply each
 *     row sequentially (`concurrency: 1`) → tally the outcome → emit the cycle
 *     audit row. It answers *what* one tick does.
 *
 * The two compose: a DB job passes `runPeriodicDbCycle(...)` (via its
 * `run*Cycle` Effect) as the `tick` of a `registerPeriodicFiber` registration.
 * The fiber machinery then lives once in `layers.ts` and the DB-cycle
 * choreography lives once here — where, pre-#4195, `byot-catalog-refresh.ts`
 * and `openapi-install-rediscover.ts` each hand-rolled BOTH.
 *
 * The Tier-1 shared-spec refresh (`openapi-spec-refresh.ts`) is deliberately NOT
 * a caller: it has no internal-DB working set (its cache is process-local), so
 * it schedules through `registerPeriodicFiber` but supplies its own tick body
 * rather than this skeleton — the variance the issue names.
 *
 * ## Fail-soft contract
 * The returned Effect NEVER fails (`E = never`): a scan fault is folded into a
 * `status: "failure"` result (audited), and every per-row fault is caught and
 * counted, so the enclosing fiber's repeat loop can never die on a bad tick.
 * The no-internal-DB path is a zero-count success that still emits the cycle
 * audit row (the "scheduler alive, nothing to do" signal).
 */

import { Effect } from "effect";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import type { createLogger } from "@atlas/api/lib/logger";

type Logger = ReturnType<typeof createLogger>;

/**
 * The minimum shape every DB-cycle result carries. `inspected` is stamped by
 * the skeleton (= scanned row count); each job's own result type extends this
 * with its per-outcome tallies.
 */
export interface PeriodicDbCycleResult {
  status: "success" | "failure";
  inspected: number;
}

export interface PeriodicDbCycleSpec<Row, Outcome, Result extends PeriodicDbCycleResult> {
  /** The job's logger — used for the three cycle log lines below. */
  readonly log: Logger;
  /** Human label prefixing the cycle logs (e.g. "BYOT catalog refresh"). */
  readonly label: string;
  /**
   * A FRESH, zeroed success result (`inspected` 0) on every call — must not
   * return a shared singleton, since the populated path mutates it in place.
   * Used for the no-DB + empty paths, and as the seed for the populated path
   * (`inspected` is then stamped and `tally` accumulates into it).
   *
   * Must be a PURE, non-throwing constructor: unlike `tally`/`emitCycleAudit`,
   * a throw here is NOT guarded and would defect (and kill) the periodic fiber.
   */
  readonly emptyResult: () => Result;
  /**
   * A zeroed failure result carrying the scan error (`status: "failure"`).
   * Must be a PURE, non-throwing constructor (see `emptyResult`).
   */
  readonly failureResult: (error: string) => Result;
  /**
   * Bounded scan of the working set. Only invoked when an internal DB is
   * present; a rejection is caught and folded into a failure result.
   */
  readonly scan: () => Promise<readonly Row[]>;
  /** Apply one row. May reject; an unexpected rejection maps via `defectOutcome`. */
  readonly applyRow: (row: Row) => Promise<Outcome>;
  /**
   * Map an unexpected per-row rejection to a terminal outcome (belt-and-braces).
   * Must be a PURE, non-throwing mapper (it runs eagerly inside `Effect.succeed`,
   * so a throw here is NOT guarded and would defect the fiber — see `emptyResult`).
   */
  readonly defectOutcome: (error: string) => Outcome;
  /**
   * Fold one row's outcome into `result` and emit its per-row audit. Mutates
   * `result` in place — this is where each job's per-outcome tally + backoff /
   * drift bookkeeping lives.
   */
  readonly tally: (result: Result, row: Row, outcome: Outcome) => void;
  /** Emit the cycle-level audit row. Fires on EVERY terminal path (no-DB, scan-fail, empty, done). */
  readonly emitCycleAudit: (result: Result) => void;
}

/**
 * Run a single periodic DB cycle. See the module docstring for the contract.
 * Never throws / never fails — the result is always returned and always
 * audited.
 */
export const runPeriodicDbCycle = <Row, Outcome, Result extends PeriodicDbCycleResult>(
  spec: PeriodicDbCycleSpec<Row, Outcome, Result>,
): Effect.Effect<Result> =>
  Effect.gen(function* () {
    // The synchronous spec callbacks (`tally`, `emitCycleAudit`) run OUTSIDE the
    // `Effect.tryPromise` boundaries, so a throw in one would be an Effect DEFECT
    // — and `registerPeriodicFiber` recovers typed failures, NOT defects, so such
    // a throw would kill the periodic fiber permanently (pre-#4195 the
    // `Effect.runPromise(...).catch()` driver logged it and the loop survived).
    // Guard them here so the fail-soft contract holds structurally: a stray throw
    // degrades to a logged error and the loop lives on. Both callers already
    // guard their emitters internally; this is belt-and-braces at the seam.
    const emitAudit = (r: Result): void => {
      try {
        spec.emitCycleAudit(r);
      } catch (err) {
        spec.log.error(
          { err: errorMessage(err) },
          `${spec.label}: cycle audit emission threw`,
        );
      }
    };

    if (!hasInternalDB()) {
      const result = spec.emptyResult();
      emitAudit(result);
      return result;
    }

    const fetchResult = yield* Effect.tryPromise({
      try: spec.scan,
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.map((rows) => ({ ok: true as const, rows })),
      Effect.catchAll((err) => {
        spec.log.error(
          { err: errorMessage(err) },
          `${spec.label}: failed to query the working set`,
        );
        return Effect.succeed({ ok: false as const, error: errorMessage(err) });
      }),
    );

    if (!fetchResult.ok) {
      const failed = spec.failureResult(fetchResult.error);
      emitAudit(failed);
      return failed;
    }

    const rows = fetchResult.rows;
    const result = spec.emptyResult();
    result.inspected = rows.length;

    if (rows.length === 0) {
      emitAudit(result);
      return result;
    }

    spec.log.info({ count: rows.length }, `${spec.label}: cycle starting`);

    // Sequential — one row at a time (`concurrency: 1`), so a noisy row can't
    // fan out egress and a fiber interrupt cancels cleanly mid-cycle. Each
    // per-row apply is wrapped so a surprise rejection counts as a failure
    // rather than aborting the loop.
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.tryPromise({
            try: () => spec.applyRow(row),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => Effect.succeed(spec.defectOutcome(errorMessage(err)))),
          );
          try {
            spec.tally(result, row, outcome);
          } catch (err) {
            // A tally throw would defect the fiber (see `emitAudit` note above).
            // Log + skip the row so one bad row can't stop the loop.
            spec.log.error(
              { err: errorMessage(err) },
              `${spec.label}: tally threw for a row — skipping it`,
            );
          }
        }),
      { concurrency: 1 },
    );

    // Cast for pino's `LogFn`: spreading the generic `Result` leaves its
    // `extends string ? never` guard unresolved (a generic spread is not
    // provably `Record<string, unknown>`), so pin it to a plain record.
    spec.log.info({ ...result } as Record<string, unknown>, `${spec.label}: cycle complete`);
    emitAudit(result);
    return result;
  });
