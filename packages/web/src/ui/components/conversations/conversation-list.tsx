"use client";

import { MessageSquare, Star } from "lucide-react";
import type { Conversation } from "../../lib/types";
import { ConversationItem } from "./conversation-item";

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  onStar,
  onConvertToNotebook,
  showSections = true,
  emptyMessage,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onStar: (id: string, starred: boolean) => Promise<void>;
  onConvertToNotebook?: (id: string) => Promise<{ id: string }>;
  showSections?: boolean;
  emptyMessage?: string;
}) {
  if (conversations.length === 0) {
    const isSaved = !!emptyMessage;
    const Icon = isSaved ? Star : MessageSquare;
    return (
      <div className="flex flex-col items-center px-3 py-8 text-center">
        <Icon className="size-8 text-zinc-300 dark:text-zinc-600" />
        <p className="mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {emptyMessage ?? "No conversations yet"}
        </p>
        {!isSaved && (
          <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            Ask a question to get started
          </p>
        )}
      </div>
    );
  }

  function renderItems(items: Conversation[]) {
    return items.map((c) => (
      <ConversationItem
        key={c.id}
        conversation={c}
        isActive={c.id === selectedId}
        onSelect={() => onSelect(c.id)}
        onDelete={() => onDelete(c.id)}
        onStar={(s) => onStar(c.id, s)}
        onConvertToNotebook={onConvertToNotebook ? () => onConvertToNotebook(c.id) : undefined}
      />
    ));
  }

  if (!showSections) {
    return <div className="space-y-1">{renderItems(conversations)}</div>;
  }

  const starred = conversations.filter((c) => c.starred);
  const unstarred = conversations.filter((c) => !c.starred);

  return (
    <div className="space-y-1">
      {starred.length > 0 && (
        <>
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Starred
          </div>
          {renderItems(starred)}
          {unstarred.length > 0 && (
            <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Recent
            </div>
          )}
        </>
      )}
      {renderItems(unstarred)}
    </div>
  );
}
