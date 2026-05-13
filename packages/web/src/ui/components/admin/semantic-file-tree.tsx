"use client";

import { useState } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type SemanticSelection =
  | { type: "catalog" }
  | { type: "glossary" }
  | { type: "entity"; name: string }
  | { type: "metrics"; file?: string }
  | null;

interface SemanticFileTreeProps {
  entityNames: string[];
  metricFileNames: string[];
  hasCatalog: boolean;
  hasGlossary: boolean;
  selection: SemanticSelection;
  onSelect: (selection: SemanticSelection) => void;
  /**
   * Names of entities with `status === 'draft'`. Rendered with a quiet
   * amber accent so admins scanning the tree can spot unpublished edits
   * without the treatment shouting at non-draft rows (#1435).
   */
  draftEntityNames?: ReadonlySet<string>;
  /**
   * Map of entity name → environment / group label (#2340). When
   * provided, the file-tree renders a quiet trailing badge next to the
   * entity name showing the environment (e.g. `prod`). Multi-member
   * groups collapse to one row server-side; the badge tells the admin
   * which environment that row applies to.
   *
   * Entities without a source mapping render unbadged — the legacy
   * single-connection-org UX is unchanged.
   */
  entitySources?: ReadonlyMap<string, string>;
  className?: string;
}

function isSelected(selection: SemanticSelection, target: SemanticSelection): boolean {
  if (!selection || !target) return false;
  if (selection.type !== target.type) return false;
  if (selection.type === "entity" && target.type === "entity") return selection.name === target.name;
  if (selection.type === "metrics" && target.type === "metrics") return selection.file === target.file;
  return true;
}

function FileItem({
  name,
  selected,
  onClick,
  indent = 0,
  draft = false,
  source,
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
}) {
  const sourceLabel = source?.startsWith("g_") ? source.slice(2) : source;
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
      )}
      style={{ paddingLeft: `${8 + indent * 16}px` }}
      aria-label={
        sourceLabel
          ? `${name} (${draft ? "draft, " : ""}environment: ${sourceLabel})`
          : draft
            ? `${name} (draft)`
            : undefined
      }
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
  entityNames,
  metricFileNames,
  hasCatalog,
  hasGlossary,
  selection,
  onSelect,
  draftEntityNames,
  entitySources,
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
            {entityNames.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground" style={{ paddingLeft: "40px" }}>
                No entities
              </p>
            ) : (
              entityNames.map((name) => (
                <FileItem
                  key={name}
                  name={`${name}.yml`}
                  selected={isSelected(selection, { type: "entity", name })}
                  onClick={() => onSelect({ type: "entity", name })}
                  indent={1}
                  draft={draftEntityNames?.has(name) ?? false}
                  source={entitySources?.get(name)}
                />
              ))
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
