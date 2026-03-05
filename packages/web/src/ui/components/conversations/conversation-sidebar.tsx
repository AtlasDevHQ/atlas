"use client";

import type { Conversation } from "../../lib/types";
import { ConversationList } from "./conversation-list";

export function ConversationSidebar({
  conversations,
  selectedId,
  loading,
  onSelect,
  onDelete,
  onStar,
  onNewChat,
  mobileOpen,
  onMobileClose,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<boolean>;
  onStar: (id: string, starred: boolean) => Promise<boolean>;
  onNewChat: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const sidebar = (
    <div className="flex h-full flex-col border-r border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-950/50">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">History</span>
        <button
          onClick={onNewChat}
          className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading && conversations.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          </div>
        ) : (
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            onStar={onStar}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden w-[280px] shrink-0 md:block">
        {sidebar}
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 md:hidden"
            onClick={onMobileClose}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-[280px] md:hidden">
            {sidebar}
          </div>
        </>
      )}
    </>
  );
}
