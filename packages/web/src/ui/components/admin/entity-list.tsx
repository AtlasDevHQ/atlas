"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, TableIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EntitySummary {
  name: string;
  description: string;
  type?: "table" | "view";
  columnCount: number;
  connectionId?: string;
}

export function EntityList({
  entities,
  selectedName,
  onSelect,
  className,
}: {
  entities: EntitySummary[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return entities;
    const q = search.toLowerCase();
    return entities.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [entities, search]);

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="relative px-3 pt-3 pb-2">
        <Search className="absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 p-2">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {entities.length === 0 ? "No entities found" : "No matches"}
            </p>
          )}
          {filtered.map((entity) => (
            <button
              key={entity.name}
              onClick={() => onSelect(entity.name)}
              className={cn(
                "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
                selectedName === entity.name
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted",
              )}
            >
              <TableIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{entity.name}</span>
                  {entity.type === "view" && (
                    <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                      view
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{entity.description}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {entity.columnCount} cols
                  </Badge>
                  {entity.connectionId && entity.connectionId !== "default" && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {entity.connectionId}
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
