import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  fetchSharedConversation,
  extractTextContent,
  truncate,
} from "../../shared/lib";
import { ReportView } from "./report-view";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  const fallbackTitle = "Atlas Report";
  const fallbackDescription =
    "A shared report from Atlas, the text-to-SQL data analyst.";

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
        card: "summary_large_image",
        title: fallbackTitle,
        description: fallbackDescription,
      },
    };
  }

  const convo = result.data;
  const firstUserMsg = convo.messages.find((m) => m.role === "user");
  const userText = firstUserMsg ? extractTextContent(firstUserMsg.content) : "";
  const title = convo.title
    ? `Atlas Report: ${truncate(convo.title, 55)}`
    : userText
      ? `Atlas Report: ${truncate(userText, 55)}`
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
      card: "summary_large_image",
      title,
      description,
    },
  };
}

type FailReason = "not-found" | "server-error" | "network-error";

function ReportErrorShell({
  token,
  heading,
  message,
  reason,
}: {
  token: string;
  heading: string;
  message: string;
  reason: FailReason;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 focus:outline-none"
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {heading}
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link href="/" className={buttonVariants()}>
              Go to Atlas
            </Link>
            {reason !== "not-found" && (
              <Link
                href={`/report/${token}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Try again
              </Link>
            )}
          </div>
        </div>
      </main>
      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-teal-700 transition-colors hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  if (!result.ok) {
    const heading =
      result.reason === "not-found"
        ? "Report not found"
        : result.reason === "network-error"
          ? "Connection failed"
          : "Unable to load report";
    const message =
      result.reason === "not-found"
        ? "This report may have been removed or the link may be invalid."
        : result.reason === "network-error"
          ? "We couldn’t reach Atlas. Check your connection and try again."
          : "Something went wrong on our end loading this report. Please try again in a moment.";
    return (
      <ReportErrorShell
        token={token}
        heading={heading}
        message={message}
        reason={result.reason}
      />
    );
  }

  return <ReportView conversation={result.data} />;
}
