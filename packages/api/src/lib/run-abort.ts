/**
 * #4294 — in-process registry of abortable agent runs, so the chat client's
 * Stop button can cancel generation server-side (stop consuming tokens), not
 * just close its own response stream.
 *
 * Design constraints:
 *
 * - **Stop is an explicit signal, never inferred from disconnect.** Wiring the
 *   request's own `AbortSignal` into the agent would make a tab close / network
 *   drop kill the run — regressing the durable-session contract (ADR-0020),
 *   where an interrupted client leaves the run to finish (or checkpoint) server
 *   side. Only `POST /chat/runs/:runId/stop` aborts.
 * - **Identity-guarded.** An entry carries the user/org identity of the request
 *   that started the run; `abortRun` refuses a caller whose identity doesn't
 *   match, reporting `not_found` (not `forbidden`) so a guessed run id leaks
 *   nothing across a tenancy boundary.
 * - **In-process, best-effort.** The map lives in this process only; on a
 *   multi-instance deploy a stop request routed to a different instance is a
 *   `not_found` no-op. The client aborts its own fetch regardless, so the UX
 *   is unaffected — server-side abort is a token-spend optimization, and the
 *   per-run `streamText` timeout (180s) bounds the worst case.
 */

import { createLogger } from "./logger";

const log = createLogger("run-abort");

export interface AbortableRunEntry {
  readonly controller: AbortController;
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly registeredAt: number;
}

export interface RunAbortIdentity {
  readonly userId: string | null;
  readonly orgId: string | null;
}

export type AbortRunResult = "aborted" | "not_found";

/**
 * Stale-entry horizon. Entries are removed when the run settles, so anything
 * older than this outlived every legitimate lifecycle (the agent loop's total
 * timeout is 180s) and is a leak — pruned lazily on the next register.
 */
const STALE_ENTRY_MS = 15 * 60 * 1000;

const activeRuns = new Map<string, AbortableRunEntry>();

function pruneStale(now: number): void {
  for (const [runId, entry] of activeRuns) {
    if (now - entry.registeredAt > STALE_ENTRY_MS) {
      activeRuns.delete(runId);
      log.warn({ runId }, "Pruned stale abortable-run entry — run never unregistered");
    }
  }
}

/**
 * Register a run as abortable for its streaming lifetime. Call immediately
 * before the agent loop starts; pair with {@link unregisterAbortableRun} on
 * every settle path (stream finish, stream error, steps settlement).
 */
export function registerAbortableRun(
  runId: string,
  opts: { controller: AbortController } & RunAbortIdentity,
): void {
  pruneStale(Date.now());
  activeRuns.set(runId, {
    controller: opts.controller,
    userId: opts.userId,
    orgId: opts.orgId,
    registeredAt: Date.now(),
  });
}

/** Remove a settled run. Idempotent — every settle path may call it. */
export function unregisterAbortableRun(runId: string): void {
  activeRuns.delete(runId);
}

/**
 * Abort a registered run on behalf of `caller`. Identity must match the
 * registering request exactly (null-equal on both axes); a mismatch reports
 * `not_found` so existence is never confirmed across a tenancy boundary.
 * The entry is removed on success — a second stop of the same run is
 * `not_found`, which callers treat as "already finished".
 */
export function abortRun(runId: string, caller: RunAbortIdentity): AbortRunResult {
  const entry = activeRuns.get(runId);
  if (!entry) return "not_found";
  if (entry.userId !== caller.userId || entry.orgId !== caller.orgId) {
    log.warn({ runId }, "Stop request identity mismatch — treated as not found");
    return "not_found";
  }
  activeRuns.delete(runId);
  entry.controller.abort();
  return "aborted";
}

/** Test-only: reset the registry between cases. */
export function __clearAbortableRunsForTest(): void {
  activeRuns.clear();
}
