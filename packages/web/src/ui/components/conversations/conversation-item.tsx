"use client";

import { useState } from "react";
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
            // On failure, keep confirmation dialog open so user sees something is wrong
          }}
        />
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      className={`group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
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
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (starPending) return;
            setStarPending(true);
            await onStar(!conversation.starred);
            setStarPending(false);
          }}
          disabled={starPending}
          className={`rounded p-1 transition-all ${
            conversation.starred
              ? "text-amber-400 opacity-100 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
              : "text-zinc-400 opacity-0 hover:text-amber-400 group-hover:opacity-100 dark:hover:text-amber-400"
          } ${starPending ? "opacity-50" : ""}`}
          aria-label={conversation.starred ? "Unstar conversation" : "Star conversation"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
            {conversation.starred ? (
              <path fillRule="evenodd" d="M8 1.75a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 13.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 7.874a.75.75 0 0 1 .416-1.28l4.21-.611L7.327 2.17A.75.75 0 0 1 8 1.75Z" clipRule="evenodd" />
            ) : (
              <path fillRule="evenodd" d="M8 1.75a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 13.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 7.874a.75.75 0 0 1 .416-1.28l4.21-.611L7.327 2.17A.75.75 0 0 1 8 1.75Zm0 2.445L6.615 7.05a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 4.196Z" clipRule="evenodd" />
            )}
          </svg>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(true);
          }}
          disabled={deleting}
          className="shrink-0 rounded p-1 text-zinc-400 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-950/20 dark:hover:text-red-400"
          aria-label="Delete conversation"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
            <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.286a1.5 1.5 0 0 0 1.492-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </button>
  );
}
