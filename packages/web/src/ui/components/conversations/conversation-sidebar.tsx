"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import type { Conversation } from "../../lib/types";
import { ConversationList } from "./conversation-list";

type SidebarFilter = "all" | "saved";

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
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const starredCount = conversations.filter((c) => c.starred).length;
  const filteredConversations = filter === "saved"
    ? conversations.filter((c) => c.starred)
    : conversations;

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

      <div className="flex gap-1 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            filter === "all"
              ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter("saved")}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            filter === "saved"
              ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
          }`}
        >
          <Star className="h-3 w-3" fill={filter === "saved" ? "currentColor" : "none"} />
          Saved
          {starredCount > 0 && (
            <span className={`rounded-full px-1.5 text-[10px] font-semibold leading-4 ${
              filter === "saved"
                ? "bg-zinc-300 text-zinc-700 dark:bg-zinc-600 dark:text-zinc-200"
                : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
            }`}>
              {starredCount}
            </span>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading && conversations.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          </div>
        ) : (
          <ConversationList
            conversations={filteredConversations}
            selectedId={selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            onStar={onStar}
            showSections={filter === "all"}
            emptyMessage={filter === "saved" ? "Star conversations to save them here" : undefined}
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
