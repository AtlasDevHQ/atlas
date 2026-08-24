/**
 * A phase breadcrumb for `runMigrations`, armed in test runs (#5430).
 *
 * ## Why this exists, and why it is not a `log.info` at the end
 *
 * 87 `*-pg.test.ts` suites each open a scratch schema and apply 190 of 208
 * migrations in `beforeAll`. That is ~5.2s of a ~7s suite and by far the largest
 * thing any hook does. Under load some of those hooks stop at exactly 60,000ms —
 * 55 of them on one run, then 15, then 0, 0, 0 across identical re-runs of an
 * unchanged tree.
 *
 * #5410 measured five hypotheses and refuted every one (connection cap: 43 of
 * 300; catalog bloat: present during the GREEN runs; cold cache: 0 failures
 * immediately after a restart; advisory-lock serialization: 87 concurrent runs
 * take 87 distinct keys; `max_locks_per_transaction`: green at stock 64 at 8, 16
 * and 32 workers). What it could NOT establish is where the 60s actually goes,
 * because by the time anything was instrumented the failure had decayed to zero
 * and would not come back.
 *
 * ## The trap this module is shaped around
 *
 * ⚠️ **A breadcrumb that prints when the phase COMPLETES can never appear in a
 * run that timed out.** That is the whole difficulty. If the hook is killed at
 * 60,000ms the awaited call never returns, so an "elapsed Nms" line written
 * after it is precisely the line you do not get, in precisely the run you need
 * it from. Every obvious spelling of this instrument is useless against the
 * failure it is for.
 *
 * So the report is driven by a TIMER, not by completion: while a phase is in
 * flight, a watchdog prints which phase is still open and how long it has been
 * open. A timed-out hook then leaves a trail naming the call that was holding
 * the budget at the moment it ran out.
 *
 * ## The timer's own lateness is a measurement
 *
 * Each tick prints `drift` — scheduled versus actual firing. A phase blocked on
 * Postgres leaves the event loop free, so the tick lands on time and drift is a
 * few ms. A process starved of CPU cannot run its own timer either, so drift
 * grows with the delay. That single number separates "waiting on the database"
 * from "not being scheduled", which is the distinction the five refutations left
 * open — and it costs nothing to collect.
 *
 * ## Output goes to stderr, not through the logger
 *
 * `ATLAS_LOG_LEVEL=fatal` is normal for a test sweep, and an instrument that a
 * routine env var silences is not armed. `process.stderr.write` has no level.
 */

/** One phase of `runMigrations`, in the order they run. */
export type MigrationPhase = "pool.connect" | "advisory-lock" | "apply" | "advisory-unlock";

/** Injected in tests; defaults to the real clock/timer/stream in `arm()`. */
export interface BreadcrumbDeps {
  readonly now: () => number;
  readonly uptimeMs: () => number;
  readonly write: (line: string) => void;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface MigrationBreadcrumb {
  /** Open a phase. Closes the previous one; the tick names whichever is open. */
  readonly enter: (phase: MigrationPhase) => void;
  /**
   * Rename the run once its identity is known.
   *
   * ⚠️ This is what makes the instrument attributable across all 87 `-pg`
   * suites WITHOUT touching a single `beforeAll`. The name that matters is the
   * scratch schema, and nothing knows it until a connection exists to ask
   * `current_schema()` — but the breadcrumb must already be armed by then,
   * because `pool.connect()` is itself one of the phases that can block. So it
   * arms unlabelled and is renamed a moment later. Editing 87 call sites to pass
   * a label would have been 87 chances to miss one, on exactly the suites where
   * a missing line reads as "this one was fine".
   */
  readonly relabel: (label: string) => void;
  /** Close the run and emit the summary. Safe to call more than once. */
  readonly finish: (applied: number | null, err?: unknown) => void;
}

/**
 * How often the watchdog reports an in-flight phase.
 *
 * 10s divides the 30s hook budget most suites use and the 60s the failures land
 * on, so a timed-out hook leaves several ticks rather than one — and the SHAPE
 * of the sequence (steady 10s steps versus widening ones) is what carries the
 * starvation signal.
 */
export const BREADCRUMB_TICK_MS = 10_000;

/**
 * Whether to arm, decided per call rather than at import.
 *
 * ⚠️ Default ON whenever `TEST_DATABASE_URL` is set, which is the ONE thing
 * #5430 insists on: a failure that decays across re-runs cannot be instrumented
 * after it is seen, so an instrument that must be switched on by someone who
 * already suspects the answer will never be on for the run that mattered. That
 * env var is set for test sweeps and absent in production, so this arms exactly
 * where the failure lives and nowhere else.
 *
 * `ATLAS_MIGRATION_BREADCRUMB=1` forces it on (for a deliberate reproduction
 * against a non-test database), `=0` forces it off.
 */
export function breadcrumbArmed(env: Record<string, string | undefined>): boolean {
  if (env.ATLAS_MIGRATION_BREADCRUMB === "1") return true;
  if (env.ATLAS_MIGRATION_BREADCRUMB === "0") return false;
  return env.TEST_DATABASE_URL !== undefined;
}

/** A no-op breadcrumb, so callers need no conditional around every `enter`. */
export const DISARMED_BREADCRUMB: MigrationBreadcrumb = {
  enter: () => {},
  relabel: () => {},
  finish: () => {},
};

/**
 * Arm a breadcrumb for one `runMigrations` call.
 *
 * `label` should identify the caller — the scratch schema name is what makes 87
 * concurrent lines tellable apart, and it is also the advisory lock's key, so a
 * lock-contention reading needs it present.
 */
export function armBreadcrumb(
  label: string,
  deps: Partial<BreadcrumbDeps> = {},
): MigrationBreadcrumb {
  const now = deps.now ?? (() => performance.now());
  const uptimeMs = deps.uptimeMs ?? (() => process.uptime() * 1000);
  const write = deps.write ?? ((line: string) => void process.stderr.write(line));
  const setIntervalFn =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      // ⚠️ `unref` or this timer keeps the process alive past the last test.
      // `setInterval` returns a Timeout in Node/Bun and a number in the DOM
      // lib, so the shape is checked rather than asserted.
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref: () => void }).unref();
      }
      return handle;
    });
  const clearIntervalFn = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as never));

  const t0 = now();
  // Everything before this call — constructing the pool, `CREATE SCHEMA` — is
  // the OTHER half of the hook, and it is exactly what a `runMigrations`-only
  // instrument would hide. Reporting uptime at entry makes that half derivable
  // without touching 87 `beforeAll` blocks to time it directly.
  const uptimeAtEntry = Math.round(uptimeMs());

  let phase: MigrationPhase | null = null;
  let phaseStart = t0;
  let ticks = 0;
  let finished = false;
  let name = label;

  const line = (body: string): void => {
    write(`[migrate-breadcrumb] ${name} ${body}\n`);
  };

  const expectedTickAt = (n: number): number => t0 + n * BREADCRUMB_TICK_MS;

  const handle = setIntervalFn(() => {
    if (finished) return;
    ticks += 1;
    const t = now();
    // Scheduled-versus-actual. Small under a database wait, large under CPU
    // starvation — see this module's header.
    const drift = Math.round(t - expectedTickAt(ticks));
    line(
      `STILL IN ${phase ?? "(no phase entered)"} ` +
        `phase_ms=${Math.round(t - phaseStart)} total_ms=${Math.round(t - t0)} ` +
        `tick=${ticks} drift_ms=${drift} uptime_at_entry_ms=${uptimeAtEntry}`,
    );
  }, BREADCRUMB_TICK_MS);

  return {
    enter: (next: MigrationPhase): void => {
      if (finished) return;
      phase = next;
      phaseStart = now();
    },
    relabel: (next: string): void => {
      name = next;
    },
    finish: (applied: number | null, err?: unknown): void => {
      if (finished) return;
      finished = true;
      clearIntervalFn(handle);
      // Only summarise a run that was SLOW enough to be interesting or that
      // failed. A green sweep is 87 suites; 87 routine lines would be the noise
      // that gets the whole instrument deleted, and the ticks above are what
      // carry the failing case.
      const total = Math.round(now() - t0);
      if (err === undefined && ticks === 0) return;
      const outcome =
        err === undefined
          ? `applied=${applied ?? "?"}`
          : `FAILED err=${err instanceof Error ? err.message : String(err)}`;
      line(
        `done total_ms=${total} last_phase=${phase ?? "(none)"} ` +
          `ticks=${ticks} uptime_at_entry_ms=${uptimeAtEntry} ${outcome}`,
      );
    },
  };
}
