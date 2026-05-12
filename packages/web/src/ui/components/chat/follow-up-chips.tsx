"use client";

import { Button } from "@/components/ui/button";

export function FollowUpChips({
  suggestions,
  onSelect,
}: {
  suggestions: string[];
  onSelect: (text: string) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label="Suggested follow-up questions">
      {suggestions.map((s, i) => (
        <Button
          key={`${i}-${s}`}
          variant="outline"
          size="sm"
          className="h-auto rounded-full border-primary/30 px-3 py-1.5 text-sm font-normal text-zinc-700 hover:border-primary/60 hover:bg-primary/5 hover:text-primary dark:text-zinc-300 dark:hover:bg-primary/10"
          onClick={() => onSelect(s)}
        >
          {s}
        </Button>
      ))}
    </div>
  );
}
