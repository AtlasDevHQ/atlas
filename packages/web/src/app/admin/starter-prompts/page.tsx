"use client";

/**
 * Read-only admin surface for the starter-prompt moderation queue.
 *
 * This page renders the `approval_status` axis (pending / approved /
 * hidden). The orthogonal `status` axis (draft / published / archived)
 * appears as a per-row badge. The canonical state-matrix explainer
 * lives with the decision policy in
 * `@atlas/api/lib/suggestions/approval-service`.
 */

import { Suspense } from "react";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Sparkles, CheckCircle2, EyeOff, Clock } from "lucide-react";
import {
  SUGGESTION_APPROVAL_STATUSES,
  SUGGESTION_STATUSES,
} from "@useatlas/types";

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

function QueueTable({
  rows,
  emptyMessage,
}: {
  rows: QueueItem[];
  emptyMessage: string;
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

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
              Read-only view. The row status badge shows the publish mode
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
              <TabsContent value="pending" className="mt-4">
                <QueueTable
                  rows={pending}
                  emptyMessage={`No suggestions have crossed the ${threshold}-click threshold within the last ${coldWindowDays} days.`}
                />
              </TabsContent>
              <TabsContent value="approved" className="mt-4">
                <QueueTable
                  rows={approved}
                  emptyMessage="No approved starter prompts yet."
                />
              </TabsContent>
              <TabsContent value="hidden" className="mt-4">
                <QueueTable
                  rows={hidden}
                  emptyMessage="No hidden starter prompts."
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
