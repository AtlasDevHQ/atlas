import { Markdown } from "@/ui/components/chat/markdown";
import {
  type SharedConversation,
  extractTextContent,
  truncate,
} from "../../lib";
import type { FailReason } from "../share-result";

export type EmbedTheme = "light" | "dark";

export function resolveEmbedTheme(raw: string | string[] | undefined): EmbedTheme {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "dark") return "dark";
  if (value == null || value === "" || value === "light") return "light";
  console.warn(
    `[shared-conversation/embed] Unrecognized ?theme= value (got ${JSON.stringify(value)}); falling back to "light".`,
  );
  return "light";
}

export function resolveEmbedHeading(data: SharedConversation): string {
  if (data.title && data.title.trim().length > 0) return data.title;
  const firstUser = data.messages.find((m) => m.role === "user");
  if (firstUser) {
    const text = extractTextContent(firstUser.content).trim();
    if (text.length > 0) return truncate(text, 80);
  }
  console.warn(
    "[shared-conversation/embed] No usable heading source (title empty + no user messages with text); using static label.",
  );
  return "Atlas Conversation";
}

interface EmbedViewProps {
  data: SharedConversation;
  theme: EmbedTheme;
}

export function EmbedView({ data, theme }: EmbedViewProps) {
  const heading = resolveEmbedHeading(data);
  const renderedMessages = data.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((msg) => ({ msg, text: extractTextContent(msg.content) }))
    .filter(({ text }) => text.trim().length > 0);

  return (
    <EmbedShell theme={theme}>
      <h1 className="sr-only">{heading}</h1>
      {renderedMessages.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This conversation has no readable content.
        </p>
      ) : (
        <div className="space-y-5">
          {renderedMessages.map(({ msg, text }, i) => {
            const isUser = msg.role === "user";
            return (
              <article
                key={i}
                className="space-y-1 print:break-inside-avoid"
                aria-label={isUser ? "User message" : "Atlas response"}
              >
                <p
                  className={`text-[10px] font-semibold uppercase tracking-wider ${
                    isUser
                      ? "text-zinc-600 dark:text-zinc-400"
                      : "text-teal-700 dark:text-teal-300"
                  }`}
                >
                  {isUser ? "User" : "Atlas"}
                </p>
                {isUser ? (
                  <p className="whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100">
                    {text}
                  </p>
                ) : (
                  <div className="text-sm text-zinc-900 dark:text-zinc-100">
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
    </EmbedShell>
  );
}

interface EmbedErrorViewProps {
  reason: FailReason;
  theme: EmbedTheme;
}

/**
 * Compact, navigation-free error state for the embed. It never renders
 * login/retry links — a link inside a partner's iframe would either dead-end
 * or hijack their frame. Revoked/expired shares surface here, which is how the
 * embed "dies" when the link does.
 */
export function EmbedErrorView({ reason, theme }: EmbedErrorViewProps) {
  // Exhaustive switch (not a ternary chain) so a future `FailReason` fails the
  // build here instead of silently rendering the generic message.
  let message: string;
  switch (reason) {
    // The embed is navigation-free (no in-frame login), so both auth reasons
    // resolve to explanatory copy rather than a CTA — but they stay DISTINCT so a
    // signed-in wrong-org viewer isn't told to "sign in" (#4690).
    case "login-required":
      message = "This conversation is shared within an organization. Sign in to Atlas to view it.";
      break;
    case "membership-required":
      message =
        "This conversation is shared within an organization you’re not a member of. Open it in Atlas with an account that has access.";
      break;
    case "expired":
      message = "This conversation share link has expired.";
      break;
    case "not-found":
      message = "Conversation not found.";
      break;
    case "network-error":
      message = "Could not reach the server.";
      break;
    case "server-error":
      message = "Could not load conversation. Please try again later.";
      break;
    default:
      reason satisfies never;
      message = "Could not load conversation. Please try again later.";
  }

  return (
    <EmbedShell theme={theme}>
      <h1 className="sr-only">Atlas embed unavailable</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
    </EmbedShell>
  );
}

// Embed contract: attributable, never pushy. Do not add a "Try Atlas" CTA
// inside the partner UX — locked in by shared-embed-view.test.tsx.
function EmbedShell({
  theme,
  children,
}: {
  theme: EmbedTheme;
  children: React.ReactNode;
}) {
  // The project's Tailwind dark variant is `&:is(.dark *)` — the element bearing
  // the `.dark` class doesn't match it; only descendants do. We wrap with an
  // outer `.dark` so the inner shell's `dark:` modifiers fire.
  return (
    <div className={theme === "dark" ? "dark" : ""} data-theme={theme}>
      <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <header className="mx-auto w-full max-w-3xl px-4 pt-4 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400">
          <span className="font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Atlas
          </span>
          <span aria-hidden="true">&middot;</span>
          <span
            className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 print:bg-transparent print:px-0"
            aria-label="This is a read-only snapshot"
          >
            Read-only
          </span>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-3 focus:outline-none print:p-0"
      >
        {children}
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 py-2 text-center print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
      </div>
    </div>
  );
}
