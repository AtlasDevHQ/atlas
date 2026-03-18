import type { Metadata } from "next";
import Link from "next/link";
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

  const fallbackTitle = "Atlas \u2014 Shared Conversation";
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
        : "Could not load this conversation. Please try again later.";
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {result.reason === "not-found"
              ? "Conversation not found"
              : "Something went wrong"}
          </h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Link
              href="/"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Go to Atlas
            </Link>
            {result.reason !== "not-found" && (
              <Link
                href={`/shared/${token}`}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
  const visibleMessages = convo.messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            Atlas
          </span>
          <span aria-hidden="true">&middot;</span>
          <span>Shared conversation</span>
          <span aria-hidden="true">&middot;</span>
          <time dateTime={convo.createdAt}>
            {new Date(convo.createdAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </time>
        </div>
        {convo.title && (
          <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {convo.title}
          </h1>
        )}
      </header>

      <div className="space-y-6">
        {visibleMessages.map((msg, i) => (
          <div key={i} className="flex gap-4">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
                msg.role === "user"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {msg.role === "user" ? "U" : "A"}
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {msg.role === "user" ? "User" : "Atlas"}
              </p>
              <div className="mt-1 whitespace-pre-wrap text-zinc-900 dark:text-zinc-100">
                {extractTextContent(msg.content)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
