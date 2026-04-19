"use client";

import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useInProgressSet } from "@/ui/hooks/use-admin-fetch";
import type { MutateResult } from "@/ui/hooks/use-admin-mutation";

interface QueueStateAdapter<Row> {
  /** Current rows. Read via a ref internally so `runOptimistic` stays stable. */
  rows: Row[];
  setRows: Dispatch<SetStateAction<Row[]>>;
  getId: (r: Row) => string;
}

/**
 * Optimistic single-row update with revert-on-failure and per-row
 * in-flight tracking.
 *
 * **Why the snapshot is captured synchronously (via ref), not inside the
 * setState updater:** React may defer the setState updater past the next
 * `await` boundary (notably under test `act()` batching), which means
 * reading `original = prev.find(...)` inside the updater can still be
 * `undefined` when the revert branch runs. Snapshotting from a rows-ref
 * synchronously is safe for single-row updates because callers disable
 * concurrent actions on the same row via `inProgress.has(id)` — two calls
 * targeting different rows each capture their own snapshot. For bulk
 * operations that need an atomic multi-row capture, snapshot-inside-setState
 * is the right pattern at the call site; this hook only handles the
 * single-row case.
 */
export function useQueueRow<Row>({ rows, setRows, getId }: QueueStateAdapter<Row>) {
  const inProgress = useInProgressSet();

  // Sync rows into a ref so `runOptimistic` doesn't need to rebuild on
  // every render and can read the latest rows synchronously at call time.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const runOptimistic = useCallback(
    async <TResp>(
      id: string,
      patch: (r: Row) => Row,
      mutation: () => Promise<MutateResult<TResp>>,
    ): Promise<MutateResult<TResp>> => {
      inProgress.start(id);
      try {
        const original = rowsRef.current.find((r) => getId(r) === id);

        setRows((prev) =>
          prev.map((r) => (getId(r) === id ? patch(r) : r)),
        );

        const result = await mutation();

        if (!result.ok) {
          if (original !== undefined) {
            setRows((curr) => curr.map((r) => (getId(r) === id ? original : r)));
          } else {
            // Row was refetched away (or never existed) between call and
            // failure — revert is impossible, so the optimistic patch is
            // inert but the caller must refetch to reconcile with server
            // truth. Surfaced as a debug log rather than a thrown error
            // because the mutation error itself is already returned to
            // the caller in `result.error`.
            console.debug(
              `useQueueRow: revert skipped for id=${id} — row absent at mutation time; caller should refetch`,
            );
          }
        }

        return result;
      } finally {
        inProgress.stop(id);
      }
    },
    [setRows, getId, inProgress],
  );

  return { runOptimistic, inProgress };
}
