"use client";

import { useState, useEffect } from "react";
import { CopyButton } from "./copy-button";

type SyntaxHighlighterModule = typeof import("react-syntax-highlighter");
type StyleModule = typeof import("react-syntax-highlighter/dist/esm/styles/prism");

// ⚠️ `oneDark` ONLY, in the EMBEDDED widget too. PRODUCT.md › Design Principle 5
// defines the code surface by element rather than by app — "the YAML / SQL /
// agent-reply panes: always-dark terminal windows (--code-*), identical on every
// surface and mode" — and styles.css already calls this embedded chat a product
// surface. So the rule that governs packages/web governs this pane as well.
//
// The widget's `dark` prop / DarkModeContext is a CHROME seam: the host page's
// theme drives the widget's chrome, which is right. It deliberately does NOT
// reach the code pane, because "identical on every surface and mode" is a
// statement about mode. Until #5306's follow-up this shipped
// `dark ? oneDark : oneLight` over `bg-zinc-100`, so a customer embedding the
// widget on a light page got the light-grey SQL pane the product had already
// fixed — the same defect, one package over, shipped to customers.
let _cache: { Prism: SyntaxHighlighterModule["Prism"]; oneDark: StyleModule["oneDark"] } | null = null;

// --code-bg and --font-mono come from `.atlas-root` in this package's
// styles.css. The Prism theme paints its own near-black AND its own Fira Code
// stack on both the <pre> and the inner <code>, so both are overridden on both.
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
    // fire-and-forget: lazy-load syntax highlighter modules on mount
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
        // The placeholder must be the SAME dark pane, or the block flashes
        // light-then-dark on every first render.
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
