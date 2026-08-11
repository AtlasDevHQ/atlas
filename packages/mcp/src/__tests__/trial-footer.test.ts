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
 * ⚠️ WHAT THIS BLOCK IS AND IS NOT. It is a WIRING test: the real
 * `withTrialFooter` feeding the real `extractToolJson`, so the two halves of the
 * #5137 seam are exercised against each other rather than against a hand-written
 * footer string.
 *
 * ⚠️ IT IS NOT A FALSIFIER FOR THE FOOTER'S SHAPE, and an earlier version of
 * this comment claimed it was — naming three mutations ("change the wording, add
 * a third content item, switch it to a future content type") that it does NOT
 * catch. `extractToolJson` only ever parses PREFIXES, so any prose wording
 * passes, a third prose item passes (the 1-item prefix still parses), and a
 * non-`text` item is dropped by `textItems` and passes. Those three are caught
 * by the assertions ABOVE — `toHaveLength(2)`, `content[0].text` unchanged, and
 * the `5 days remaining` check — which is where they belong.
 *
 * The reader side's own falsifiers live in `packages/mcp/src/eval/client.test.ts`.
 *
 * The defect this closes was invisible for a related reason one layer up:
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
    // One assertion, not two. An earlier cut also asserted `toEqual(before)` and
    // justified it as catching a reader that spliced the advisory into `data` —
    // false: bun's `toEqual` is full structural equality, so such a reader fails
    // THIS line first and the second could never fail independently.
    expect(extractToolJson(withTrialFooter(jsonOk, 5))).toEqual({
      kind: "ok",
      data: jsonBody,
    });
  });

  it("holds for every days value the footer renders differently", () => {
    // 1 and 0 take the footer's singular / lapsed branches. ⚠️ NO READER MUTATION
    // DISTINGUISHES THESE FOUR — the reader never looks at the footer's text —
    // so this is coverage of the FOOTER's branches through the seam, not a
    // falsifier for the reader. Said plainly because an earlier comment claimed
    // it caught "a reader keyed on the plural wording", which cannot exist.
    for (const days of [0, 1, 5, 30]) {
      expect(extractToolJson(withTrialFooter(jsonOk, days))).toEqual({
        kind: "ok",
        data: jsonBody,
      });
    }
  });
});
