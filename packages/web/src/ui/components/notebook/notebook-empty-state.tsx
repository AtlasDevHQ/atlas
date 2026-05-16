"use client";

import { Button } from "@/components/ui/button";
import { EmptyAskHero } from "../empty-ask-hero";
import { StarterPromptList } from "../chat/starter-prompt-list";
import { useStarterPromptsQuery } from "@/ui/hooks/use-starter-prompts-query";

export interface NotebookEmptyStateProps {
  apiUrl: string;
  isCrossOrigin: boolean;
  getHeaders: () => Record<string, string>;
  /** Invoked with the prompt text when the user clicks a starter prompt. */
  onSelectPrompt: (text: string) => void;
  /**
   * Gates the query until the auth transport has resolved. Without this,
   * the first mount fires the request before auth headers are ready.
   */
  enabled: boolean;
}

export function NotebookEmptyState({
  apiUrl,
  isCrossOrigin,
  getHeaders,
  onSelectPrompt,
  enabled,
}: NotebookEmptyStateProps) {
  const query = useStarterPromptsQuery({
    apiUrl,
    isCrossOrigin,
    getHeaders,
    enabled,
  });
  const prompts = query.data ?? [];

  return (
    <EmptyAskHero heading="Start your analysis">
      {query.isError ? (
        // The hook intentionally throws on 4xx (auth / rate limit) so the
        // user sees a retry path rather than the generic cold-start CTA,
        // which would mask the actual failure.
        <div
          className="flex flex-col items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400"
          data-testid="starter-prompts-error"
        >
          <p>Couldn&apos;t load starter prompts.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void query.refetch(); }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <StarterPromptList
          prompts={prompts}
          onSelect={onSelectPrompt}
          isLoading={query.isLoading}
          coldStartMessage="No starters yet — your first question seeds the suggestion list."
        />
      )}
    </EmptyAskHero>
  );
}
