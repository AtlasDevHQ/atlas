"use client";

import { useContext } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DarkModeContext } from "../../hooks/use-dark-mode";

export function Markdown({ content }: { content: string }) {
  const dark = useContext(DarkModeContext);
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="mb-3 leading-relaxed last:mb-0">{children}</p>
        ),
        h1: ({ children }) => (
          <h1 className="mb-2 mt-4 text-lg font-bold first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h3>
        ),
        ul: ({ children }) => (
          <ul className="mb-3 list-disc space-y-1 pl-4">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-decimal space-y-1 pl-4">{children}</ol>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-zinc-900 dark:text-zinc-50">{children}</strong>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            {children}
          </blockquote>
        ),
        pre: ({ children }) => <>{children}</>,
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          if (match) {
            return (
              <SyntaxHighlighter
                language={match[1]}
                style={dark ? oneDark : oneLight}
                customStyle={{
                  margin: "0.5rem 0",
                  borderRadius: "0.5rem",
                  fontSize: "0.75rem",
                }}
              >
                {String(children).replace(/\n$/, "")}
              </SyntaxHighlighter>
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
}
