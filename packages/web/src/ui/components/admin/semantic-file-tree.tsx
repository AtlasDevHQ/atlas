"use client";

import { useState } from "react";
import { ChevronRight, Database, File, Folder } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";

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

/**
 * Discriminated union mirrors the API's `EntityDrift` — only `changed`
 * carries `changeCount`. Consumers narrow on `state` before reading.
 */
export type SemanticTreeDrift =
  | { readonly state: "changed"; readonly changeCount: number }
  | { readonly state: "removed" | "in-sync" | "new" };

/**
 * Entry in the file-tree's entity list. Multi-group orgs surface the
 * same `name` under multiple `connectionGroupId`s — keying off the pair
 * keeps React keys unique and lets the badge tell the admin which
 * environment a row belongs to (#2412).
 *
 * #2891: `name` is the storage key the detail / edit / delete handlers
 * look up by — `SemanticSelection.name` and the URL `?file=` param
 * must roundtrip it unchanged. `displayName` is the label rendered as
 * `<name>.yml`; falls back to `name` when missing so older API
 * responses keep rendering.
 */
export interface SemanticTreeEntity {
  readonly name: string;
  readonly displayName?: string;
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

/**
 * Display metadata for a Connection group, keyed by `id` (#3235). Joined in
 * from the admin connections list (`groupId` / `groupName` / `dbType`) so a
 * group header can read "warehouse · Snowflake · 2 members" without the
 * entities endpoint having to carry datasource type. Presence of a group in
 * the tree is driven by the entities themselves — this only enriches the
 * header — so a group with no matching connection row still renders (with
 * just its label) and the file-based mode degrades gracefully.
 */
export interface SemanticGroupMeta {
  /** `connection_group_id`; `null` is the default / unscoped group. */
  readonly id: string | null;
  /** Human label for the section header. The default group renders as "default". */
  readonly label: string;
  /** Humanized datasource type (e.g. "Postgres"), already resolved by the page. */
  readonly dbTypeLabel?: string;
  /** Number of connections in the group; omitted when unknown. */
  readonly memberCount?: number;
}

interface SemanticFileTreeProps {
  entities: ReadonlyArray<SemanticTreeEntity>;
  metricFileNames: string[];
  hasCatalog: boolean;
  hasGlossary: boolean;
  /**
   * Per-group display metadata (#3235). Optional: when omitted (or missing a
   * present group), the tree still groups entities by `connectionGroupId` and
   * synthesizes a label from the id. Multi-group orgs render one collapsible
   * section per group; a single-DB workspace (only the default group) renders
   * the flat layout with no group chrome.
   */
  groups?: ReadonlyArray<SemanticGroupMeta>;
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
    const n = drift.changeCount;
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
    const n = drift.changeCount;
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
  drift,
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  indent?: number;
  /** Quiet amber accent to signal "this is a draft" without shouting. */
  draft?: boolean;
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
  const driftFragment = driftAriaFragment(drift);
  const hasDriftBorder = !draft && driftFragment !== null;
  const ariaParts: string[] = [];
  if (draft) ariaParts.push("draft");
  if (driftFragment) ariaParts.push(driftFragment);
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

/**
 * A collapsible Connection-group section (#3235). Distinct from
 * {@link FolderSection} by the `Database` icon and the muted metadata suffix
 * ("Postgres · 2 members"), which makes "which entities belong to which
 * database" legible at a glance — replacing the per-row environment badge.
 */
function GroupSection({
  meta,
  children,
  defaultOpen = true,
}: {
  meta: SemanticGroupMeta;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const suffix = formatGroupMeta(meta);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted transition-colors"
        style={{ paddingLeft: "8px" }}
        data-testid="semantic-group-section"
        data-group-id={meta.id ?? ""}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Database className="size-4 shrink-0 opacity-60" />
        <span className="truncate">{meta.label}</span>
        {suffix ? (
          <span className="ml-1 shrink-0 truncate text-xs font-normal text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Format the "· Postgres · 2 members" header suffix; empty when nothing is known. */
function formatGroupMeta(meta: SemanticGroupMeta): string {
  const parts: string[] = [];
  if (meta.dbTypeLabel) parts.push(meta.dbTypeLabel);
  if (typeof meta.memberCount === "number" && meta.memberCount > 0) {
    parts.push(`${meta.memberCount} member${meta.memberCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? `· ${parts.join(" · ")}` : "";
}

/**
 * Stable key for a `connectionGroupId` (null = default group). Used to bucket
 * entities and to dedupe/order the rendered group sections.
 */
const DEFAULT_GROUP_KEY = " default";
function groupKey(id: string | null | undefined): string {
  return id == null ? DEFAULT_GROUP_KEY : id;
}

/**
 * True when every entity is unscoped (the default group only) — the
 * single-DB case that renders flat, with no group chrome (#3235). Zero
 * entities also reads as "flat" so the empty "entities" folder shows as today.
 */
function isSingleDefaultGroup(entities: ReadonlyArray<SemanticTreeEntity>): boolean {
  return !entities.some((e) => e.connectionGroupId != null);
}

/**
 * Order the groups present among `entities`: the default group first, then by
 * label. `groups` supplies display metadata; a present group with no metadata
 * entry is synthesized from its id so file-based-mode groups still render.
 */
function orderedGroups(
  entities: ReadonlyArray<SemanticTreeEntity>,
  groups: ReadonlyArray<SemanticGroupMeta> | undefined,
): SemanticGroupMeta[] {
  const metaByKey = new Map<string, SemanticGroupMeta>();
  for (const g of groups ?? []) metaByKey.set(groupKey(g.id), g);

  const presentKeys = new Set<string>();
  const idByKey = new Map<string, string | null>();
  for (const e of entities) {
    const key = groupKey(e.connectionGroupId);
    presentKeys.add(key);
    if (!idByKey.has(key)) idByKey.set(key, e.connectionGroupId ?? null);
  }

  const resolved: SemanticGroupMeta[] = [];
  for (const key of presentKeys) {
    const id = idByKey.get(key) ?? null;
    const meta = metaByKey.get(key);
    resolved.push(
      meta ?? { id, label: id == null ? "default" : stripGroupPrefix(id) },
    );
  }

  return resolved.toSorted((a, b) => {
    if (a.id == null) return b.id == null ? 0 : -1;
    if (b.id == null) return 1;
    return a.label.localeCompare(b.label);
  });
}

export function SemanticFileTree({
  entities,
  metricFileNames,
  hasCatalog,
  hasGlossary,
  groups,
  selection,
  onSelect,
  className,
}: SemanticFileTreeProps) {
  // #2891: render display label, route by storage key.
  const renderEntityRow = (entry: SemanticTreeEntity, indent: number) => {
    const target: SemanticSelection = {
      type: "entity",
      name: entry.name,
      connectionGroupId: entry.connectionGroupId,
    };
    return (
      <FileItem
        key={`${entry.name}|${entry.connectionGroupId ?? ""}`}
        name={`${entry.displayName ?? entry.name}.yml`}
        selected={isSelected(selection, target)}
        onClick={() => onSelect(target)}
        indent={indent}
        draft={entry.draft ?? false}
        drift={entry.drift}
      />
    );
  };

  // Single-DB (only the default group) keeps the flat "entities" folder so a
  // standalone workspace sees no added nesting; multi-group orgs split into
  // collapsible per-group sections (#3235, ADR-0012).
  const flat = isSingleDefaultGroup(entities);

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

          {flat ? (
            <FolderSection name="entities">
              {entities.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground" style={{ paddingLeft: "40px" }}>
                  No entities
                </p>
              ) : (
                entities.map((entry) => renderEntityRow(entry, 1))
              )}
            </FolderSection>
          ) : (
            orderedGroups(entities, groups).map((meta) => {
              const members = entities.filter(
                (e) => groupKey(e.connectionGroupId) === groupKey(meta.id),
              );
              return (
                <GroupSection key={groupKey(meta.id)} meta={meta}>
                  {members.map((entry) => renderEntityRow(entry, 1))}
                </GroupSection>
              );
            })
          )}

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
