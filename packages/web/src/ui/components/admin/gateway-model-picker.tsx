"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Sparkles, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { GatewayCatalogModel } from "@/ui/lib/types";

interface GatewayModelPickerProps {
  models: GatewayCatalogModel[];
  value: string;
  onChange: (modelId: string) => void;
  loading?: boolean;
  fallback?: boolean;
  disabled?: boolean;
  /** Optional retry handler — surfaced when `fallback` is true. */
  onRetry?: () => void;
}

interface ProviderGroup {
  provider: string;
  models: GatewayCatalogModel[];
}

function groupByProvider(models: GatewayCatalogModel[]): ProviderGroup[] {
  const groups = new Map<string, GatewayCatalogModel[]>();
  for (const model of models) {
    const existing = groups.get(model.provider);
    if (existing) {
      existing.push(model);
    } else {
      groups.set(model.provider, [model]);
    }
  }
  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, models: list }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function formatContext(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * Searchable picker over the Vercel AI Gateway catalog.
 *
 * - Recommended models surface at the top in their own group.
 * - Remaining models are grouped by provider.
 * - Search runs across model id, display name, and provider.
 */
export function GatewayModelPicker({
  models,
  value,
  onChange,
  loading,
  fallback,
  disabled,
  onRetry,
}: GatewayModelPickerProps) {
  const [open, setOpen] = useState(false);

  const recommended = models.filter((m) => m.recommended);
  const others = models.filter((m) => !m.recommended);
  const grouped = groupByProvider(others);
  const selected = models.find((m) => m.id === value) ?? null;

  const buttonLabel = selected
    ? selected.name
    : value
      ? value
      : loading
        ? "Loading catalog…"
        : "Pick a model";

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading}
            className="w-full justify-between font-mono text-sm"
          >
            <span className={cn("truncate", !selected && !value && "text-muted-foreground")}>
              {buttonLabel}
            </span>
            {loading ? (
              <Loader2 className="ml-2 size-3.5 shrink-0 animate-spin opacity-60" />
            ) : (
              <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command
            // cmdk matches against `CommandItem.value`, not rendered content.
            // ModelRow packs the searchable fields into `value` so a search
            // for "claude opus 200k" hits even though the rendered cells use
            // formatted text.
            filter={(itemValue, search) =>
              itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder="Search models…" />
            <CommandList>
              <CommandEmpty>No models match.</CommandEmpty>
              {recommended.length > 0 && (
                <CommandGroup heading="Recommended">
                  {recommended.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      selected={model.id === value}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </CommandGroup>
              )}
              {grouped.map(({ provider, models: list }) => (
                <CommandGroup key={provider} heading={provider}>
                  {list.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      selected={model.id === value}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {fallback && (
        <div className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-400">
          <RefreshCw className="size-3" />
          <span>Catalog couldn't reach the gateway — showing a curated subset.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline-offset-2 hover:underline"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ModelRowProps {
  model: GatewayCatalogModel;
  selected: boolean;
  onSelect: () => void;
}

function ModelRow({ model, selected, onSelect }: ModelRowProps) {
  const context = formatContext(model.contextWindow);
  const searchValue = [model.id, model.name, model.provider, context ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <CommandItem value={searchValue} onSelect={onSelect}>
      <div className="flex w-full items-center gap-2">
        <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{model.name}</span>
            {model.recommended && (
              <Sparkles className="size-3 shrink-0 text-amber-500" aria-label="Recommended" />
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{model.id}</div>
        </div>
        {context && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {context}
          </span>
        )}
      </div>
    </CommandItem>
  );
}
