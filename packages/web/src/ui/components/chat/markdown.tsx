"use client";

import { memo, useState, useEffect, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDarkMode } from "../../hooks/use-dark-mode";

/* ------------------------------------------------------------------ */
/*  Lazy-loaded syntax highlighter (~300KB)                            */
/* ------------------------------------------------------------------ */

type SyntaxHighlighterModule = typeof import("react-syntax-highlighter");
type StyleModule = typeof import("react-syntax-highlighter/dist/esm/styles/prism");

let _highlighterCache: { Prism: SyntaxHighlighterModule["Prism"]; oneDark: StyleModule["oneDark"]; oneLight: StyleModule["oneLight"] } | null = null;

function LazyCodeBlock({ language, dark, children }: { language: string; dark: boolean; children: string }) {
  const [mod, setMod] = useState(_highlighterCache);

  useEffect(() => {
    if (_highlighterCache) return;
    Promise.all([
      import("react-syntax-highlighter"),
      import("react-syntax-highlighter/dist/esm/styles/prism"),
    ]).then(([sh, styles]) => {
      _highlighterCache = { Prism: sh.Prism, oneDark: styles.oneDark, oneLight: styles.oneLight };
      setMod(_highlighterCache);
    });
  }, []);

  if (!mod) {
    return (
      <pre className="my-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
        <code>{children}</code>
      </pre>
    );
  }

  return (
    <mod.Prism
      language={language}
      style={dark ? mod.oneDark : mod.oneLight}
      customStyle={CODE_BLOCK_STYLE}
    >
      {children}
    </mod.Prism>
  );
}

const CODE_BLOCK_STYLE = {
  margin: "0.5rem 0",
  borderRadius: "0.5rem",
  fontSize: "0.75rem",
} as const;

/* ------------------------------------------------------------------ */
/*  Static markdown renderers — hoisted outside component              */
/* ------------------------------------------------------------------ */

const mdComponents = {
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-3 leading-relaxed last:mb-0">{children}</p>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mb-2 mt-4 text-lg font-bold first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h3>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 list-disc space-y-1 pl-4">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-4">{children}</ol>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-zinc-900 dark:text-zinc-50">{children}</strong>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
      <table className="min-w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
      {children}
    </thead>
  ),
  tbody: ({ children }: { children?: ReactNode }) => (
    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>
  ),
  tr: ({ children }: { children?: ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-3 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-300">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{children}</td>
  ),
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const dark = useDarkMode();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        ...mdComponents,
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          if (match) {
            return (
              <LazyCodeBlock language={match[1]} dark={dark}>
                {String(children).replace(/\n$/, "")}
              </LazyCodeBlock>
            );
          }
          return (
            <code
              className="rounded bg-zinc-200/50 px-1.5 py-0.5 text-xs text-zinc-800 dark:bg-zinc-700/50 dark:text-zinc-200"
              {...props}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
