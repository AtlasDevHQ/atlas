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
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  indent?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted text-muted-foreground hover:text-foreground",
      )}
      style={{ paddingLeft: `${8 + indent * 16}px` }}
    >
      <File className="size-4 shrink-0 opacity-60" />
      <span className="truncate">{name}</span>
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
  className,
}: SemanticFileTreeProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="border-b px-4 py-3">
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
