/**
 * #3750 — `withResumeHint` (MCP approval resume-hint helper).
 *
 * Pins the three behaviors the helper guarantees: append to an existing
 * message, tolerate a missing/non-string upstream message (return the bare
 * hint), and idempotency (never double-append when the hint is already there).
 */

import { describe, it, expect } from "bun:test";
import { withResumeHint, MCP_APPROVAL_RESUME_HINT } from "../structured-output.js";

describe("withResumeHint (#3750)", () => {
  it("appends the hint to a non-empty message (with a separating space)", () => {
    const out = withResumeHint("Approval required. Rule: X.");
    expect(out).toBe(`Approval required. Rule: X. ${MCP_APPROVAL_RESUME_HINT}`);
  });

  it("returns the bare hint when the message is missing / empty / non-string", () => {
    expect(withResumeHint(undefined)).toBe(MCP_APPROVAL_RESUME_HINT);
    expect(withResumeHint("")).toBe(MCP_APPROVAL_RESUME_HINT);
    expect(withResumeHint(null)).toBe(MCP_APPROVAL_RESUME_HINT);
    expect(withResumeHint(42)).toBe(MCP_APPROVAL_RESUME_HINT);
  });

  it("is idempotent — does not double-append when the hint is already present", () => {
    const once = withResumeHint("Needs approval.");
    const twice = withResumeHint(once);
    expect(twice).toBe(once);
    // Exactly one occurrence of the hint.
    expect(twice.split(MCP_APPROVAL_RESUME_HINT)).toHaveLength(2);
  });
});
