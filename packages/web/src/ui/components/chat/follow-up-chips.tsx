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
    <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Suggested follow-up questions">
      {suggestions.map((s, i) => (
        <Button
          key={`${i}-${s}`}
          variant="outline"
          size="sm"
          className="h-auto rounded-full px-3 py-1.5 text-xs font-normal"
          onClick={() => onSelect(s)}
        >
          {s}
        </Button>
      ))}
    </div>
  );
}
