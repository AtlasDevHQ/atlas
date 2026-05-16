"use client";

import { useState } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type SemanticSelection =
  | { type: "catalog" }
  | { type: "glossary" }
  | {
      type: "entity";
      name: string;
      /**
       * Optional connection-group qualifier (#2412). Multi-group orgs
       * can host the same entity name in more than one environment;
       * this disambiguates which row the detail / edit / delete
       * handlers act on. `null` (legacy / global) and `undefined`
       * (caller has not chosen) are intentionally distinct.
       */
      connectionGroupId?: string | null;
    }
  | { type: "metrics"; file?: string }
  | null;

/**
 * Drift state surfaced on the file tree (#2459). `removed` and `changed`
 * paint a quiet blue 2px left border; `in-sync` paints nothing. `new`
 * isn't produced for YAML-side entities — kept here so slice 2's drawer
 * can reuse the type without a second definition.
 */
export type SemanticTreeDriftState = "new" | "removed" | "changed" | "in-sync";

export interface SemanticTreeDrift {
  readonly state: SemanticTreeDriftState;
  /** Total column-level changes; only present for `changed` rows. */
  readonly changeCount?: number;
}

/**
 * Entry in the file-tree's entity list. Multi-group orgs surface the
 * same `name` under multiple `connectionGroupId`s — keying off the pair
 * keeps React keys unique and lets the badge tell the admin which
 * environment a row belongs to (#2412).
 */
export interface SemanticTreeEntity {
  readonly name: string;
  /** Group id (e.g. `g_prod_us`) or `null` for the legacy / unscoped row. */
  readonly connectionGroupId: string | null;
  /** `true` when the row carries a draft overlay; renders the amber accent. */
  readonly draft?: boolean;
  /**
   * Optional DB↔YAML drift signal (#2459). `null` (or omitted) when no
   * drift check ran — the row paints no accent. Non-null is read-only in
   * slice 1; slice 2 wires click → drawer for reconcile.
   */
  readonly drift?: SemanticTreeDrift | null;
}

interface SemanticFileTreeProps {
  entities: ReadonlyArray<SemanticTreeEntity>;
  metricFileNames: string[];
  hasCatalog: boolean;
  hasGlossary: boolean;
  selection: SemanticSelection;
  onSelect: (selection: SemanticSelection) => void;
  className?: string;
}

function isSelected(selection: SemanticSelection, target: SemanticSelection): boolean {
  if (!selection || !target) return false;
  if (selection.type !== target.type) return false;
  if (selection.type === "entity" && target.type === "entity") {
    if (selection.name !== target.name) return false;
    // Group qualifier must also match (#2412). `null` and `undefined`
    // both mean "no scope chosen yet" and compare equal so the legacy
    // single-group flow keeps highlighting the row when group is unset.
    const a = selection.connectionGroupId ?? null;
    const b = target.connectionGroupId ?? null;
    return a === b;
  }
  if (selection.type === "metrics" && target.type === "metrics") return selection.file === target.file;
  return true;
}

function driftAriaFragment(drift: SemanticTreeDrift | null | undefined): string | null {
  if (!drift || drift.state === "in-sync") return null;
  if (drift.state === "removed") return "drift: removed from database";
  if (drift.state === "changed") {
    const n = drift.changeCount ?? 0;
    return `drift: ${n} ${n === 1 ? "column change" : "column changes"}`;
  }
  // `new` is reserved for slice 2's DB-only rows; the YAML-side tree
  // never receives it but a future caller might. Keep the fragment honest.
  return "drift: new in database";
}

function driftTooltip(drift: SemanticTreeDrift | null | undefined): string | undefined {
  if (!drift || drift.state === "in-sync") return undefined;
  if (drift.state === "removed") return "Table missing from the database";
  if (drift.state === "changed") {
    const n = drift.changeCount ?? 0;
    return `${n} column ${n === 1 ? "change" : "changes"} vs database`;
  }
  return "Table present in database but not in semantic layer";
}

function FileItem({
  name,
  selected,
  onClick,
  indent = 0,
  draft = false,
  source,
  drift,
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  indent?: number;
  /** Quiet amber accent to signal "this is a draft" without shouting. */
  draft?: boolean;
  /**
   * Optional environment label rendered as a trailing badge (#2340).
   * Group IDs from the connection-groups admin are passed in as-is —
   * stripping the `g_` prefix keeps the badge concise so multi-
   * environment orgs read "users.yml [prod]" instead of "users.yml
   * [g_prod]".
   */
  source?: string;
  /**
   * Optional drift signal (#2459). Renders a quiet blue 2px left border
   * for `removed` / `changed` rows — informational, not a call to action.
   * The amber draft accent wins border precedence when both states apply
   * (you're actively editing, so "in-progress" reads louder than
   * "DB diverged"), but the drift state still appears in aria-label +
   * native title for screen readers + hover.
   */
  drift?: SemanticTreeDrift | null;
}) {
  const sourceLabel = source?.startsWith("g_") ? source.slice(2) : source;
  const driftFragment = driftAriaFragment(drift);
  // Draft wins border precedence — see comment on the `drift` prop above.
  const hasDriftBorder = !draft && driftFragment !== null;
  const ariaParts: string[] = [];
  if (draft) ariaParts.push("draft");
  if (driftFragment) ariaParts.push(driftFragment);
  if (sourceLabel) ariaParts.push(`environment: ${sourceLabel}`);
  const ariaLabel = ariaParts.length > 0 ? `${name} (${ariaParts.join(", ")})` : undefined;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted text-muted-foreground hover:text-foreground",
        // A 2px amber left border reads as "marked" in peripheral vision but
        // doesn't change the row's baseline color/contrast — important since
        // published entities dominate the list visually.
        draft && "border-l-2 border-amber-400/60",
        // Blue is one step quieter than amber: drift is informational
        // ("DB diverged from YAML"), draft is action-pending ("you're
        // editing this"). Same 2px width keeps the rhythm consistent.
        hasDriftBorder && "border-l-2 border-sky-400/60",
      )}
      style={{ paddingLeft: `${8 + indent * 16}px` }}
      aria-label={ariaLabel}
      title={driftTooltip(drift)}
      data-drift-state={drift?.state}
    >
      <File className="size-4 shrink-0 opacity-60" />
      <span className="truncate">{name}</span>
      {sourceLabel ? (
        <span
          data-testid="entity-env-badge"
          className="ml-auto shrink-0 rounded-sm bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {sourceLabel}
        </span>
      ) : null}
    </button>
  );
}

function FolderSection({
  name,
  children,
  defaultOpen = true,
  indent = 0,
}: {
  name: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  indent?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted transition-colors"
        style={{ paddingLeft: `${8 + indent * 16}px` }}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Folder className="size-4 shrink-0 opacity-60" />
        <span className="truncate">{name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function SemanticFileTree({
  entities,
  metricFileNames,
  hasCatalog,
  hasGlossary,
  selection,
  onSelect,
  className,
}: SemanticFileTreeProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex h-[41px] items-center border-b px-4">
        <div className="flex items-center gap-2">
          <Folder className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">semantic/</span>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 p-2">
          {hasCatalog && (
            <FileItem
              name="catalog.yml"
              selected={isSelected(selection, { type: "catalog" })}
              onClick={() => onSelect({ type: "catalog" })}
            />
          )}
          {hasGlossary && (
            <FileItem
              name="glossary.yml"
              selected={isSelected(selection, { type: "glossary" })}
              onClick={() => onSelect({ type: "glossary" })}
            />
          )}

          <FolderSection name="entities">
            {entities.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground" style={{ paddingLeft: "40px" }}>
                No entities
              </p>
            ) : (
              entities.map((entry) => {
                const key = `${entry.name}|${entry.connectionGroupId ?? ""}`;
                const target: SemanticSelection = {
                  type: "entity",
                  name: entry.name,
                  connectionGroupId: entry.connectionGroupId,
                };
                return (
                  <FileItem
                    key={key}
                    name={`${entry.name}.yml`}
                    selected={isSelected(selection, target)}
                    onClick={() => onSelect(target)}
                    indent={1}
                    draft={entry.draft ?? false}
                    source={entry.connectionGroupId ?? undefined}
                    drift={entry.drift}
                  />
                );
              })
            )}
          </FolderSection>

          {metricFileNames.length > 0 && (
            <FolderSection name="metrics">
              {metricFileNames.map((file) => (
                <FileItem
                  key={file}
                  name={`${file}.yml`}
                  selected={isSelected(selection, { type: "metrics", file })}
                  onClick={() => onSelect({ type: "metrics", file })}
                  indent={1}
                />
              ))}
            </FolderSection>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
