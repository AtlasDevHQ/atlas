/**
 * Tests for `withTrialFooter` (ADR-0018 / #3651) — the additive trial
 * days-remaining advisory appended to successful billing-gated MCP tool
 * responses. Pins that the annotation is purely additive, never mutates an
 * error envelope, and is a no-op when there is no trial info.
 */

import { describe, it, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTrialFooter } from "../mcp-dispatch.js";

const ok: CallToolResult = {
  content: [{ type: "text", text: "rows: 3" }],
};

describe("withTrialFooter", () => {
  it("appends a days-remaining line to a successful result", () => {
    const out = withTrialFooter(ok, 5);
    expect(out.content).toHaveLength(2);
    const footer = out.content[1] as { type: string; text: string };
    expect(footer.text).toContain("5 days remaining");
    // Original content is preserved, footer is appended last.
    expect((out.content[0] as { text: string }).text).toBe("rows: 3");
  });

  it("uses the singular for one day", () => {
    const out = withTrialFooter(ok, 1);
    expect((out.content[1] as { text: string }).text).toContain("1 day remaining");
  });

  it("renders 0 days remaining (lapsed but not yet expired)", () => {
    const out = withTrialFooter(ok, 0);
    expect((out.content[1] as { text: string }).text).toContain("0 days remaining");
  });

  it("is a no-op when days is null (off-SaaS / no-org / non-trial)", () => {
    const out = withTrialFooter(ok, null);
    expect(out).toBe(ok);
    expect(out.content).toHaveLength(1);
  });

  it("never annotates an error envelope", () => {
    const err: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify({ code: "billing_blocked" }) }],
      isError: true,
    };
    const out = withTrialFooter(err, 5);
    expect(out).toBe(err);
    expect(out.content).toHaveLength(1);
  });
});
