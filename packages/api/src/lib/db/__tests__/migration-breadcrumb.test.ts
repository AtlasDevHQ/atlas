/**
 * Unit fixtures for the `runMigrations` phase breadcrumb (#5430).
 *
 * ⚠️ THE CLAIM UNDER TEST IS THAT IT REPORTS BEFORE THE PHASE ENDS. That is the
 * entire reason the module exists — a hook killed at 60,000ms never returns from
 * the call holding the budget, so anything logged on completion is exactly the
 * line the failing run does not produce. So the central fixture opens a phase,
 * never closes it, fires the timer, and asserts a line naming that phase came
 * out anyway. Every other fixture here is secondary to that one.
 *
 * The clock, the timer and the output stream are injected, so none of this waits
 * on real time.
 */

import { describe, expect, test } from "bun:test";
import {
  BREADCRUMB_TICK_MS,
  DISARMED_BREADCRUMB,
  armBreadcrumb,
  breadcrumbArmed,
  type BreadcrumbDeps,
} from "@atlas/api/lib/db/migration-breadcrumb";

/** A controllable clock + timer + sink, so the fixtures are deterministic. */
function harness(): {
  deps: BreadcrumbDeps;
  lines: string[];
  advanceTo: (ms: number) => void;
  tick: () => void;
  cleared: () => boolean;
} {
  let clock = 0;
  const lines: string[] = [];
  let fired: (() => void) | null = null;
  let cleared = false;
  const deps: BreadcrumbDeps = {
    now: () => clock,
    uptimeMs: () => 1_000 + clock,
    write: (line) => void lines.push(line),
    setInterval: (fn) => {
      fired = fn;
      return "handle";
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  return {
    deps,
    lines,
    advanceTo: (ms) => {
      clock = ms;
    },
    tick: () => fired?.(),
    cleared: () => cleared,
  };
}

describe("breadcrumbArmed", () => {
  // ⚠️ The default matters more than the overrides. #5430's history is an
  // instrument that was switched on AFTER the failure was seen, by which point
  // it had decayed to zero and would not come back. Armed-by-default wherever
  // the failure lives is the correction, so this is the fixture that would go
  // red if someone made it opt-in "to reduce noise".
  test("is ARMED by default whenever TEST_DATABASE_URL is set", () => {
    expect(breadcrumbArmed({ TEST_DATABASE_URL: "postgresql://x" })).toBe(true);
  });

  test("is disarmed with no TEST_DATABASE_URL — production never pays for it", () => {
    expect(breadcrumbArmed({})).toBe(false);
  });

  test("`=1` forces it on for a deliberate reproduction off a test database", () => {
    expect(breadcrumbArmed({ ATLAS_MIGRATION_BREADCRUMB: "1" })).toBe(true);
  });

  test("`=0` wins over TEST_DATABASE_URL", () => {
    expect(breadcrumbArmed({ ATLAS_MIGRATION_BREADCRUMB: "0", TEST_DATABASE_URL: "x" })).toBe(false);
  });
});

describe("armBreadcrumb", () => {
  // ⚠️ THE ONE THAT MATTERS. The phase is never closed and `finish` is never
  // called — the shape of a hook that timed out.
  test("reports an OPEN phase from the timer, without the phase ever completing", () => {
    const h = harness();
    const b = armBreadcrumb("schema=durmem_1", h.deps);
    b.enter("apply");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();

    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("STILL IN apply");
    expect(h.lines[0]).toContain("schema=durmem_1");
    expect(h.lines[0]).toContain(`total_ms=${BREADCRUMB_TICK_MS}`);
  });

  test("names the phase that is open NOW, not the one that was open at arming", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("pool.connect");
    b.enter("advisory-lock");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    expect(h.lines[0]).toContain("STILL IN advisory-lock");
    expect(h.lines[0]).not.toContain("pool.connect");
  });

  // The phase clock restarts per phase, so a 55s `apply` after a 5s connect
  // reads as `phase_ms≈55000 total_ms≈60000` rather than one indistinct 60s.
  test("phase_ms is per-phase while total_ms is per-run", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("pool.connect");
    h.advanceTo(5_000);
    b.enter("apply");
    h.advanceTo(60_000);
    h.tick();
    expect(h.lines[0]).toContain("phase_ms=55000");
    expect(h.lines[0]).toContain("total_ms=60000");
  });

  // ⚠️ Drift is the fixture that keeps the module's central claim honest: it is
  // what separates "blocked on Postgres" from "not scheduled at all", and the
  // five refutations in #5430 left exactly that distinction open. A tick that
  // lands on schedule means the event loop was free, so the wait was in the
  // database.
  test("drift_ms is ~0 when the tick lands on schedule — the loop was free", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    expect(h.lines[0]).toContain("drift_ms=0");
  });

  test("drift_ms grows when the timer itself is late — CPU starvation", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    // Scheduled for 10s, actually ran at 24s.
    h.advanceTo(24_000);
    h.tick();
    expect(h.lines[0]).toContain(`drift_ms=${24_000 - BREADCRUMB_TICK_MS}`);
  });

  test("uptime at ENTRY is reported, so the pre-runMigrations half is derivable", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    // The harness starts uptime at 1000ms and `armBreadcrumb` samples it once,
    // at construction — so a later clock advance must NOT move it.
    expect(h.lines[0]).toContain("uptime_at_entry_ms=1000");
  });

  test("a FAST run emits nothing at all — 87 routine lines is what gets an instrument deleted", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(4_000);
    b.finish(190);
    expect(h.lines).toEqual([]);
    expect(h.cleared()).toBe(true);
  });

  test("a run that TICKED summarises, so the trail has an end", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    h.advanceTo(12_000);
    b.finish(190);
    expect(h.lines[1]).toContain("done total_ms=12000");
    expect(h.lines[1]).toContain("applied=190");
    expect(h.lines[1]).toContain("ticks=1");
  });

  // A migration that FAILS at 50s and one that HANGS are different stories, and
  // the ticks alone read identically up to the point they stop.
  test("a FAILED run summarises even when it was fast", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(400);
    b.finish(null, new Error("relation does not exist"));
    expect(h.lines[0]).toContain("FAILED err=relation does not exist");
  });

  test("the timer is cleared on finish, and a second finish is a no-op", () => {
    const h = harness();
    const b = armBreadcrumb("schema=x", h.deps);
    b.enter("apply");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    b.finish(1);
    const after = h.lines.length;
    b.finish(1);
    h.tick();
    expect(h.lines).toHaveLength(after);
  });

  // ⚠️ A LEAKED WATCHDOG IS SILENT UNTIL IT IS LOUD, which is why this is a
  // fixture rather than a comment. `runMigrations` covers every phase after
  // `pool.connect()` with a `finally` that calls `finish()`; the connect itself
  // sits outside it, and a REJECTING connect is exactly the exhausted-pool case
  // this instrument was built for. Unfinished, the interval is never cleared and
  // prints `STILL IN pool.connect` every 10s for the rest of the process — once
  // per failed call. `unref` keeps it from holding the process open, so the leak
  // is quiet, and quiet is what lets it survive review.
  test("finish() after a FAILED phase clears the timer — no orphaned watchdog", () => {
    const h = harness();
    const b = armBreadcrumb("schema=?", h.deps);
    b.enter("pool.connect");
    h.advanceTo(BREADCRUMB_TICK_MS);
    h.tick();
    b.finish(null, new Error("timeout exceeded when trying to connect"));
    expect(h.cleared()).toBe(true);
    const after = h.lines.length;
    // The tick that would have fired ten seconds later must produce nothing.
    h.advanceTo(2 * BREADCRUMB_TICK_MS);
    h.tick();
    expect(h.lines).toHaveLength(after);
  });

  test("DISARMED_BREADCRUMB accepts the same calls and writes nothing", () => {
    expect(() => {
      DISARMED_BREADCRUMB.enter("apply");
      DISARMED_BREADCRUMB.finish(0);
    }).not.toThrow();
  });
});
