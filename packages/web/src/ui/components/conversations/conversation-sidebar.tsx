"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  const starredConversations = conversations.filter((c) => c.starred);
  const filteredConversations = filter === "saved" ? starredConversations : conversations;

  const sidebar = (
    <div className="flex h-full flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">History</span>
        <button
          onClick={onNewChat}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
        >
          + New
        </button>
      </div>

      <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <ToggleGroup
          type="single"
          size="sm"
          value={filter}
          onValueChange={(val) => { if (val) setFilter(val as SidebarFilter); }}
          className="gap-1"
        >
          <ToggleGroupItem value="all" className="px-2.5 text-xs">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="saved" className="gap-1.5 px-2.5 text-xs">
            <Star className="h-3 w-3" fill={filter === "saved" ? "currentColor" : "none"} />
            Saved
            {starredConversations.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-semibold">
                {starredConversations.length}
              </Badge>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading && conversations.length === 0 ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
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
