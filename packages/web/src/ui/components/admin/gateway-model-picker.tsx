"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronsUpDown, Sparkles, Loader2, RefreshCw } from "lucide-react";
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
  /** Forwarded to the trigger button so a `<Label htmlFor>` can name it. */
  id?: string;
  /** Trigger text when `value` is blank; defaults to "Pick a model". */
  placeholder?: string;
  models: GatewayCatalogModel[];
  value: string;
  onChange: (modelId: string) => void;
  loading?: boolean;
  /** Gateway unreachable — the server returned its bundled subset. */
  fallback?: boolean;
  /**
   * The catalog request itself failed (auth, 5xx, schema mismatch), so there
   * is no list at all. Distinct from `fallback`, which still yields a usable
   * short list. Without this the picker rendered enabled and empty with no
   * explanation (#4869 review).
   */
  failed?: boolean;
  disabled?: boolean;
  /** Optional retry handler — surfaced when `fallback` or `failed` is true. */
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

/**
 * Models that can actually drive Atlas's agent loop (#4869).
 *
 * NOT the only enforcement point any more. This used to be a browser-only
 * filter while `PUT /admin/model-config` accepted any string, so the old
 * comment calling it "the whole guard" was wrong; the API now applies the same
 * predicate server-side (#4869 review).
 *
 * Deliberately duplicated rather than shared through `@useatlas/types`: that
 * package is published and the scaffold templates pin a released range, so a
 * symbol added in an unpublished version fails the scaffold smoke tests. The
 * server-side twin is `isSelectableGatewayModel` in
 * `packages/api/src/lib/gateway-catalog.ts`; both carry the same behavior
 * tests, so a drift fails a test rather than shipping a picker that offers a
 * model the API rejects.
 *
 * Two gates:
 *  - `type === "language"` — the gateway also serves embedding, image, video,
 *    reranking, transcription, realtime, speech, and anything it adds next
 *    (normalized to `other`). Every BYOT direct-provider catalog hardcodes
 *    `"language"`, so this is a no-op there.
 *  - `supportsTools !== false` — `null` means the catalog didn't say, which is
 *    NOT "no"; the BYOT catalogs publish no capability data at all.
 */
export function isSelectable(model: GatewayCatalogModel): boolean {
  return model.type === "language" && model.supportsTools !== false;
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
  id,
  placeholder,
  models,
  value,
  onChange,
  loading,
  fallback,
  failed,
  disabled,
  onRetry,
}: GatewayModelPickerProps) {
  const [open, setOpen] = useState(false);

  const selectable = models.filter(isSelectable);
  const recommended = selectable.filter((m) => m.recommended);
  const others = selectable.filter((m) => !m.recommended);
  const grouped = groupByProvider(others);
  // Resolved against the FULL list, not `selectable`: a workspace that saved a
  // model before this filter existed (or via the API directly) must still see
  // its own selection rendered by name instead of degrading to a raw ID.
  const selected = models.find((m) => m.id === value) ?? null;
  // ...and if that saved model can't drive the agent loop, say so. Silently
  // hiding it from the list while leaving it configured is the worst of both.
  const selectedUnusable = selected !== null && !isSelectable(selected);
  // A configured id the LIVE catalog doesn't carry: a version the gateway has
  // retired, which every turn will now fail on. #4870 removed the version
  // roll-forward that used to paper over this (correctly — silently relabelling
  // a 4.7 as "4.8" is its own lie), but replaced it with no signal at all, so
  // the row just showed a raw ID (#4869 review). Suppressed while loading, on
  // the fallback manifest, and on a failed fetch — in all three cases absence
  // from `models` says nothing about the model.
  const selectedMissing =
    value !== "" && selected === null && !loading && !fallback && !failed && models.length > 0;

  const buttonLabel = selected
    ? selected.name
    : value
      ? value
      : loading
        ? "Loading catalog…"
        : (placeholder ?? "Pick a model");

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="AI model"
            disabled={disabled || loading || failed}
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
      {selectedMissing && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>
            <span className="font-mono">{value}</span> isn&apos;t in the gateway catalog
            any more — it was probably retired. Turns on it will fail until you pick
            another model.
          </span>
        </p>
      )}
      {selectedUnusable && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>
            <span className="font-mono">{selected?.id}</span> can&apos;t call tools, so it
            can&apos;t run queries or read the semantic layer. Pick another model.
          </span>
        </p>
      )}
      {failed && (
        <div className="flex items-center gap-2 text-[11px] text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          <span>Couldn&apos;t load the model catalog. Your current model is unchanged.</span>
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
      {!failed && fallback && (
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
