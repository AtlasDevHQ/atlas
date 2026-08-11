/**
 * Unit tests for the eval client's content readers.
 *
 * `joinTextContent` became a SHARED seam in #5131 — the `--mcp-llm` and
 * `--tool-selection` binders both read a text-contract tool's output through
 * it, and `extractToolJson` parses whatever it returns. Until then it was an
 * expression inlined in one function and its behaviour was only ever exercised
 * through fixtures carrying exactly one text item, so an ordering, filtering or
 * separator regression was invisible: mutating the join to `"\n"`, reversing it,
 * or widening the `type === "text"` filter left every suite in the repo green.
 */

import { describe, expect, it } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { extractToolJson, joinTextContent } from "./client.js";

function result(content: CallToolResult["content"], isError?: boolean): CallToolResult {
  return isError === undefined ? { content } : { content, isError };
}

describe("joinTextContent", () => {
  it("concatenates multiple text items in order with NO separator", () => {
    // Both halves matter: a `"\n"` separator would corrupt JSON split across
    // items, and reversing would corrupt a shell listing. `{"a":` + `1}` is
    // chosen so a separator is not merely different but breaks the parse.
    expect(joinTextContent(result([textItem('{"a":'), textItem("1}")]))).toBe('{"a":1}');
    expect(extractToolJson(result([textItem('{"a":'), textItem("1}")]))).toEqual({
      kind: "ok",
      data: { a: 1 },
    });
  });

  it("keeps ordering — the reverse of a listing is a different listing", () => {
    expect(joinTextContent(result([textItem("entities/\n"), textItem("metrics/\n")]))).toBe(
      "entities/\nmetrics/\n",
    );
  });

  it("returns ONLY the text items when non-text content is interleaved", () => {
    const mixed = result([
      { type: "image" as const, data: "aGk=", mimeType: "image/png" },
      textItem("entities/"),
      { type: "image" as const, data: "aGk=", mimeType: "image/png" },
      textItem("metrics/"),
    ]);
    expect(joinTextContent(mixed)).toBe("entities/metrics/");
  });

  it("ignores a NON-text item that carries its own `text` field", () => {
    // ⚠️ THIS IS THE ONLY SHAPE WHERE THE `type === "text"` FILTER IS
    // LOAD-BEARING, and without this case a mutation deleting the filter is
    // EQUIVALENT rather than caught: `Array#join` already coalesces `undefined`
    // to "", so dropping the filter changes nothing for an image item, which
    // has no `text` property at all. A decoy `text` on a non-text item is what
    // makes the filter falsifiable — and it is a real shape, because MCP keeps
    // adding content types and a future one carrying `text` would silently
    // splice itself into what the model reads and the grader records.
    const decoy = result([
      { type: "resource_link", uri: "file:///x", text: "SHOULD NOT APPEAR" },
      textItem("entities/"),
    ] as unknown as CallToolResult["content"]);
    expect(joinTextContent(decoy)).toBe("entities/");
  });

  it("returns the empty string when there is no text content at all", () => {
    expect(joinTextContent(result([]))).toBe("");
    expect(
      joinTextContent(result([{ type: "image" as const, data: "aGk=", mimeType: "image/png" }])),
    ).toBe("");
  });

  it("also returns the empty string for a text item that carried nothing", () => {
    // Distinct situation, same value — which is exactly why the binders route
    // BOTH to the protocol lane rather than treating "" as shell output.
    expect(joinTextContent(result([textItem("")]))).toBe("");
  });
});

describe("extractToolJson", () => {
  it("reaches the unparseable arm BEFORE consulting isError", () => {
    // The ordering the #5131 carve-outs depend on: a server-flagged error with
    // a prose body is indistinguishable from shell output by shape alone, so a
    // caller that exempts a tool must read `isError` itself.
    expect(extractToolJson(result([textItem("Error: sandbox failed")], true))).toEqual({
      kind: "unparseable",
      raw: "Error: sandbox failed",
    });
  });

  it("returns the typed envelope when a flagged error's body IS JSON", () => {
    expect(
      extractToolJson(result([textItem(JSON.stringify({ code: "rate_limited" }))], true)),
    ).toEqual({ kind: "error", envelope: { code: "rate_limited" } });
  });
});

/**
 * #5137 — a JSON body followed by a prose annotation.
 *
 * `withTrialFooter` appends one to every successful billing-gated result
 * (`runMetric`, `executeSQL`, `query` — the three tools that answer most of the
 * corpus), so the join stopped parsing and a CORRECT answer was recorded
 * `unparseable`, which `grade()` fails as `protocol`. See
 * `packages/mcp/src/__tests__/trial-footer.test.ts` for the same property
 * asserted against the real footer producer rather than a hand-written one.
 */
describe("extractToolJson — multi-part results", () => {
  const FOOTER = "Atlas trial: 5 days remaining. Subscribe on the web before it ends.";

  it("parses the JSON body when a prose item follows it", () => {
    expect(extractToolJson(result([textItem('{"row_count":3}'), textItem(FOOTER)]))).toEqual({
      kind: "ok",
      data: { row_count: 3 },
    });
  });

  it("parses a body SPLIT across items when a prose item follows it", () => {
    // Three items, and the body is the first TWO — so a fix that only ever
    // tries "the first item" or "the whole join" fails this in one direction
    // each. The split point is inside a value so a wrong cut cannot parse.
    expect(
      extractToolJson(result([textItem('{"row_count":'), textItem("3}"), textItem(FOOTER)])),
    ).toEqual({ kind: "ok", data: { row_count: 3 } });
  });

  it("reads a flagged error's envelope through a trailing prose item", () => {
    expect(
      extractToolJson(
        result([textItem(JSON.stringify({ code: "query_timeout" })), textItem(FOOTER)], true),
      ),
    ).toEqual({ kind: "error", envelope: { code: "query_timeout" } });
  });

  it("prefers the LONGEST parsing prefix, not the first one that parses", () => {
    // ⚠️ THIS IS THE WHOLE "strictly additive" CLAIM, AND IT IS THE ONLY TEST
    // THAT CAN FALSIFY IT. Both items parse alone, so a shortest-first scan
    // answers `1` — a DIFFERENT value for a result that already had a body
    // before #5137. Scanning longest-first answers `12`, exactly what the old
    // whole-join parse answered.
    expect(extractToolJson(result([textItem("1"), textItem("2")]))).toEqual({
      kind: "ok",
      data: 12,
    });
  });

  it("stays unparseable when the PROSE comes first", () => {
    // Not a shape Atlas produces (the footer is appended), and the honest
    // answer is the loud one: `raw` carries the whole join so the artifact
    // shows an operator everything the tool actually said.
    expect(extractToolJson(result([textItem("Warning: slow query. "), textItem("{}")]))).toEqual({
      kind: "unparseable",
      raw: "Warning: slow query. {}",
    });
  });

  it("does not treat a body of literal `null` as 'nothing parsed'", () => {
    // `JSON.parse("null")` is a legitimate body. Unboxed, it is indistinguishable
    // from the no-prefix-parsed signal, and this result would wrongly read
    // `unparseable` — with `raw: "null"`, which reads like a protocol regression.
    expect(extractToolJson(result([textItem("null"), textItem(FOOTER)]))).toEqual({
      kind: "ok",
      data: null,
    });
  });
});

function textItem(text: string) {
  return { type: "text" as const, text };
}
