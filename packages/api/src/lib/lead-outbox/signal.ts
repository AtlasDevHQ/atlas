/**
 * Edge-trigger doorbell for the CRM outbox flusher (#2874).
 *
 * The flusher used to poll `crm_outbox` every 5s whether or not anything
 * was queued (~17k idle round-trips/day per pod). This module replaces
 * that with an edge-triggered design: the flusher fiber WAITS on a
 * doorbell that the request-path `enqueue` RINGS the instant a row lands,
 * and a per-row retry timer rings it again when a transiently-failed row
 * comes due — so dispatch starts within ms instead of up to 5s, and an
 * idle pod sits silent between a low-frequency backstop sweep.
 *
 * Two independent in-process code paths meet here:
 *
 *   - `enqueue` (plain async, fired from the EE dispatcher's
 *     `upsertLead` / `stampConversion` and from the backfill script)
 *     needs to WAKE the flusher. It reaches the live doorbell through
 *     the process-global registry below (`kickActiveFlusher`), which is
 *     `null` when no flusher is mounted (self-hosted, region-gated-off,
 *     EU/APAC) — there the kick is a no-op and the row is picked up by
 *     the next boot or, where mounted, the backstop sweep.
 *   - the flusher fiber (scheduler Layer) WAITS via `wait()` for a kick
 *     or a backstop timeout, and threads `this` in as the retry
 *     scheduler so `flushBatch` can `scheduleRetry()` a transiently-
 *     failed row's next attempt at its exact due time.
 *
 * One `FlusherSignal` instance per pod, owned by the scheduler Layer
 * scope (created on mount, `close()`d + de-registered on finalize). The
 * in-memory retry timers are intentionally NOT durable across a restart
 * — the backstop sweep is the correctness backstop that re-claims any
 * row whose retry deadline elapsed while a timer was lost.
 *
 * Timers are injected (`schedule` / `cancel` / `now`) so the unit tests
 * drive a fake clock with zero real sleeps; production defaults to
 * `setTimeout` / `clearTimeout` with `.unref()` so a pending timer never
 * keeps the process alive on its own.
 */

/** Reason a `wait()` resolved — lets the loop log kick-vs-backstop. */
export type WaitReason = "kick" | "timeout";

/**
 * Upper bound on an in-memory retry timer. The longest real backoff tier
 * is 12h (`backoff.ts`), well under this — the clamp is a defence against
 * a bug producing an absurd delay that would overflow the 2^31-1 ms
 * `setTimeout` ceiling (and silently fire ~immediately). A row whose true
 * due time is past the clamp wakes early, claims nothing (the SQL gate
 * still isn't satisfied), and is re-caught by the backstop sweep.
 */
export const MAX_RETRY_TIMER_MS = 24 * 60 * 60 * 1_000; // 24h

/**
 * Timer primitives the signal depends on. Injected so tests can run a
 * deterministic fake clock; production uses the host `setTimeout`.
 */
export interface SignalTimers {
  now(): number;
  /** Schedule `fn` after `delayMs`; returns an opaque cancellation handle. */
  schedule(fn: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const DEFAULT_TIMERS: SignalTimers = {
  now: () => Date.now(),
  schedule: (fn, delayMs) => {
    const t = setTimeout(fn, delayMs);
    // Don't let a pending backstop / retry timer hold the event loop open.
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref?: () => void }).unref?.();
    }
    return t;
  },
  cancel: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface Waiter {
  settle(reason: WaitReason): void;
  timeoutHandle: unknown;
}

/**
 * In-process doorbell. Single-waiter by construction — the flusher loop
 * is sequential (tick → wait → tick → wait), so at most one `wait()` is
 * outstanding at a time. A second concurrent `wait()` settles the prior
 * one as `timeout` defensively rather than stranding it.
 */
export class FlusherSignal {
  private readonly timers: SignalTimers;
  /**
   * Latch for a kick that arrived with no waiter registered (the fiber
   * was mid-tick). The next `wait()` consumes it immediately so the
   * wakeup is never lost.
   */
  private kicked = false;
  private waiter: Waiter | null = null;
  private readonly retryTimers = new Map<string, unknown>();
  private closed = false;

  constructor(timers: SignalTimers = DEFAULT_TIMERS) {
    this.timers = timers;
  }

  /**
   * Wake the flusher now. Fire-and-forget and synchronous — safe to call
   * from the request-path `enqueue` and from a retry timer. If a waiter
   * is parked it resolves immediately; otherwise the kick latches for the
   * next `wait()`.
   */
  kick(): void {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      this.timers.cancel(w.timeoutHandle);
      w.settle("kick");
    } else {
      this.kicked = true;
    }
  }

  /**
   * Park until a kick arrives or `timeoutMs` elapses, invoking `onSettle`
   * exactly once with the reason. Returns a cancel fn that detaches the
   * waiter without settling it (for fiber interruption). A kick latched
   * since the last wait resolves synchronously before parking.
   */
  wait(timeoutMs: number, onSettle: (reason: WaitReason) => void): () => void {
    if (this.closed) {
      onSettle("timeout");
      return () => {};
    }
    if (this.kicked) {
      this.kicked = false;
      onSettle("kick");
      return () => {};
    }
    // Defensive: a stray second waiter releases the first as a no-op tick.
    if (this.waiter) {
      const prev = this.waiter;
      this.waiter = null;
      this.timers.cancel(prev.timeoutHandle);
      prev.settle("timeout");
    }

    let settled = false;
    const finish = (reason: WaitReason) => {
      if (settled) return;
      settled = true;
      this.waiter = null;
      onSettle(reason);
    };
    const timeoutHandle = this.timers.schedule(() => finish("timeout"), Math.max(0, timeoutMs));
    this.waiter = {
      settle: (reason) => finish(reason),
      timeoutHandle,
    };
    return () => {
      if (settled) return;
      settled = true;
      this.timers.cancel(timeoutHandle);
      if (this.waiter && this.waiter.timeoutHandle === timeoutHandle) this.waiter = null;
    };
  }

  /**
   * Schedule a one-shot kick `delayMs` from now, keyed on `rowId` so a
   * re-failed row replaces its prior timer rather than stacking. `delayMs`
   * is clamped to `[0, MAX_RETRY_TIMER_MS]`. The backstop sweep covers any
   * timer lost to a restart, so this is a latency optimisation, not a
   * durability guarantee.
   */
  scheduleRetry(rowId: string, delayMs: number): void {
    if (this.closed) return;
    const clamped = clampRetryDelay(delayMs);
    const existing = this.retryTimers.get(rowId);
    if (existing !== undefined) this.timers.cancel(existing);
    const handle = this.timers.schedule(() => {
      this.retryTimers.delete(rowId);
      this.kick();
    }, clamped);
    this.retryTimers.set(rowId, handle);
  }

  /**
   * Release every timer and the parked waiter. Called from the Layer
   * finalizer so the fiber's `wait()` resolves (as `timeout`) and the
   * process can exit cleanly. Idempotent; post-close kicks/schedules are
   * inert.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.retryTimers.values()) this.timers.cancel(handle);
    this.retryTimers.clear();
    const w = this.waiter;
    this.waiter = null;
    if (w) {
      this.timers.cancel(w.timeoutHandle);
      w.settle("timeout");
    }
  }
}

/**
 * Clamp a retry delay to a safe, finite timer range. Non-finite or
 * negative inputs collapse to 0 (fire on the next tick); over-long inputs
 * pin to `MAX_RETRY_TIMER_MS`.
 */
export function clampRetryDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  return Math.min(delayMs, MAX_RETRY_TIMER_MS);
}

// ─────────────────────────────────────────────────────────────────────
//  Process-global registry — the bridge from request-path `enqueue` to
//  the live flusher doorbell.
// ─────────────────────────────────────────────────────────────────────

let activeFlusherSignal: FlusherSignal | null = null;

/**
 * Register (or clear) the pod's live flusher doorbell. Set when the
 * flusher fiber mounts inside the scheduler Layer scope; cleared (`null`)
 * on scope finalize so a kick after shutdown is inert.
 */
export function setActiveFlusherSignal(signal: FlusherSignal | null): void {
  activeFlusherSignal = signal;
}

/** Test/diagnostic accessor for the currently-registered doorbell. */
export function getActiveFlusherSignal(): FlusherSignal | null {
  return activeFlusherSignal;
}

/**
 * Ring the live flusher doorbell, if one is mounted. Called by `enqueue`
 * after a successful INSERT. Never throws — a doorbell fault must not
 * fail the enqueue (the row is durably persisted regardless; the backstop
 * sweep or next boot will dispatch it).
 */
export function kickActiveFlusher(): void {
  const signal = activeFlusherSignal;
  if (!signal) return;
  try {
    signal.kick();
  } catch {
    // intentionally ignored: the row is already persisted; a kick failure
    // only costs up to one backstop interval of dispatch latency, never
    // the lead. Swallowing keeps the enqueue path durable.
  }
}
