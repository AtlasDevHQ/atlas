"use client";

import type { Conversation } from "../../lib/types";
import { ConversationItem } from "./conversation-item";

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  onStar,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<boolean>;
  onStar: (id: string, starred: boolean) => Promise<boolean>;
}) {
  if (conversations.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
        No conversations yet
      </div>
    );
  }

  const starred = conversations.filter((c) => c.starred);
  const unstarred = conversations.filter((c) => !c.starred);

  return (
    <div className="space-y-1">
      {starred.length > 0 && (
        <>
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Starred
          </div>
          {starred.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              isActive={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
              onDelete={() => onDelete(c.id)}
              onStar={(s) => onStar(c.id, s)}
            />
          ))}
          {unstarred.length > 0 && (
            <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Recent
            </div>
          )}
        </>
      )}
      {unstarred.map((c) => (
        <ConversationItem
          key={c.id}
          conversation={c}
          isActive={c.id === selectedId}
          onSelect={() => onSelect(c.id)}
          onDelete={() => onDelete(c.id)}
          onStar={(s) => onStar(c.id, s)}
        />
      ))}
    </div>
  );
}
