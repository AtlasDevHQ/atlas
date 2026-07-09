"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import {
  QueueFilterRow,
  RelativeTimestamp,
} from "@/ui/components/admin/queue";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import {
  CrmOutboxListResponseSchema,
  CrmOutboxRowDetailSchema,
} from "@/ui/lib/admin-schemas";
import type { CrmOutboxRow, OutboxStatus } from "@/ui/lib/types";
import { crmOutboxSearchParams } from "./search-params";
import {
  CheckCircle2,
  Inbox,
  Loader2,
  RotateCcw,
  Skull,
  Timer,
  XCircle,
} from "lucide-react";

// ── Filter constants ─────────────────────────────────────────────────

type StatusFilter = "all" | OutboxStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "in_flight", label: "In flight" },
  { value: "done", label: "Done" },
  { value: "dead", label: "Dead" },
];

// ── Status badge ─────────────────────────────────────────────────────

function statusBadge(status: OutboxStatus) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
          <Timer className="size-3" />
          Pending
        </Badge>
      );
    case "in_flight":
      return (
        <Badge variant="outline" className="gap-1 border-primary/50 text-primary">
          <Loader2 className="size-3 animate-spin" />
          In flight
        </Badge>
      );
    case "done":
      return (
        <Badge variant="outline" className="gap-1 border-green-500 text-green-600">
          <CheckCircle2 className="size-3" />
          Done
        </Badge>
      );
    case "dead":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="size-3" />
          Dead
        </Badge>
      );
  }
}

// ── Main Page ────────────────────────────────────────────────────────

export default function CrmOutboxPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <CrmOutboxPageContent />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function CrmOutboxPageContent() {
  // URL-backed filter state — `since` carries a UTC ISO timestamp so a
  // deep-linked URL means the same window regardless of the
  // operator's local zone. The text-input `<datetime-local>` operates
  // on a local-time mirror; conversion happens at the seam.
  const [{ status: statusFilter, eventType: eventTypeFilter, since: sinceUtc, selectedId }, setParams] =
    useQueryStates(crmOutboxSearchParams);
  const setStatusFilter = (next: StatusFilter) =>
    setParams({ status: next });
  const setEventTypeFilter = (next: string) =>
    setParams({ eventType: next });
  const sinceLocal = sinceUtc ? utcIsoToLocalInput(sinceUtc) : "";
  const setSinceLocal = (local: string) =>
    setParams({ since: local ? localInputToUtcIso(local) : "" });
  const setSelectedId = (next: string | null) =>
    setParams({ selectedId: next });

  // Confirm-dialog state stays local — these are transient UI
  // primitives, not shareable application state.
  const [retryConfirmId, setRetryConfirmId] = useState<string | null>(null);
  const [markDeadConfirmId, setMarkDeadConfirmId] = useState<string | null>(null);

  // Empty filters are intentionally NOT sent so the API's
  // `IS NULL OR …` predicates skip them server-side.
  const listPath = (() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (eventTypeFilter.trim()) params.set("event_type", eventTypeFilter.trim());
    if (sinceUtc) params.set("since", sinceUtc);
    const qs = params.toString();
    return qs ? `/api/v1/platform/crm-outbox?${qs}` : "/api/v1/platform/crm-outbox";
  })();

  const {
    data,
    loading,
    error,
    refetch,
  } = useAdminFetch(listPath, { schema: CrmOutboxListResponseSchema });

  const { data: detail, loading: detailLoading } = useAdminFetch(
    selectedId ? `/api/v1/platform/crm-outbox/${selectedId}` : "",
    {
      schema: CrmOutboxRowDetailSchema,
      enabled: !!selectedId,
    },
  );

  const {
    mutate: retryMutate,
    saving: retrying,
    error: retryError,
  } = useAdminMutation({ invalidates: refetch });
  const {
    mutate: markDeadMutate,
    saving: markingDead,
    error: markDeadError,
  } = useAdminMutation({ invalidates: refetch });

  const rows: CrmOutboxRow[] = data?.rows ?? [];
  const counts = { pending: 0, in_flight: 0, done: 0, dead: 0 };
  for (const r of rows) counts[r.status]++;

  // Both handlers keep the dialog open on failure so the FetchError
  // surfaces in the dialog body via `MutationErrorSurface`. Closing
  // the dialog unconditionally would silently hide 400 `race_lost`
  // (concurrent retry won), 400 `invalid_state` (stale list), 404
  // `not_found` (row purged), and 500 internal errors — exactly the
  // signals an operator at this surface needs to see.
  async function handleRetry() {
    if (!retryConfirmId) return;
    const result = await retryMutate({
      path: `/api/v1/platform/crm-outbox/${retryConfirmId}/retry`,
      method: "POST",
    });
    if (result.ok) setRetryConfirmId(null);
  }

  async function handleMarkDead() {
    if (!markDeadConfirmId) return;
    const result = await markDeadMutate({
      path: `/api/v1/platform/crm-outbox/${markDeadConfirmId}/mark-dead`,
      method: "POST",
    });
    if (result.ok) setMarkDeadConfirmId(null);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CRM Outbox</h1>
          <p className="text-muted-foreground">
            Inspect and recover marketing-funnel leads dispatched to Twenty.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Pending: <strong>{counts.pending}</strong></span>
          <span>In flight: <strong>{counts.in_flight}</strong></span>
          <span>Dead: <strong className="text-destructive">{counts.dead}</strong></span>
          <span>Done: <strong>{counts.done}</strong></span>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <QueueFilterRow
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <div className="grid gap-1.5">
          <Label htmlFor="event-type-filter" className="text-xs">
            Event type
          </Label>
          <Input
            id="event-type-filter"
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            placeholder="e.g. demo, sales-form, signup"
            className="h-8 w-56"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="since-filter" className="text-xs">
            Since
          </Label>
          <Input
            id="since-filter"
            type="datetime-local"
            value={sinceLocal}
            onChange={(e) => setSinceLocal(e.target.value)}
            className="h-8 w-56"
          />
        </div>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="CRM Outbox"
        onRetry={refetch}
        loadingMessage="Loading outbox rows..."
        emptyIcon={Inbox}
        emptyTitle="No rows match these filters"
        emptyDescription="Try clearing the filters or check back after the next flusher tick."
        isEmpty={rows.length === 0}
      >
        <Card className="shadow-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Twenty IDs</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="whitespace-nowrap font-medium">
                    <RelativeTimestamp iso={row.createdAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.eventType}
                  </TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.attempts}
                  </TableCell>
                  <TableCell className="max-w-[28rem]">
                    {row.lastError ? (
                      <span className="line-clamp-2 text-xs text-destructive">
                        {row.lastError}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {row.twentyPersonId ? (
                      <div>P: {row.twentyPersonId.slice(0, 8)}…</div>
                    ) : null}
                    {row.twentyNoteId ? (
                      <div>N: {row.twentyNoteId.slice(0, 8)}…</div>
                    ) : null}
                    {!row.twentyPersonId && !row.twentyNoteId ? "—" : null}
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {row.status === "dead" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRetryConfirmId(row.id)}
                        title="Retry now"
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                    ) : null}
                    {row.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setMarkDeadConfirmId(row.id)}
                        title="Mark dead"
                      >
                        <Skull className="size-4" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </AdminContentWrapper>

      {/* Detail sheet */}
      <Sheet
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) void setSelectedId(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Outbox row detail</SheetTitle>
            <SheetDescription>
              Full payload and untruncated error for forensic review.
            </SheetDescription>
          </SheetHeader>
          {detailLoading ? (
            <LoadingState message="Loading row..." />
          ) : detail ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Field label="ID" value={detail.id} mono />
                <Field label="Status" value={detail.status} />
                <Field label="Event type" value={detail.eventType} mono />
                <Field label="Attempts" value={String(detail.attempts)} />
                <Field label="Created" value={detail.createdAt} />
                <Field label="Processed" value={detail.processedAt ?? "—"} />
                <Field
                  label="Retry after"
                  value={detail.retryAfter ?? "—"}
                />
                <Field label="Claimed at" value={detail.claimedAt ?? "—"} />
                <Field
                  label="Twenty Person ID"
                  value={detail.twentyPersonId ?? "—"}
                  mono
                />
                <Field
                  label="Twenty Note ID"
                  value={detail.twentyNoteId ?? "—"}
                  mono
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
                  Payload
                </Label>
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </div>
              <div>
                <Label className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
                  Last error
                </Label>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs text-destructive">
                  {detail.fullLastError ?? "—"}
                </pre>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                {detail.status === "dead" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRetryConfirmId(detail.id)}
                  >
                    <RotateCcw className="mr-2 size-4" />
                    Retry now
                  </Button>
                ) : null}
                {detail.status === "pending" ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setMarkDeadConfirmId(detail.id)}
                  >
                    <Skull className="mr-2 size-4" />
                    Mark dead
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Row not found.</p>
          )}
        </SheetContent>
      </Sheet>

      {/* Retry confirm */}
      <AlertDialog
        open={!!retryConfirmId}
        onOpenChange={(open) => {
          if (!open) setRetryConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry this row?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset the row's status to <code>pending</code> and clear
              its last error. <strong>Attempts is intentionally NOT reset</strong>
              {" "}— the deterministic backoff continues from where it left off,
              so a permanently-broken upstream call can&apos;t be ground into a
              tight retry loop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorSurface error={retryError} feature="CRM Outbox" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRetry} disabled={retrying}>
              {retrying ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Retrying...
                </>
              ) : (
                "Retry now"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark-dead confirm */}
      <AlertDialog
        open={!!markDeadConfirmId}
        onOpenChange={(open) => {
          if (!open) setMarkDeadConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this row as dead?</AlertDialogTitle>
            <AlertDialogDescription>
              The flusher will stop retrying this row. Use this when you know
              the upstream dispatch will never succeed (e.g. a malformed
              payload the dispatcher classification missed). Only
              <code>pending</code> rows can be marked dead — wait for any
              <code>in_flight</code> attempt to settle (the row returns
              to pending within seconds on transient failure) so the
              flusher&apos;s commit doesn&apos;t silently overwrite the
              manual write.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorSurface error={markDeadError} feature="CRM Outbox" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMarkDead}
              disabled={markingDead}
            >
              {markingDead ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Marking dead...
                </>
              ) : (
                "Mark dead"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <Label className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <div className={mono ? "break-all font-mono text-xs" : "text-xs"}>
        {value}
      </div>
    </div>
  );
}

// `<input type="datetime-local">` operates on a naïve local-time
// string ("YYYY-MM-DDTHH:mm"). The API contract requires an RFC-3339
// timestamp with an explicit timezone offset — Codex P2 flagged that
// a naïve string would shift the filter window for any operator off
// the server's local zone. Convert at the seam so the URL state
// (and therefore the API call) is always unambiguous UTC ISO.

function localInputToUtcIso(local: string): string {
  if (!local) return "";
  const ms = Date.parse(local);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function utcIsoToLocalInput(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  // datetime-local wants local YYYY-MM-DDTHH:mm with no zone suffix;
  // pad each component so the browser parses it back into the same
  // instant.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
