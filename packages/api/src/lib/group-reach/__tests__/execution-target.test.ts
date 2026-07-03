/**
 * Behavioral unit tests for the pure execution-target resolver — the SSOT
 * both `validateSQL` (whitelist bucket) and `executeSQL.execute` (routing +
 * execution) consume so the two can never drift (#3961 / #3947 / #3109).
 *
 * Pure — no DB, no IO. Pins the `unpinned` widening flag: it is TRUE only for
 * an All-sources conversation querying its OWN connection, and FALSE for every
 * pinned member, sibling pin, non-own fanout leg, focused conversation, and
 * no-context caller.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveExecutionTarget,
  type ExecutionTarget,
} from "@atlas/api/lib/group-reach/execution-target";

describe("resolveExecutionTarget", () => {
  it("all-sources + self connection ⇒ unpinned:true", () => {
    // reach "all" (null/undefined groupReach) AND the lookup id IS the
    // conversation's own connection id.
    const target = resolveExecutionTarget(
      { groupReach: null, connectionId: "conn-a" },
      "conn-a",
    );
    expect(target.unpinned).toBe(true);
    expect(target.connectionId).toBe("conn-a");
  });

  it("all-sources + SIBLING connection (≠ reqCtx.connectionId) ⇒ unpinned:false", () => {
    // An agent pin to a sibling connection must never widen to the union.
    const target = resolveExecutionTarget(
      { groupReach: null, connectionId: "conn-a" },
      "conn-b",
    );
    expect(target.unpinned).toBe(false);
    expect(target.connectionId).toBe("conn-b");
  });

  it("focused reach (non-all) + self connection ⇒ unpinned:false", () => {
    // A non-null groupReach decodes to focus — not "all" — so no widening
    // even against the conversation's own connection.
    const target = resolveExecutionTarget(
      { groupReach: "group-x", connectionId: "conn-a" },
      "conn-a",
    );
    expect(target.unpinned).toBe(false);
    expect(target.connectionId).toBe("conn-a");
  });

  it("reqCtx undefined ⇒ unpinned:false, connectionId passthrough", () => {
    const target = resolveExecutionTarget(undefined, "conn-a");
    expect(target.unpinned).toBe(false);
    expect(target.connectionId).toBe("conn-a");
  });

  it("undefined connectionId ⇒ unpinned:false, defaults bucket to \"default\"", () => {
    // Non-execute callers may pass an undefined connectionId; the
    // `!== undefined` clause keeps unpinned false and the bucket id falls
    // back to "default" (identical to the whitelist accessors' own default).
    const target = resolveExecutionTarget(
      { groupReach: null, connectionId: "conn-a" },
      undefined,
    );
    expect(target.unpinned).toBe(false);
    expect(target.connectionId).toBe("default");
  });

  it("falsy-but-non-null groupReach (empty string) decodes to \"all\"", () => {
    // A bare `?? null` check would miss this; reachStateFromColumn treats
    // empty string as "all".
    const target: ExecutionTarget = resolveExecutionTarget(
      { groupReach: "", connectionId: "conn-a" },
      "conn-a",
    );
    expect(target.unpinned).toBe(true);
  });
});
