import type { Metadata } from "next";
import { extractTextContent, truncate } from "../lib";
import { ErrorShell } from "../error-shell";
import { fetchSharedConversation } from "./fetch";
import { isAuthWallReason } from "./share-result";
import { resolveConversationErrorContent } from "./error-content";
import { OrgShareResolver } from "./org-share-resolver";
import { SharedConversationView } from "./view";

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
    // The org-share auth wall. Under the SaaS cookie topology (ADR-0024) the
    // session cookie is host-only on the per-region API domain, so the RSC
    // fetch's cookie forward is structurally empty cross-origin and this SSR
    // verdict may be a false negative for a logged-in viewer. Hand off to the
    // client resolver, which retries with the viewer's browser credentials and
    // renders the same view — the #4690 login/membership split re-evaluated
    // against the viewer's REAL session (#4718/#4719). Every other failure
    // (and the public-share success path) stays pure SSR, unchanged.
    if (isAuthWallReason(result.reason)) {
      return <OrgShareResolver token={token} />;
    }
    return (
      <ErrorShell
        sharePath={`/shared/${token}`}
        content={resolveConversationErrorContent(result.reason)}
      />
    );
  }

  return <SharedConversationView convo={result.data} />;
}
