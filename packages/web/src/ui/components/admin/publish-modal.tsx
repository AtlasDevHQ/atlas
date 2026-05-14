"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import {
  Database,
  FileText,
  Layers,
  Lightbulb,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  AlertCircle,
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
import { relativeOrNull } from "./pending-changes-pill";

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

  const { mutate, saving, error: publishError, reset } = useAdminMutation<unknown>({
    path: "/api/v1/admin/publish",
    method: "POST",
  });

  // Reset error state whenever the modal opens — a previous failed attempt
  // shouldn't leave a banner showing the next time the admin opens the modal.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  async function handlePublish() {
    const result = await mutate({ body: {} });
    if (result.ok) {
      toast.success("Published successfully");
      onOpenChange(false);
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

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    data.starterPrompts.length
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

  return sections;
}
