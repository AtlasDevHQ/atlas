"use client";

import { useContext, useState, useEffect } from "react";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import { CopyButton } from "./copy-button";

type SyntaxHighlighterModule = typeof import("react-syntax-highlighter");
type StyleModule = typeof import("react-syntax-highlighter/dist/esm/styles/prism");

let _cache: { Prism: SyntaxHighlighterModule["Prism"]; oneDark: StyleModule["oneDark"]; oneLight: StyleModule["oneLight"] } | null = null;

const SQL_BLOCK_STYLE = {
  margin: 0,
  borderRadius: "0.5rem",
  fontSize: "0.75rem",
  padding: "0.75rem 1rem",
} as const;

export function SQLBlock({ sql }: { sql: string }) {
  const dark = useContext(DarkModeContext);
  const [mod, setMod] = useState(_cache);

  useEffect(() => {
    if (_cache) return;
    Promise.all([
      import("react-syntax-highlighter"),
      import("react-syntax-highlighter/dist/esm/styles/prism"),
    ]).then(([sh, styles]) => {
      _cache = { Prism: sh.Prism, oneDark: styles.oneDark, oneLight: styles.oneLight };
      setMod(_cache);
    });
  }, []);

  return (
    <div className="relative">
      {mod ? (
        <mod.Prism
          language="sql"
          style={dark ? mod.oneDark : mod.oneLight}
          customStyle={SQL_BLOCK_STYLE}
        >
          {sql}
        </mod.Prism>
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
          <code>{sql}</code>
        </pre>
      )}
      <div className="absolute right-2 top-2">
        <CopyButton text={sql} label="Copy SQL" />
      </div>
    </div>
  );
}
