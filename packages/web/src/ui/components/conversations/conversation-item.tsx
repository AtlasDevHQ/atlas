"use client";

import { useState } from "react";
import { Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Conversation } from "../../lib/types";
import { DeleteConfirmation } from "./delete-confirmation";

function relativeTime(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return "";
  const now = Date.now();
  const diff = now - then;

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

export function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onStar,
}: {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => Promise<boolean>;
  onStar: (starred: boolean) => Promise<boolean>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [starPending, setStarPending] = useState(false);

  if (confirmDelete) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50/50 dark:border-red-900/30 dark:bg-red-950/10">
        <DeleteConfirmation
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setDeleting(true);
            const success = await onDelete();
            setDeleting(false);
            if (success) {
              setConfirmDelete(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        isActive
          ? "bg-blue-50 text-blue-700 dark:bg-blue-600/10 dark:text-blue-400"
          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {conversation.title || "New conversation"}
        </p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {relativeTime(conversation.updatedAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={async (e) => {
            e.stopPropagation();
            if (starPending) return;
            setStarPending(true);
            await onStar(!conversation.starred);
            setStarPending(false);
          }}
          disabled={starPending}
          className={`h-6 w-6 transition-all ${
            conversation.starred
              ? "text-amber-400 opacity-100 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
              : "text-zinc-400 opacity-0 hover:text-amber-400 group-hover:opacity-100 dark:hover:text-amber-400"
          } ${starPending ? "opacity-50" : ""}`}
          aria-label={conversation.starred ? "Unstar conversation" : "Star conversation"}
        >
          <Star className="h-3.5 w-3.5" fill={conversation.starred ? "currentColor" : "none"} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(true);
          }}
          disabled={deleting}
          className="h-6 w-6 shrink-0 text-zinc-400 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-950/20 dark:hover:text-red-400"
          aria-label="Delete conversation"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
