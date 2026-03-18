"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";
import type { QuerySuggestion } from "@/ui/lib/types";

export function SuggestionChips({
  suggestions,
  onSelect,
  loading = false,
  label,
}: {
  suggestions: QuerySuggestion[];
  onSelect: (text: string, id: string) => void;
  loading?: boolean;
  label?: string;
}) {
  if (!loading && suggestions.length === 0) return null;

  return (
    <div className="space-y-2">
      {label && (
        <p className="text-xs text-muted-foreground">{label}</p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label={label ?? "Suggested queries"}>
        {loading
          ? Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-32 rounded-md" />
            ))
          : suggestions.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => onSelect(s.description, s.id)}
              >
                <Sparkles className="h-3 w-3" />
                {s.description}
              </Button>
            ))}
      </div>
    </div>
  );
}
