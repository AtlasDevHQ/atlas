"use client";

import { Pin, PinOff } from "lucide-react";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
import { Button } from "@/components/ui/button";

export interface StarterPromptListProps {
  /** Resolved prompt list from `/api/v1/starter-prompts`. */
  prompts: readonly StarterPrompt[];
  /** Invoked with the prompt text when the user clicks a prompt chip. */
  onSelect: (text: string) => void;
  /**
   * Optional unpin handler for favorite prompts. When provided, a hover
   * affordance renders on rows with `provenance === "favorite"`. Receives
   * the namespaced id (e.g. `favorite:<uuid>`) — the caller owns stripping
   * the prefix for the DELETE endpoint.
   */
  onUnpin?: (favoriteId: string) => void;
  /**
   * When true, suppress the cold-start CTA — the caller is still fetching
   * and we don't want to flash the "Ask your first question" message.
   */
  isLoading?: boolean;
  /** Overrides the default cold-start message when the list is empty. */
  coldStartMessage?: string;
}

/**
 * Shared rendering for the adaptive starter-prompt grid.
 *
 * Used by the chat empty state (`AtlasChat`) and the notebook new-cell
 * empty state (`NotebookEmptyState`) so provenance badges and cold-start
 * behavior stay in lockstep across surfaces. Pure presentation — the
 * caller owns fetching, pin/unpin mutation, and any surrounding copy.
 */
export function StarterPromptList({
  prompts,
  onSelect,
  onUnpin,
  isLoading = false,
  coldStartMessage,
}: StarterPromptListProps) {
  if (prompts.length === 0) {
    if (isLoading) return null;
    return (
      <p className="max-w-sm text-center text-sm text-zinc-500 dark:text-zinc-500">
        {coldStartMessage ??
          "Ask your first question below — we'll learn from your team's queries and surface their best starters here."}
      </p>
    );
  }

  return (
    <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
      {prompts.map((prompt) => {
        const isFavorite = prompt.provenance === "favorite";
        const isPopular = prompt.provenance === "popular";
        const canUnpin = isFavorite && onUnpin !== undefined;
        return (
          <div
            key={prompt.id}
            className="group relative"
            data-testid={`starter-prompt-${prompt.provenance}`}
          >
            <Button
              variant="outline"
              onClick={() => onSelect(prompt.text)}
              className="h-auto w-full whitespace-normal justify-start rounded-lg px-3 py-2.5 pr-9 text-left text-sm"
            >
              {isFavorite && (
                <Pin
                  className="mr-2 size-3.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
              )}
              <span className="flex-1">{prompt.text}</span>
              {isPopular && (
                <span
                  className="ml-2 shrink-0 rounded-sm bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  aria-label="Popular prompt"
                  data-testid="starter-prompt-popular-badge"
                >
                  Popular
                </span>
              )}
            </Button>
            {canUnpin && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin(prompt.id);
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label={`Unpin "${prompt.text}"`}
                data-testid="unpin-favorite"
              >
                <PinOff className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
