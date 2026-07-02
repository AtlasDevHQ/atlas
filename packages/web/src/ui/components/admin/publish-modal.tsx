"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  BookText,
  Database,
  FileText,
  Layers,
  Lightbulb,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  AlertCircle,
  AlertTriangle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import type { ProfileError } from "@/ui/lib/types";
import { relativeOrNull } from "./pending-changes-pill";

/**
 * A semantic layer that was profiled INCOMPLETELY — some tables failed
 * introspection below the abort threshold, so the published layer is missing
 * them (#3682). Mirrors `warnings.incompleteLayers[]` in the `/api/v1/admin/publish`
 * response. Surfaced after a publish so an admin sees the degraded state rather
 * than an unconditional success.
 */
interface IncompleteLayer {
  readonly connectionGroupId: string | null;
  readonly totalTables: number;
  readonly failedCount: number;
  readonly failedTables: ReadonlyArray<ProfileError>;
}

/** Parsed `/api/v1/admin/publish` response — only the field this modal reads. */
interface PublishResponseData {
  readonly warnings?: { readonly incompleteLayers: ReadonlyArray<IncompleteLayer> };
}

interface DraftRow {
  readonly id: string;
  readonly label: string;
  readonly updatedAt: string;
}

interface EntityEditRow extends DraftRow {
  readonly connectionGroupId: string | null;
}

interface PublishPreviewData {
  readonly connections: ReadonlyArray<DraftRow>;
  readonly entities: ReadonlyArray<DraftRow>;
  readonly entityEdits: ReadonlyArray<EntityEditRow>;
  readonly entityDeletes: ReadonlyArray<DraftRow>;
  readonly prompts: ReadonlyArray<DraftRow>;
  readonly starterPrompts: ReadonlyArray<DraftRow>;
  /** Optional: absent from an older API during a deploy-overlap window. */
  readonly knowledgeDocuments?: ReadonlyArray<DraftRow>;
}

/**
 * Confirms publish of every staged draft for the active org (#2177).
 *
 * Opens from the {@link PendingChangesPill} popover. Fetches the per-surface
 * draft inventory from `/api/v1/admin/publish-preview`, then POSTs to
 * `/api/v1/admin/publish` on confirm. Errors keep the modal open so the
 * admin sees the failure with the request id (rollback is already atomic
 * server-side — partial state is impossible).
 */
export function PublishModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { data, loading, error: previewError, refetch } = useAdminFetch<PublishPreviewData>(
    "/api/v1/admin/publish-preview",
    { enabled: open },
  );

  const { mutate, saving, error: publishError, reset } = useAdminMutation<PublishResponseData>({
    path: "/api/v1/admin/publish",
    method: "POST",
  });

  // Layers the publish just promoted that are profiled INCOMPLETELY (#3682).
  // Non-empty keeps the modal open with a warning instead of a silent success.
  const [incompleteLayers, setIncompleteLayers] = useState<ReadonlyArray<IncompleteLayer>>([]);

  // Reset error + warning state whenever the modal opens — a previous attempt
  // shouldn't leave a banner showing the next time the admin opens the modal.
  useEffect(() => {
    if (open) {
      reset();
      setIncompleteLayers([]);
    }
  }, [open, reset]);

  async function handlePublish() {
    const result = await mutate({ body: {} });
    if (result.ok) {
      // The publish committed. If any promoted layer is incomplete, keep the
      // modal open and show the durable warning the API returned (#3682) — an
      // unconditional "Published successfully" would hide that some tables are
      // now live but NOT queryable. Otherwise close as before.
      const layers = result.data?.warnings?.incompleteLayers ?? [];
      if (layers.length > 0) {
        setIncompleteLayers(layers);
        toast.warning(
          `Published, but ${layers.length === 1 ? "a layer is" : `${layers.length} layers are`} incomplete`,
        );
      } else {
        toast.success("Published successfully");
        onOpenChange(false);
      }
    }
    // On failure, leave modal open — the banner below surfaces the error.
  }

  const total = data ? totalRows(data) : 0;
  const sections = data ? buildSections(data) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish pending changes</DialogTitle>
          <DialogDescription>
            Promote {total === 1 ? "this draft" : `all ${total} drafts`} to the
            published surface visible to everyone in this workspace. The
            transaction is atomic — every change applies, or none do.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading drafts…
            </div>
          ) : previewError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <div className="flex-1">
                <div className="font-medium">Could not load draft preview</div>
                <div className="text-xs">{friendlyError(previewError)}</div>
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto p-0 text-xs"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : sections.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No pending changes to publish.
            </div>
          ) : (
            <div className="space-y-4">
              {sections.map((section) => (
                <PreviewSection key={section.key} section={section} />
              ))}
            </div>
          )}
        </div>

        {publishError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Publish failed — nothing changed</div>
              <div className="text-xs">{friendlyError(publishError)}</div>
              {publishError.requestId && (
                <div className="text-xs">Request ID: {publishError.requestId}</div>
              )}
            </div>
          </div>
        )}

        {incompleteLayers.length > 0 && (
          <IncompleteLayersBanner layers={incompleteLayers} />
        )}

        <DialogFooter>
          {incompleteLayers.length > 0 ? (
            // Publish already committed; collapse the footer to a single
            // acknowledge action so the warning above is read before closing.
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePublish}
                disabled={saving || loading || total === 0}
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" /> Publishing…
                  </>
                ) : (
                  <>Publish all{total > 0 ? ` (${total})` : ""}</>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Warns that the publish promoted one or more INCOMPLETE semantic layers —
 * tables that failed introspection are now live but NOT queryable (#3682). Read
 * from the durable `semantic_profile_status` marker, so it surfaces even when the
 * layer was profiled in a different process (web `/chat` vs a stdio MCP server).
 */
function IncompleteLayersBanner({
  layers,
}: {
  layers: ReadonlyArray<IncompleteLayer>;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          Published, but {layers.length === 1 ? "a layer is" : `${layers.length} layers are`}{" "}
          incomplete
        </p>
        <p className="opacity-90">
          Some tables failed introspection (often a permission gap) and are excluded from the
          live semantic layer — the agent can&apos;t query them. Fix access and re-profile to
          include them.
        </p>
        <ul className="space-y-1">
          {layers.map((layer) => (
            <li key={layer.connectionGroupId ?? "__default__"}>
              <span className="font-medium">
                {layer.connectionGroupId ?? "default"}
              </span>{" "}
              — {layer.failedCount} of {layer.totalTables} not queryable:
              <span className="font-mono text-[11px] opacity-80">
                {" "}
                {layer.failedTables.slice(0, 5).map((t) => t.table).join(", ")}
                {layer.failedTables.length > 5
                  ? `, … (+${layer.failedTables.length - 5} more)`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface SectionRow {
  readonly id: string;
  readonly label: string;
  readonly updatedAt: string;
  readonly intent: "create" | "update" | "delete";
}

interface Section {
  readonly key: string;
  readonly title: string;
  readonly icon: typeof Database;
  readonly rows: ReadonlyArray<SectionRow>;
}

function PreviewSection({ section }: { section: Section }) {
  const Icon = section.icon;
  return (
    <section>
      <header className="mb-1.5 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span>{section.title}</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          {section.rows.length}
        </span>
      </header>
      <ul className="divide-y rounded-md border">
        {section.rows.map((row) => (
          <li
            key={row.id + row.intent}
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            <IntentIcon intent={row.intent} />
            <span className="flex-1 truncate" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {relativeOrNull(row.updatedAt) ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IntentIcon({ intent }: { intent: SectionRow["intent"] }) {
  switch (intent) {
    case "create":
      return <Plus className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="New" />;
    case "update":
      return <Pencil className="size-4 text-amber-600 dark:text-amber-400" aria-label="Edited" />;
    case "delete":
      return <Trash2 className="size-4 text-rose-600 dark:text-rose-400" aria-label="Deleted" />;
  }
}

function totalRows(data: PublishPreviewData): number {
  return (
    data.connections.length +
    data.entities.length +
    data.entityEdits.length +
    data.entityDeletes.length +
    data.prompts.length +
    data.starterPrompts.length +
    (data.knowledgeDocuments?.length ?? 0)
  );
}

function buildSections(data: PublishPreviewData): Section[] {
  const sections: Section[] = [];

  if (data.connections.length > 0) {
    sections.push({
      key: "connections",
      title: "Connections",
      icon: Database,
      rows: data.connections.map((r) => ({ ...r, intent: "create" as const })),
    });
  }

  const entityRows: SectionRow[] = [];
  for (const r of data.entities) entityRows.push({ ...r, intent: "create" });
  for (const r of data.entityEdits) {
    const suffix = r.connectionGroupId ? ` · ${r.connectionGroupId}` : "";
    entityRows.push({
      id: r.id,
      label: `${r.label}${suffix}`,
      updatedAt: r.updatedAt,
      intent: "update",
    });
  }
  for (const r of data.entityDeletes) entityRows.push({ ...r, intent: "delete" });
  if (entityRows.length > 0) {
    sections.push({
      key: "entities",
      title: "Semantic entities",
      icon: Layers,
      rows: entityRows,
    });
  }

  if (data.prompts.length > 0) {
    sections.push({
      key: "prompts",
      title: "Prompt collections",
      icon: FileText,
      rows: data.prompts.map((r) => ({ ...r, intent: "create" as const })),
    });
  }

  if (data.starterPrompts.length > 0) {
    sections.push({
      key: "starterPrompts",
      title: "Starter prompts",
      icon: Lightbulb,
      rows: data.starterPrompts.map((r) => ({ ...r, intent: "create" as const })),
    });
  }

  if (data.knowledgeDocuments && data.knowledgeDocuments.length > 0) {
    sections.push({
      key: "knowledgeDocuments",
      title: "Knowledge documents",
      icon: BookText,
      rows: data.knowledgeDocuments.map((r) => ({ ...r, intent: "create" as const })),
    });
  }

  return sections;
}
