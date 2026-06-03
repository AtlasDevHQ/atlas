/**
 * Edge-trigger doorbell for the CRM outbox flusher (#2874).
 *
 * The `FlusherSignal` bridges the request-path `enqueue` (which wants to
 * wake the flusher the instant a row lands) and the flusher fiber (which
 * otherwise sits on a 5-min backstop). These tests pin the lost-wakeup
 * latch, the kick-vs-timeout race, the per-row retry timer, and the
 * process-global registry that `enqueue` reaches through.
 *
 * All timing is driven by injectable clock/timer fns so the suite is
 * deterministic — no real `setTimeout` sleeps.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  FlusherSignal,
  getActiveFlusherSignal,
  kickActiveFlusher,
  setActiveFlusherSignal,
  MAX_RETRY_TIMER_MS,
} from "../signal";

// ── A controllable fake timer harness ───────────────────────────────
// FlusherSignal takes `schedule`/`cancel` injection points so we can run
// timers synchronously and assert exact fire ordering without sleeps.
interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

function makeFakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();
  return {
    now: () => nowMs,
    schedule: (fn: () => void, delayMs: number): number => {
      const id = nextId++;
      timers.set(id, { id, fireAt: nowMs + delayMs, fn });
      return id;
    },
    cancel: (id: number): void => {
      timers.delete(id);
    },
    /** Advance the clock, firing every timer whose deadline passed. */
    advance: (deltaMs: number): void => {
      nowMs += deltaMs;
      const due = [...timers.values()]
        .filter((t) => t.fireAt <= nowMs)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        timers.delete(t.id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

afterEach(() => {
  // Never leak a registered signal across tests — top-level singleton.
  setActiveFlusherSignal(null);
});

describe("FlusherSignal.wait / kick", () => {
  test("a kick latched before wait() resolves the next wait immediately (no lost wakeup)", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    // Kick arrives while the fiber is mid-tick (no waiter registered yet).
    signal.kick();

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => settled.push(r));
    // Resolves synchronously off the latch — no clock advance needed.
    expect(settled).toEqual(["kick"]);
    // The latch is single-shot: a fresh wait now blocks on the timer.
    signal.wait(300_000, (r) => settled.push(r));
    expect(settled).toEqual(["kick"]);
  });

  test("wait() times out at the backstop deadline when no kick arrives", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => settled.push(r));
    clock.advance(299_999);
    expect(settled).toEqual([]); // not yet
    clock.advance(1);
    expect(settled).toEqual(["timeout"]);
    expect(clock.pending()).toBe(0); // timer cleaned up on fire
  });

  test("a kick during an active wait resolves it and cancels the timeout timer", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => settled.push(r));
    expect(clock.pending()).toBe(1);
    signal.kick();
    expect(settled).toEqual(["kick"]);
    expect(clock.pending()).toBe(0); // timeout timer cancelled
    // Advancing past the old deadline must NOT double-settle.
    clock.advance(600_000);
    expect(settled).toEqual(["kick"]);
  });

  test("cancel() detaches a pending waiter without settling it", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    const cancel = signal.wait(300_000, (r) => settled.push(r));
    cancel();
    expect(clock.pending()).toBe(0);
    clock.advance(600_000);
    signal.kick();
    expect(settled).toEqual([]); // never settled — fiber moved on
  });
});

describe("FlusherSignal.scheduleRetry", () => {
  test("fires a kick at the requested delay", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => settled.push(r));
    signal.scheduleRetry("row-1", 30_000);
    clock.advance(29_999);
    expect(settled).toEqual([]);
    clock.advance(1);
    expect(settled).toEqual(["kick"]); // retry timer woke the waiter
  });

  test("re-scheduling the same rowId replaces the prior timer (no stacking)", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    signal.scheduleRetry("row-1", 30_000);
    signal.scheduleRetry("row-1", 120_000); // supersedes the 30s timer
    expect(clock.pending()).toBe(1);

    let kicks = 0;
    signal.wait(600_000, () => kicks++);
    clock.advance(30_000);
    expect(kicks).toBe(0); // old 30s timer was cancelled
    clock.advance(90_000); // now at 120s
    expect(kicks).toBe(1);
  });

  test("clamps an absurd delay to MAX_RETRY_TIMER_MS (overflow guard)", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(MAX_RETRY_TIMER_MS * 10, (r) => settled.push(r));
    signal.scheduleRetry("row-1", Number.MAX_SAFE_INTEGER);
    clock.advance(MAX_RETRY_TIMER_MS);
    expect(settled).toEqual(["kick"]); // fired at the clamp, not 2^53 ms out
  });

  test("a negative / NaN delay fires immediately (clamped to 0)", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    let kicks = 0;
    signal.wait(300_000, () => kicks++);
    signal.scheduleRetry("row-1", -5);
    clock.advance(0);
    expect(kicks).toBe(1);
  });
});

describe("FlusherSignal.close", () => {
  test("close() clears retry timers and settles a pending waiter as timeout", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });

    const settled: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => settled.push(r));
    signal.scheduleRetry("row-1", 30_000);
    signal.close();
    expect(settled).toEqual(["timeout"]); // waiter released so the fiber can exit
    expect(clock.pending()).toBe(0); // every timer cleared

    // Post-close, kicks and schedules are inert.
    signal.kick();
    signal.scheduleRetry("row-2", 1_000);
    expect(clock.pending()).toBe(0);
    // A wait after close resolves to timeout immediately (fiber draining).
    const after: Array<"kick" | "timeout"> = [];
    signal.wait(300_000, (r) => after.push(r));
    expect(after).toEqual(["timeout"]);
  });
});

describe("active-signal registry", () => {
  test("kickActiveFlusher() routes to the registered signal", () => {
    const clock = makeFakeClock();
    const signal = new FlusherSignal({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
    const kickSpy = mock(signal.kick.bind(signal));
    signal.kick = kickSpy;

    setActiveFlusherSignal(signal);
    expect(getActiveFlusherSignal()).toBe(signal);
    kickActiveFlusher();
    expect(kickSpy).toHaveBeenCalledTimes(1);
  });

  test("kickActiveFlusher() is a no-op when no signal is registered (region-gated / self-hosted)", () => {
    setActiveFlusherSignal(null);
    // Must not throw — enqueue in a flusher-less process still succeeds.
    expect(() => kickActiveFlusher()).not.toThrow();
    expect(getActiveFlusherSignal()).toBeNull();
  });

  test("a kick that throws never escapes kickActiveFlusher (enqueue stays durable)", () => {
    const exploding = {
      kick: () => {
        throw new Error("doorbell wiring fault");
      },
    } as unknown as FlusherSignal;
    setActiveFlusherSignal(exploding);
    expect(() => kickActiveFlusher()).not.toThrow();
  });
});
