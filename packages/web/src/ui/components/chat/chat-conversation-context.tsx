"use client";

/**
 * Chat conversation context (#4322) — exposes the current conversation id to
 * deeply-nested tool cards without threading a prop through the shared
 * `AgentTurn` → `ToolPart` seam.
 *
 * The only consumer today is `CreateDashboardCard`: its "Continue editing"
 * handoff link carries the originating conversation id so the bound drawer
 * resumes that conversation (creation-to-bound continuity) instead of
 * resetting to empty. `AtlasChat` provides the id (from the URL); the bound
 * drawer does NOT provide it, so `createDashboard` — which the bound registry
 * excludes anyway — never resolves an id there.
 *
 * Read via {@link useChatConversationId}, which returns `null` outside a
 * provider (e.g. a shared/embed view renders the same tool cards without a
 * live conversation) — the handoff link then degrades to `?openChat=true`.
 */

import { createContext, useContext } from "react";

const ChatConversationContext = createContext<string | null>(null);

export function ChatConversationProvider({
  conversationId,
  children,
}: {
  conversationId: string | null;
  children: React.ReactNode;
}) {
  return (
    <ChatConversationContext.Provider value={conversationId}>
      {children}
    </ChatConversationContext.Provider>
  );
}

/** The current conversation id, or `null` outside a provider. */
export function useChatConversationId(): string | null {
  return useContext(ChatConversationContext);
}
