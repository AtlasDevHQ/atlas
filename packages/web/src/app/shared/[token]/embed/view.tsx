// server-only — renders without client interactivity. The Markdown child
// component runs on the client; everything else here is static markup.
import { Markdown } from "@/ui/components/chat/markdown";
import {
  type SharedConversation,
  extractTextContent,
  truncate,
} from "../../lib";

export type EmbedTheme = "light" | "dark";

/** Resolve a `?theme=` query value to a known theme. Anything other than `dark` falls back to light. */
export function resolveEmbedTheme(raw: string | string[] | undefined): EmbedTheme {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "dark" ? "dark" : "light";
}

/**
 * Compute the embed h1 text. Title → first user message → static fallback.
 * Always returns a non-empty string so the h1 is never absent.
 */
export function resolveEmbedHeading(data: SharedConversation): string {
  if (data.title && data.title.trim().length > 0) return data.title;
  const firstUser = data.messages.find((m) => m.role === "user");
  if (firstUser) {
    const text = extractTextContent(firstUser.content).trim();
    if (text.length > 0) return truncate(text, 80);
  }
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
                    <Markdown content={text} />
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
  reason: "not-found" | "server-error" | "network-error";
  theme: EmbedTheme;
}

export function EmbedErrorView({ reason, theme }: EmbedErrorViewProps) {
  const message =
    reason === "not-found"
      ? "Conversation not found."
      : reason === "network-error"
        ? "Could not reach the server."
        : "Could not load conversation. Please try again later.";

  return (
    <EmbedShell theme={theme}>
      <h1 className="sr-only">Atlas embed unavailable</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
    </EmbedShell>
  );
}

/**
 * Outer chrome shared by success + error states. Adds `dark` to the wrapper
 * when the partner passes `?theme=dark`, gives the global skip link a target,
 * and keeps the visible chrome to a single `Atlas · Read-only` line + a small
 * "Powered by Atlas" wordmark — embed contract: attributable, never pushy.
 */
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
