/**
 * Tests for `withTrialFooter` (ADR-0018 / #3651) — the additive trial
 * days-remaining advisory appended to successful billing-gated MCP tool
 * responses. Pins that the annotation is purely additive, never mutates an
 * error envelope, and is a no-op when there is no trial info.
 */

import { describe, it, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTrialFooter } from "../mcp-dispatch.js";
import { extractToolJson } from "../eval/client.js";

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

/**
 * #5137 — the footer is additive ON THE WIRE, and it must be additive to the
 * EVAL CLIENT'S READER too.
 *
 * ⚠️ THE FOOTER TEXT IS NOT WRITTEN HERE. Every fixture below is produced by
 * `withTrialFooter` itself, so the two sides of the match cannot agree by
 * construction: change the advisory's wording, add a third content item, or
 * switch it from `text` to a future content type, and these go red. A
 * hand-written `"Atlas trial: 5 days remaining…"` fixture would pin this file's
 * idea of the footer against itself and keep passing.
 *
 * The defect this closes was invisible for exactly that reason one layer up:
 * `getTrialDaysRemaining` returns null off-SaaS, with no org, and for a
 * non-trial workspace, so the CI fixture never appended a footer and every eval
 * result carried exactly ONE text item. A single-item fixture cannot falsify a
 * multi-item bug.
 */
describe("withTrialFooter × the eval client's reader", () => {
  const jsonBody = { row_count: 3, rows: [{ n: 7 }] };
  const jsonOk: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(jsonBody) }],
  };

  it("does not change what extractToolJson reads off a successful result", () => {
    const before = extractToolJson(jsonOk);
    const after = extractToolJson(withTrialFooter(jsonOk, 5));
    expect(after).toEqual({ kind: "ok", data: jsonBody });
    // Additive means IDENTICAL, not merely "still parses" — a reader that
    // spliced the advisory into `data` would satisfy the line above.
    expect(after).toEqual(before);
  });

  it("holds for every days value the footer renders differently", () => {
    // 1 and 0 take the singular / lapsed branches; a reader keyed on the plural
    // wording would pass the 5-day case above and fail here.
    for (const days of [0, 1, 5, 30]) {
      expect(extractToolJson(withTrialFooter(jsonOk, days))).toEqual({
        kind: "ok",
        data: jsonBody,
      });
    }
  });
});
