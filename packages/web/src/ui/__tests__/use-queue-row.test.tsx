import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import { useQueueRow } from "../components/admin/queue";
import type { MutateResult } from "../hooks/use-admin-mutation";

interface Row {
  id: string;
  status: "pending" | "approved" | "denied";
  label: string;
}

const INITIAL: Row[] = [
  { id: "a", status: "pending", label: "A" },
  { id: "b", status: "pending", label: "B" },
  { id: "c", status: "pending", label: "C" },
];

function ok<T>(data: T): MutateResult<T> {
  return { ok: true, data };
}
function fail(error: string): MutateResult<never> {
  return { ok: false, error };
}

/**
 * Harness: exposes rows via useState and wires setRows/getId into the hook so
 * tests can assert against the same state the UI would render.
 */
function useHarness(initial: Row[] = INITIAL) {
  const [rows, setRows] = useState<Row[]>(initial);
  const queue = useQueueRow<Row>({
    rows,
    setRows,
    getId: (r) => r.id,
  });
  return { rows, setRows, ...queue };
}

describe("useQueueRow", () => {
  beforeEach(() => {});
  afterEach(() => cleanup());

  test("applies the optimistic patch immediately and commits on success", async () => {
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.runOptimistic(
        "a",
        (r) => ({ ...r, status: "approved" }),
        async () => ok(undefined),
      );
    });

    const rowA = result.current.rows.find((r) => r.id === "a");
    expect(rowA?.status).toBe("approved");
  });

  test("reverts only the touched row on failure, preserving others", async () => {
    const { result } = renderHook(() => useHarness());

    // Seed row B with a concurrent edit that must survive the revert.
    act(() => {
      result.current.setRows((prev) =>
        prev.map((r) => (r.id === "b" ? { ...r, label: "B!" } : r)),
      );
    });

    await act(async () => {
      const res = await result.current.runOptimistic(
        "a",
        (r) => ({ ...r, status: "approved" }),
        async () => fail("HTTP 403"),
      );
      expect(res.ok).toBe(false);
    });

    const rowA = result.current.rows.find((r) => r.id === "a");
    const rowB = result.current.rows.find((r) => r.id === "b");
    expect(rowA?.status).toBe("pending"); // reverted
    expect(rowB?.label).toBe("B!"); // concurrent edit preserved
  });

  test("captures the snapshot inside the setRows updater so concurrent runs don't share originals", async () => {
    const { result } = renderHook(() => useHarness());

    // Fire two mutations before either resolves. Both patch status→approved
    // but only A fails; B succeeds. A must revert to pending even though the
    // second setState overwrote B to approved first.
    let resolveA!: (v: MutateResult<undefined>) => void;
    let resolveB!: (v: MutateResult<undefined>) => void;

    let promiseA!: Promise<MutateResult<undefined>>;
    let promiseB!: Promise<MutateResult<undefined>>;

    await act(async () => {
      promiseA = result.current.runOptimistic(
        "a",
        (r) => ({ ...r, status: "approved" }),
        () => new Promise<MutateResult<undefined>>((r) => { resolveA = r; }),
      );
      promiseB = result.current.runOptimistic(
        "b",
        (r) => ({ ...r, status: "approved" }),
        () => new Promise<MutateResult<undefined>>((r) => { resolveB = r; }),
      );
    });

    // Both rows should be optimistically approved right now.
    expect(result.current.rows.find((r) => r.id === "a")?.status).toBe("approved");
    expect(result.current.rows.find((r) => r.id === "b")?.status).toBe("approved");

    // A fails, B succeeds — A must NOT revert B.
    await act(async () => {
      resolveA(fail("boom"));
      resolveB(ok(undefined));
      await Promise.all([promiseA, promiseB]);
    });

    expect(result.current.rows.find((r) => r.id === "a")?.status).toBe("pending");
    expect(result.current.rows.find((r) => r.id === "b")?.status).toBe("approved");
  });

  test("inProgress.has tracks the row while the mutation is in flight", async () => {
    const { result } = renderHook(() => useHarness());

    let resolveMutation!: (v: MutateResult<undefined>) => void;

    let mutationPromise!: Promise<MutateResult<undefined>>;
    await act(async () => {
      mutationPromise = result.current.runOptimistic(
        "a",
        (r) => ({ ...r, status: "approved" }),
        () => new Promise<MutateResult<undefined>>((r) => { resolveMutation = r; }),
      );
    });

    expect(result.current.inProgress.has("a")).toBe(true);
    expect(result.current.inProgress.has("b")).toBe(false);

    await act(async () => {
      resolveMutation(ok(undefined));
      await mutationPromise;
    });

    expect(result.current.inProgress.has("a")).toBe(false);
  });
});
