import { fetchSharedConversation, extractTextContent } from "../../lib";
import { ScrollAnchor } from "./scroll-anchor";

export default async function SharedConversationEmbedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchSharedConversation(token);

  if (!result.ok) {
    const message =
      result.reason === "not-found"
        ? "Conversation not found."
        : "Could not load conversation. Please try again later.";
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
      </div>
    );
  }

  const convo = result.data;
  const visibleMessages = convo.messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  return (
    <div className="flex min-h-screen flex-col px-3 py-4 sm:px-4">
      <div className="flex-1 space-y-4">
        {visibleMessages.map((msg, i) => (
          <div key={i} className="flex gap-3">
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                msg.role === "user"
                  ? "bg-primary/15 text-primary dark:bg-primary/20 dark:text-primary"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {msg.role === "user" ? "U" : "A"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
                {msg.role === "user" ? "User" : "Atlas"}
              </p>
              <div className="mt-0.5 whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100">
                {extractTextContent(msg.content)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* "Powered by Atlas" link — opens in a new tab */}
      <div className="mt-4 border-t border-zinc-200 pt-3 text-center dark:border-zinc-800">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          Powered by Atlas
        </a>
      </div>

      <ScrollAnchor />
    </div>
  );
}
