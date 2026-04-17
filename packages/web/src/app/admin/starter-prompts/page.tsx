"use client";

/**
 * Admin surface for starter-prompt moderation.
 *
 * Renders the `approval_status` axis (pending / approved / hidden) with
 * per-row actions (Approve / Hide / Unhide) and an author form on the
 * Pending tab for direct seeding. The orthogonal `status` axis (draft /
 * published / archived) appears as a per-row badge. The canonical
 * state-matrix explainer lives with the decision policy in
 * `@atlas/api/lib/suggestions/approval-service`.
 */

import { Suspense, useState } from "react";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { StatCard } from "@/ui/components/admin/stat-card";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { Sparkles, CheckCircle2, EyeOff, Clock, Loader2 } from "lucide-react";
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
        const label = action === "approve" ? "Approve" : action === "hide" ? "Hide" : "Unhide";
        const variant = action === "hide" ? "outline" : "default";
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
      <div className="text-sm text-muted-foreground py-8 text-center">
        {emptyMessage}
      </div>
    );
  }

  return (
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
            <TableCell className="font-medium max-w-md truncate" title={row.description}>
              {row.description}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.clickedCount} ({row.distinctUserClicks})
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.frequency}</TableCell>
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
  );
}

// ---------------------------------------------------------------------------
// Author form — seeds the empty state without waiting for organic clicks
// ---------------------------------------------------------------------------

function AuthorForm({
  onAuthored,
}: {
  onAuthored: () => void;
}) {
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
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div>
        <label htmlFor="author-text" className="text-sm font-medium">
          Author a new starter prompt
        </label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Skips the pending queue — the prompt lands in Approved immediately
          and surfaces to users in the empty state.
        </p>
      </div>
      <Textarea
        id="author-text"
        placeholder="e.g. Which accounts renewed this quarter?"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) clearError();
        }}
        rows={2}
        disabled={saving}
        data-testid="starter-prompt-author-text"
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={saving || text.trim().length === 0}
          data-testid="starter-prompt-author-submit"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : null}
          Author prompt
        </Button>
      </div>
    </form>
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

  // Per-row mutation state — tracks which row id is currently flight so
  // the row's buttons render a spinner without locking the whole tab.
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);

  const { mutate: mutateRow } = useAdminMutation<{ suggestion: QueueItem }>({
    method: "POST",
    invalidates: refetch,
  });

  async function handleRowAction(action: RowAction, id: string) {
    setPendingRowId(id);
    try {
      await mutateRow({
        path: `/api/v1/admin/starter-prompts/${encodeURIComponent(id)}/${action}`,
        body: {},
        itemId: id,
      });
    } finally {
      setPendingRowId(null);
    }
  }

  return (
    <AdminContentWrapper loading={loading} error={error} onRetry={refetch}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Starter Prompts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review auto-promoted query suggestions before they become starter
            prompts. A suggestion enters the pending queue once {threshold} distinct
            users click it within the last {coldWindowDays} days.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            title="Pending review"
            value={pending.length}
            icon={<Clock className="w-4 h-4" />}
          />
          <StatCard
            title="Approved"
            value={approved.length}
            icon={<CheckCircle2 className="w-4 h-4" />}
          />
          <StatCard
            title="Hidden"
            value={hidden.length}
            icon={<EyeOff className="w-4 h-4" />}
          />
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-muted-foreground" />
              <CardTitle>Moderation queue</CardTitle>
            </div>
            <CardDescription>
              The row status badge shows the publish mode
              (draft / published / archived); the tab grouping shows the
              moderation state (pending / approved / hidden). The two axes
              are independent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="pending">
              <TabsList>
                <TabsTrigger value="pending">
                  Pending <span className="ml-1.5 text-xs opacity-70">({pending.length})</span>
                </TabsTrigger>
                <TabsTrigger value="approved">
                  Approved <span className="ml-1.5 text-xs opacity-70">({approved.length})</span>
                </TabsTrigger>
                <TabsTrigger value="hidden">
                  Hidden <span className="ml-1.5 text-xs opacity-70">({hidden.length})</span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="pending" className="mt-4 space-y-4">
                <div className="rounded-md border bg-muted/20 p-4">
                  <AuthorForm onAuthored={refetch} />
                </div>
                <QueueTable
                  rows={pending}
                  emptyMessage={`No suggestions have crossed the ${threshold}-click threshold within the last ${coldWindowDays} days.`}
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
          </CardContent>
        </Card>
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
