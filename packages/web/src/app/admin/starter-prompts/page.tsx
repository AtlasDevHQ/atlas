"use client";

/**
 * Admin surface for starter-prompt moderation.
 *
 * Renders the `approval_status` axis (pending / approved / hidden) with
 * per-row actions (Approve / Hide / Unhide). The orthogonal `status`
 * axis (draft / published / archived) appears as a per-row badge. A
 * page-level "Author prompt" dialog seeds Approved directly — authored
 * rows bypass the pending queue. The canonical state-matrix explainer
 * lives with the decision policy in
 * `@atlas/api/lib/suggestions/approval-service`.
 */

import { Suspense, useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { Loader2, Plus } from "lucide-react";
import type {
  SuggestionApprovalStatus,
  SuggestionStatus,
} from "@useatlas/types";

// Inline runtime tuples. The matching `as const` arrays live in the api
// package (packages/api/src/lib/suggestions/approval-service) as the
// canonical source; we can't pull them from `@useatlas/types` because the
// scaffold template installs that package from the registry.
const SUGGESTION_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "hidden",
] as const satisfies readonly SuggestionApprovalStatus[];

const SUGGESTION_STATUSES = [
  "draft",
  "published",
  "archived",
] as const satisfies readonly SuggestionStatus[];

const QueueItemSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  description: z.string(),
  patternSql: z.string(),
  normalizedHash: z.string(),
  tablesInvolved: z.array(z.string()),
  primaryTable: z.string().nullable(),
  frequency: z.number(),
  clickedCount: z.number(),
  distinctUserClicks: z.number(),
  score: z.number(),
  approvalStatus: z.enum(SUGGESTION_APPROVAL_STATUSES),
  status: z.enum(SUGGESTION_STATUSES),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type QueueItem = z.infer<typeof QueueItemSchema>;

const QueueResponseSchema = z.object({
  pending: z.array(QueueItemSchema),
  approved: z.array(QueueItemSchema),
  hidden: z.array(QueueItemSchema),
  counts: z.object({
    pending: z.number().int(),
    approved: z.number().int(),
    hidden: z.number().int(),
  }),
  threshold: z.number().int(),
  coldWindowDays: z.number().int(),
});

type QueueResponse = z.infer<typeof QueueResponseSchema>;

type RowAction = "approve" | "hide" | "unhide";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Per-row action buttons
// ---------------------------------------------------------------------------

function RowActions({
  row,
  actions,
  onMutate,
  pending,
}: {
  row: QueueItem;
  actions: readonly RowAction[];
  onMutate: (action: RowAction, id: string) => void;
  pending: string | null;
}) {
  const isPending = pending === row.id;

  return (
    <div className="flex gap-2 justify-end">
      {actions.map((action) => {
        const label =
          action === "approve" ? "Approve" : action === "hide" ? "Hide" : "Unhide";
        const variant = action === "approve" ? "default" : "outline";
        return (
          <Button
            key={action}
            size="sm"
            variant={variant}
            disabled={isPending}
            onClick={() => onMutate(action, row.id)}
            data-testid={`starter-prompt-${action}-${row.id}`}
          >
            {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : label}
          </Button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue table (per-tab)
// ---------------------------------------------------------------------------

function QueueTable({
  rows,
  emptyMessage,
  actions,
  onMutate,
  pendingRowId,
}: {
  rows: QueueItem[];
  emptyMessage: string;
  actions: readonly RowAction[];
  onMutate: (action: RowAction, id: string) => void;
  pendingRowId: string | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/10 px-4 py-10 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Clicks (distinct)</TableHead>
            <TableHead className="text-right">Frequency</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell
                className="font-medium max-w-md truncate"
                title={row.description}
              >
                {row.description}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.clickedCount} ({row.distinctUserClicks})
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.frequency}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs capitalize">
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(row.lastSeenAt)}
              </TableCell>
              <TableCell className="text-right">
                <RowActions
                  row={row}
                  actions={actions}
                  onMutate={onMutate}
                  pending={pendingRowId}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Author dialog — seeds Approved directly (skips the pending queue)
// ---------------------------------------------------------------------------

function AuthorPromptDialog({ onAuthored }: { onAuthored: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { mutate, saving, error, clearError } = useAdminMutation<{
    suggestion: QueueItem;
  }>({
    path: "/api/v1/admin/starter-prompts/author",
    method: "POST",
    invalidates: onAuthored,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const result = await mutate({ body: { text: trimmed } });
    if (result.ok) {
      setText("");
      setOpen(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal mid-save so an in-flight failure can't
        // disappear with the dialog. `saving` already disables the
        // textarea + submit, so this only guards ESC / outside-click /
        // close-button during the request.
        if (saving && !next) return;
        setOpen(next);
        if (!next) {
          setText("");
          clearError();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid="starter-prompt-author-open"
        >
          <Plus className="size-3.5 mr-1" />
          Author prompt
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Author a starter prompt</DialogTitle>
            <DialogDescription>
              Skips the pending queue — lands in Approved immediately and
              surfaces to users in the empty state.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Starter prompt text"
            placeholder="e.g. Which accounts renewed this quarter?"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) clearError();
            }}
            rows={3}
            disabled={saving}
            autoFocus
            data-testid="starter-prompt-author-text"
          />
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              size="sm"
              disabled={saving || text.trim().length === 0}
              data-testid="starter-prompt-author-submit"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : null}
              Author prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function StarterPromptsContent() {
  const { data, loading, error, refetch } = useAdminFetch<QueueResponse>(
    "/api/v1/admin/starter-prompts/queue",
    { schema: QueueResponseSchema },
  );

  const pending = data?.pending ?? [];
  const approved = data?.approved ?? [];
  const hidden = data?.hidden ?? [];
  const threshold = data?.threshold ?? 3;
  const coldWindowDays = data?.coldWindowDays ?? 90;

  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  const { mutate: mutateRow } = useAdminMutation<{ suggestion: QueueItem }>({
    method: "POST",
    invalidates: refetch,
  });

  async function handleRowAction(action: RowAction, id: string) {
    setPendingRowId(id);
    setRowActionError(null);
    try {
      const result = await mutateRow({
        path: `/api/v1/admin/starter-prompts/${encodeURIComponent(id)}/${action}`,
        body: {},
        itemId: id,
      });
      // Surface failures (403 cross-org, 404, 500) so the admin sees why
      // the row didn't move between tabs. Without this branch, the
      // spinner stops and the UI appears to succeed.
      if (!result.ok) {
        setRowActionError(result.error);
      }
    } finally {
      setPendingRowId(null);
    }
  }

  return (
    <AdminContentWrapper loading={loading} error={error} onRetry={refetch}>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Starter Prompts
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review auto-promoted suggestions before they surface to users.
            </p>
          </div>
          <AuthorPromptDialog onAuthored={refetch} />
        </div>

        {rowActionError && (
          <div
            role="alert"
            data-testid="starter-prompt-row-action-error"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-start justify-between gap-3"
          >
            <span>{rowActionError}</span>
            <button
              type="button"
              onClick={() => setRowActionError(null)}
              className="text-xs underline opacity-70 hover:opacity-100"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}

        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">
              Pending
              <span className="ml-1.5 text-xs tabular-nums opacity-70">
                ({pending.length})
              </span>
            </TabsTrigger>
            <TabsTrigger value="approved">
              Approved
              <span className="ml-1.5 text-xs tabular-nums opacity-70">
                ({approved.length})
              </span>
            </TabsTrigger>
            <TabsTrigger value="hidden">
              Hidden
              <span className="ml-1.5 text-xs tabular-nums opacity-70">
                ({hidden.length})
              </span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="mt-4">
            <QueueTable
              rows={pending}
              emptyMessage={`No suggestions have crossed the ${threshold}-click / ${coldWindowDays}-day threshold yet. Author one directly to seed the list.`}
              actions={["approve", "hide"]}
              onMutate={handleRowAction}
              pendingRowId={pendingRowId}
            />
          </TabsContent>
          <TabsContent value="approved" className="mt-4">
            <QueueTable
              rows={approved}
              emptyMessage="No approved starter prompts yet."
              actions={["hide"]}
              onMutate={handleRowAction}
              pendingRowId={pendingRowId}
            />
          </TabsContent>
          <TabsContent value="hidden" className="mt-4">
            <QueueTable
              rows={hidden}
              emptyMessage="No hidden starter prompts."
              actions={["unhide"]}
              onMutate={handleRowAction}
              pendingRowId={pendingRowId}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AdminContentWrapper>
  );
}

export default function StarterPromptsPage() {
  return (
    <Suspense fallback={null}>
      <StarterPromptsContent />
    </Suspense>
  );
}
