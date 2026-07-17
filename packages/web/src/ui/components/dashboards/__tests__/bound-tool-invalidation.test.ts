import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { boundMutationSignature } from "../bound-tool-invalidation";

/** Build an assistant message from raw tool-part descriptors. */
function assistant(
  parts: { name: string; state: string; callId: string; kind?: string }[],
): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: parts.map((p) => ({
      type: `tool-${p.name}`,
      toolCallId: p.callId,
      state: p.state,
      ...(p.kind !== undefined ? { output: { kind: p.kind } } : {}),
    })),
  } as unknown as UIMessage;
}

describe("boundMutationSignature", () => {
  test("a pure read completion produces no signature (no refetch)", () => {
    const msg = assistant([
      { name: "getDashboardState", state: "output-available", callId: "c1", kind: "ok" },
    ]);
    expect(boundMutationSignature(msg)).toBe("");
  });

  test("explore / executeSQL reads produce no signature", () => {
    const msg = assistant([
      { name: "explore", state: "output-available", callId: "c1", kind: "ok" },
      { name: "executeSQL", state: "output-available", callId: "c2", kind: "ok" },
    ]);
    expect(boundMutationSignature(msg)).toBe("");
  });

  test("a successful mutation produces a non-empty, stable signature", () => {
    const msg = assistant([
      { name: "addCard", state: "output-available", callId: "c1", kind: "ok" },
    ]);
    const sig = boundMutationSignature(msg);
    expect(sig).not.toBe("");
    // Stable for the same input.
    expect(boundMutationSignature(msg)).toBe(sig);
  });

  test("a FAILED mutation (kind: err) produces no signature", () => {
    const msg = assistant([
      { name: "addCard", state: "output-available", callId: "c1", kind: "err" },
    ]);
    expect(boundMutationSignature(msg)).toBe("");
  });

  test("a THROWN mutation (state: output-error) produces no signature", () => {
    const msg = assistant([
      { name: "updateCard", state: "output-error", callId: "c1" },
    ]);
    expect(boundMutationSignature(msg)).toBe("");
  });

  test("an in-flight mutation (state: input-available) produces no signature", () => {
    const msg = assistant([
      { name: "addCard", state: "input-available", callId: "c1" },
    ]);
    expect(boundMutationSignature(msg)).toBe("");
  });

  test("staged ops (removeCard/updateCardSql → stage_required) count as mutations", () => {
    const remove = assistant([
      { name: "removeCard", state: "output-available", callId: "c1", kind: "stage_required" },
    ]);
    const editSql = assistant([
      { name: "updateCardSql", state: "output-available", callId: "c2", kind: "stage_required" },
    ]);
    expect(boundMutationSignature(remove)).not.toBe("");
    expect(boundMutationSignature(editSql)).not.toBe("");
  });

  test("updateLayout partial success counts (some cards moved)", () => {
    const msg = assistant([
      { name: "updateLayout", state: "output-available", callId: "c1", kind: "partial" },
    ]);
    expect(boundMutationSignature(msg)).not.toBe("");
  });

  test("a read + a successful mutation in one turn → the mutation drives it", () => {
    const readOnly = assistant([
      { name: "getDashboardState", state: "output-available", callId: "c1", kind: "ok" },
    ]);
    const readThenWrite = assistant([
      { name: "getDashboardState", state: "output-available", callId: "c1", kind: "ok" },
      { name: "addCard", state: "output-available", callId: "c2", kind: "ok" },
    ]);
    expect(boundMutationSignature(readOnly)).toBe("");
    expect(boundMutationSignature(readThenWrite)).not.toBe("");
    // The read's completion does not change the signature vs. the write alone.
    expect(boundMutationSignature(readThenWrite)).toBe(
      boundMutationSignature(
        assistant([{ name: "addCard", state: "output-available", callId: "c2", kind: "ok" }]),
      ),
    );
  });

  test("a read completing after a mutation does NOT retrigger (signature unchanged)", () => {
    // Turn 1: mutation lands.
    const afterMutation = assistant([
      { name: "addCard", state: "output-available", callId: "c1", kind: "ok" },
    ]);
    // Turn 1': a subsequent read in the SAME message completes — signature must
    // be identical, so the effect keyed on it does not fire again.
    const afterMutationPlusRead = assistant([
      { name: "addCard", state: "output-available", callId: "c1", kind: "ok" },
      { name: "getDashboardState", state: "output-available", callId: "c2", kind: "ok" },
    ]);
    expect(boundMutationSignature(afterMutationPlusRead)).toBe(
      boundMutationSignature(afterMutation),
    );
  });

  test("undefined / user message → no signature", () => {
    expect(boundMutationSignature(undefined)).toBe("");
    expect(
      boundMutationSignature({ id: "u1", role: "user", parts: [] } as unknown as UIMessage),
    ).toBe("");
  });

  test("distinct successful mutations yield distinct signatures (each fires once)", () => {
    const first = assistant([
      { name: "addCard", state: "output-available", callId: "c1", kind: "ok" },
    ]);
    const second = assistant([
      { name: "addCard", state: "output-available", callId: "c2", kind: "ok" },
    ]);
    expect(boundMutationSignature(first)).not.toBe(boundMutationSignature(second));
  });
});
