import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SQLBlock } from "../components/chat/sql-block";

// ⚠️ THIS TEST LIVES ALONE IN ITS OWN FILE, AND THAT IS THE POINT.
//
// `sql-block.tsx` caches the lazily-imported highlighter in a MODULE-LEVEL
// `_cache`, and `useState(_cache)` seeds from it. Any earlier render of
// SQLBlock in the same module registry fires the `useEffect` import; once that
// promise resolves, every later render takes the `<mod.Prism>` branch — which
// styles via the inline `customStyle` prop and emits a `<pre>` with NO
// className. The fallback assertion below then reads `""` and goes red for a
// reason that has nothing to do with what it is testing.
//
// It sat in sql-block.test.tsx behind three other renders and was a race the
// whole time: green on a fast machine (the import loses), red under CPU
// contention (the gap between tests stretches and the import lands). #2802's
// cutover to `bun test --parallel` changed that timing and turned it red on CI
// — reproduced locally with `taskset -c 0,1`: 3/3 red on two cores, 3/3 green
// on 32. `--parallel` implies `--isolate`, so a fresh registry per FILE is what
// makes `_cache === null` at render time a guarantee rather than a hope.
//
// Do not merge this back into sql-block.test.tsx.
describe("SQLBlock — the fallback pane", () => {
  // ⚠️ THE CODE SURFACE DOES NOT FOLLOW THE MODE. PRODUCT.md Design Principle 5: the
  // SQL pane is an "always-dark terminal window (--code-*), identical on every
  // surface and mode". This shipped as `bg-zinc-100 dark:bg-zinc-800` under
  // `dark ? oneDark : oneLight`, so in light mode the most brand-defining
  // component in the product was a light grey box (#5306). Mutation: restore
  // `bg-zinc-100` on the fallback pre → this test goes red.
  test("is the dark code surface, not a mode-following grey", () => {
    const { container } = render(<SQLBlock sql="SELECT 1" />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const cls = pre!.className;
    expect(cls).toContain("bg-code-bg");
    expect(cls).toContain("text-code-fg");
    expect(cls).not.toMatch(/bg-(white|zinc|slate|gray|neutral)/);
  });
});
