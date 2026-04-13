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
        card: "summary",
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
      card: "summary",
      title,
      description,
    },
  };
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  if (!result.ok) {
    const message =
      result.reason === "not-found"
        ? "This report may have been removed or the link may be invalid."
        : result.reason === "network-error"
          ? "Could not reach the server. Check your connection and try again."
          : "This report may have expired or been deleted. Check the link and try again.";
    const heading =
      result.reason === "not-found"
        ? "Report not found"
        : result.reason === "network-error"
          ? "Connection failed"
          : "Unable to load report";
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {heading}
          </h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">{message}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Link href="/" className={buttonVariants()}>
              Go to Atlas
            </Link>
            {result.reason !== "not-found" && (
              <Link
                href={`/report/${token}`}
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

  return <ReportView conversation={result.data} />;
}
