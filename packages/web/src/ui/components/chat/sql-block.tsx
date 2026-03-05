"use client";

import { useContext } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import { CopyButton } from "./copy-button";

export function SQLBlock({ sql }: { sql: string }) {
  const dark = useContext(DarkModeContext);
  return (
    <div className="relative">
      <SyntaxHighlighter
        language="sql"
        style={dark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderRadius: "0.5rem",
          fontSize: "0.75rem",
          padding: "0.75rem 1rem",
        }}
      >
        {sql}
      </SyntaxHighlighter>
      <div className="absolute right-2 top-2">
        <CopyButton text={sql} label="Copy SQL" />
      </div>
    </div>
  );
}
