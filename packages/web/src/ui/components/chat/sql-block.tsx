"use client";

import { useState, useEffect } from "react";
import { CopyButton } from "./copy-button";

type SyntaxHighlighterModule = typeof import("react-syntax-highlighter");
type StyleModule = typeof import("react-syntax-highlighter/dist/esm/styles/prism");

// ⚠️ `oneDark` ONLY — no light variant is loaded, and that is the product
// decision rather than an oversight. PRODUCT.md › Design Principle 5 makes the code
// surface the one thing that does not follow the mode: the YAML / SQL /
// agent-reply panes are "always-dark terminal windows (--code-*), identical on
// every surface and mode". This pane is the hero asset of that light-page /
// dark-code inversion, and until #5306 it shipped `dark ? oneDark : oneLight`
// — so in light mode, the single most brand-defining component in the product
// rendered as light grey on white.
let _cache: { Prism: SyntaxHighlighterModule["Prism"]; oneDark: StyleModule["oneDark"] } | null = null;

// The Prism theme carries its own near-black; `--code-bg` (brand.css, shared
// with apps/www) is the brand's, so it wins on both the pre and the code tag —
// oneDark paints both, and overriding only the pre leaves a mismatched inner
// block.
//
// ⚠️ `fontFamily` for the same reason as `background`. oneDark hardcodes
// `"Fira Code", "Fira Mono", Menlo, Consolas, …` on BOTH selectors, so fixing
// only the ground left the highlighted pane — the state a user actually sees —
// rendering in Fira Code while apps/www renders its code in JetBrains Mono
// (`font-family: var(--font-mono)`, globals.css). Same pane, two typefaces, on
// the one component PRODUCT.md › Design Principle 5 calls "identical on every surface
// and mode". The placeholder <pre> below carries `font-mono` too, so the block
// no longer changes typeface on hydration either.
const SQL_BLOCK_STYLE = {
  margin: 0,
  borderRadius: "0.5rem",
  fontSize: "0.75rem",
  padding: "0.75rem 1rem",
  background: "var(--code-bg)",
  fontFamily: "var(--font-mono)",
} as const;

const SQL_CODE_TAG_PROPS = {
  style: { background: "transparent", fontFamily: "var(--font-mono)" },
} as const;

export function SQLBlock({ sql }: { sql: string }) {
  const [mod, setMod] = useState(_cache);

  useEffect(() => {
    if (_cache) return;
    // fire-and-forget: lazy-load the syntax highlighter; setMod handles the result
    void Promise.all([
      import("react-syntax-highlighter"),
      import("react-syntax-highlighter/dist/esm/styles/prism"),
    ]).then(([sh, styles]) => {
      _cache = { Prism: sh.Prism, oneDark: styles.oneDark };
      setMod(_cache);
    });
  }, []);

  return (
    <div className="relative">
      {mod ? (
        <mod.Prism
          language="sql"
          style={mod.oneDark}
          customStyle={SQL_BLOCK_STYLE}
          codeTagProps={SQL_CODE_TAG_PROPS}
        >
          {sql}
        </mod.Prism>
      ) : (
        // The pre-highlighter placeholder must be the SAME dark pane, or the
        // block flashes light-then-dark on every first render.
        <pre className="overflow-x-auto rounded-lg bg-code-bg p-3 font-mono text-xs text-code-fg">
          <code>{sql}</code>
        </pre>
      )}
      <div className="absolute right-2 top-2">
        <CopyButton text={sql} label="Copy SQL" />
      </div>
    </div>
  );
}
