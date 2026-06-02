/**
 * Pure URL helpers for the WorkspaceShell modal → chat prompt hand-off (#3081).
 * Kept side-effect-free (no React, no client-only imports) so the chat surface's
 * deep-link behavior is unit-testable without mounting the `"use client"` shell —
 * mirrors how `resolveConversationUrlAction` lives in `search-params.ts`.
 */

export function isNotebookRoute(pathname: string): boolean {
  return pathname === "/notebook" || pathname.startsWith("/notebook/");
}

/**
 * Build the prompt-delivery URL for `deliverPrompt`. On the chat / notebook
 * surfaces it preserves an active conversation deep link (`?id=`) so inserting a
 * prompt from the library / schema explorer prefills the CURRENT conversation —
 * the chat surface reads a missing `?id=` as "new chat" and would otherwise wipe
 * the open thread. Dashboards' `?id=` is a dashboard id, not a conversation, so
 * it is intentionally dropped when routing back to chat.
 */
export function buildPromptDeliveryUrl(
  pathname: string,
  conversationId: string | null,
  text: string,
): string {
  const prompt = `prompt=${encodeURIComponent(text)}`;
  const idPrefix = conversationId
    ? `id=${encodeURIComponent(conversationId)}&`
    : "";
  if (pathname === "/") return `/?${idPrefix}${prompt}`;
  if (isNotebookRoute(pathname)) return `/notebook?${idPrefix}${prompt}`;
  return `/?${prompt}`;
}
