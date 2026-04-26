import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Markdown } from "@/ui/components/chat/markdown";
import {
  fetchSharedConversation,
  extractTextContent,
  truncate,
} from "../lib";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  const fallbackTitle = "Atlas — Shared Conversation";
  const fallbackDescription =
    "A shared conversation from Atlas, the text-to-SQL data analyst.";

  if (!result.ok) {
    return {
      title: fallbackTitle,
      description: fallbackDescription,
      openGraph: {
        title: fallbackTitle,
        description: fallbackDescription,
        type: "article",
        siteName: "Atlas",
      },
      twitter: {
        card: "summary",
        title: fallbackTitle,
        description: fallbackDescription,
      },
    };
  }

  const convo = result.data;
  const firstUserMsg = convo.messages.find((m) => m.role === "user");
  const userText = firstUserMsg ? extractTextContent(firstUserMsg.content) : "";
  const title = userText
    ? `Atlas: ${truncate(userText, 60)}`
    : convo.title
      ? `Atlas: ${truncate(convo.title, 60)}`
      : fallbackTitle;

  const firstAssistantMsg = convo.messages.find((m) => m.role === "assistant");
  const assistantText = firstAssistantMsg
    ? extractTextContent(firstAssistantMsg.content)
    : "";
  const description = assistantText
    ? truncate(assistantText, 160)
    : fallbackDescription;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      siteName: "Atlas",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  if (!result.ok) {
    const message =
      result.reason === "not-found"
        ? "This conversation may have been removed or the link may be invalid."
        : result.reason === "network-error"
          ? "Could not reach the server. Check your connection and try again."
          : "This conversation may have expired or been deleted. Check the link and try again.";
    const heading =
      result.reason === "not-found"
        ? "Conversation not found"
        : result.reason === "network-error"
          ? "Connection failed"
          : "Unable to load conversation";
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {heading}
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link href="/" className={buttonVariants()}>
              Go to Atlas
            </Link>
            {result.reason !== "not-found" && (
              <Link
                href={`/shared/${token}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Try again
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  const convo = result.data;
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
                      <Markdown content={text} />
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
