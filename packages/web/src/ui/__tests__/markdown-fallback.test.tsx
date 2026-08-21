import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Markdown } from "../components/chat/markdown";

// This assertion previously lived in `markdown.test.tsx` as "renders code
// blocks with fallback pre (before syntax highlighter loads)". It could not
// fail for its stated reason.
//
// `markdown.tsx` caches the lazily-imported highlighter in a MODULE-LEVEL
// `_highlighterCache`, and `useState(_highlighterCache)` seeds from it. Once
// that import resolves, later renders take the `<mod.Prism>` branch — which
// styles via the inline `customStyle` prop and emits a `<pre>` with NO
// className. The old test asserted only `pre !== null` and that `textContent`
// contains the SQL. Prism ALSO renders a `<pre>` whose textContent contains
// the SQL, so both branches satisfied it. Measured, after deliberately
// warming the cache (render a fenced block, then await ~250ms):
//
//   pre === null       : false
//   pre.className      : ""       <-- the Prism branch, i.e. NOT the fallback
//   contains SELECT 1; : true     <-- old assertion still green
//
// Pinning the class is what makes it a real test: mutating `bg-code-bg` to
// `bg-zinc-100` in markdown.tsx turns this red (verified).
//
// On the file placement — this mirrors `sql-block-fallback.test.tsx`, where
// an earlier render in the same file made the equivalent assertion flake under
// CPU contention (#2802). Being honest about the evidence here: that race was
// NOT reproducible for Markdown. No other test in `markdown.test.tsx` renders
// a fenced block, and even deliberately rendering one immediately before this
// assertion left it green at both 32 cores and 1 core — two adjacent
// synchronous tests do not yield long enough for the import to land. So the
// separate file is PREVENTION, not a fix for an observed failure: it makes
// `_highlighterCache === null` structural rather than contingent on nobody
// adding a fenced-block test above this one.
describe("Markdown — the fenced-code fallback pane", () => {
  // ⚠️ THE CODE SURFACE DOES NOT FOLLOW THE MODE. PRODUCT.md Design Principle 5:
  // the code pane is an always-dark terminal window (--code-*), identical on
  // every surface and mode.
  test("is the dark code surface, not a mode-following grey", () => {
    const { container } = render(<Markdown content={"```sql\nSELECT 1;\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const cls = pre!.className;
    expect(cls).toContain("bg-code-bg");
    expect(cls).toContain("text-code-fg");
    expect(cls).not.toMatch(/bg-(white|zinc|slate|gray|neutral)/);
  });
});
