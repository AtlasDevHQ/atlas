/**
 * Unit tests for the shared streaming body-size cap (`read-body-cap.ts`) —
 * the authoritative guard both knowledge byte-ingress paths (admin upload,
 * bundle-endpoint fetch) read through. The load-bearing case is the
 * MULTI-CHUNK one: the cap must be CUMULATIVE across chunks, not per-chunk —
 * a regression to per-chunk checking is exactly the lying/chunked-source bug
 * class this guard exists to prevent, and single-chunk callers can't catch it.
 */

import { describe, expect, it } from "bun:test";
import { readBodyWithCap, BodyCapExceededError } from "../read-body-cap";

function streamOf(chunks: Uint8Array[], opts?: { onCancel?: () => void; cancelThrows?: boolean }) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      opts?.onCancel?.();
      if (opts?.cancelThrows) throw new Error("cancel exploded");
    },
  });
}

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("readBodyWithCap", () => {
  it("aborts when the CUMULATIVE total crosses the cap even though every chunk is under it", async () => {
    // 3 × 400 bytes with a 1000-byte cap: chunks 1+2 pass (800), chunk 3
    // crosses (1200). A per-chunk check would let all three through.
    const body = streamOf([bytes(400, 1), bytes(400, 2), bytes(400, 3)]);
    await expect(readBodyWithCap(body, 1000)).rejects.toBeInstanceOf(BodyCapExceededError);
  });

  it("reassembles a multi-chunk under-cap body byte-for-byte", async () => {
    const body = streamOf([bytes(3, 7), bytes(2, 9), bytes(4, 5)]);
    const out = await readBodyWithCap(body, 100);
    expect([...out]).toEqual([7, 7, 7, 9, 9, 5, 5, 5, 5]);
  });

  it("resolves a null body to an empty buffer", async () => {
    expect((await readBodyWithCap(null, 100)).length).toBe(0);
  });

  it("accepts a body of exactly the cap size (strict > boundary)", async () => {
    const body = streamOf([bytes(500, 1), bytes(500, 2)]);
    const out = await readBodyWithCap(body, 1000);
    expect(out.length).toBe(1000);
  });

  it("releases the source on a cap abort — and a throwing cancel is contained", async () => {
    let cancelled = false;
    const body = streamOf([bytes(600, 1), bytes(600, 2)], {
      onCancel: () => {
        cancelled = true;
      },
      cancelThrows: true,
    });
    // The cap abort surfaces; the cancel failure is swallowed (debug-logged),
    // never masking the real error.
    await expect(readBodyWithCap(body, 1000)).rejects.toBeInstanceOf(BodyCapExceededError);
    expect(cancelled).toBe(true);
  });
});
