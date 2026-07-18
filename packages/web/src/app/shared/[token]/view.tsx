// The standalone shared-conversation success view. Extracted from `page.tsx`
// (#4719) so the org-share resolver (`org-share-resolver.tsx`) can render the
// EXACT surface the SSR path renders after resolving an org share client-side
// — the two paths are visually indistinguishable. Client-safe by design: no
// server-only imports may land here.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Markdown } from "@/ui/components/chat/markdown";
import { type SharedConversation, extractTextContent } from "../lib";

export function SharedConversationView({ convo }: { convo: SharedConversation }) {
  const renderedMessages = convo.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((msg) => ({ msg, text: extractTextContent(msg.content) }))
    .filter(({ text }) => text.trim().length > 0);
  const hiddenStepCount = convo.messages.length - renderedMessages.length;

  const formattedDate = new Date(convo.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 focus:outline-none print:p-0">
        <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800 print:border-zinc-300">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Atlas
              </span>
              <span aria-hidden="true">&middot;</span>
              <span
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 print:bg-transparent print:px-0"
                aria-label="This is a read-only snapshot"
              >
                Read-only
              </span>
              <span aria-hidden="true">&middot;</span>
              <time dateTime={convo.createdAt}>Captured {formattedDate}</time>
            </div>
            <Link
              href="/signup"
              className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 transition-colors hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200 print:hidden"
            >
              Try Atlas free
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {convo.title && (
            <h1 className="mt-3 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {convo.title}
            </h1>
          )}
        </header>

        {renderedMessages.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            This conversation has no readable content.
          </p>
        ) : (
          <div className="space-y-6">
            {renderedMessages.map(({ msg, text }, i) => {
              const isUser = msg.role === "user";
              return (
                <article
                  key={i}
                  className="space-y-1.5 print:break-inside-avoid"
                  aria-label={isUser ? "User message" : "Atlas response"}
                >
                  <p
                    className={`text-[10px] font-semibold uppercase tracking-wider ${
                      isUser
                        ? "text-zinc-500 dark:text-zinc-400"
                        : "text-teal-700 dark:text-teal-300"
                    }`}
                  >
                    {isUser ? "User" : "Atlas"}
                  </p>
                  {isUser ? (
                    <p className="whitespace-pre-wrap text-zinc-900 dark:text-zinc-100">
                      {text}
                    </p>
                  ) : (
                    <div className="text-zinc-900 dark:text-zinc-100">
                      {/* disallowImages (#3342 L-7): unauthenticated public surface — block
                          LLM-markdown tracking pixels / viewer-IP leaks. */}
                      <Markdown content={text} disallowImages />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {hiddenStepCount > 0 && (
          <p className="mt-8 border-t border-zinc-200 pt-4 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 print:hidden">
            {hiddenStepCount} analysis step{hiddenStepCount === 1 ? "" : "s"} not shown.{" "}
            <Link href="/signup" className="text-teal-700 hover:underline dark:text-teal-300">
              View the full conversation in Atlas
              <ArrowUpRight className="ml-0.5 inline h-3 w-3" aria-hidden="true" />
            </Link>
          </p>
        )}
      </main>

      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}
