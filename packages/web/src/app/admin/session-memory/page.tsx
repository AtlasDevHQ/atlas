"use client";

import { Fragment, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { SessionMemoryListResponseSchema } from "@/ui/lib/admin-schemas";
import type { SessionMemoryView } from "@/ui/lib/types";
import { Brain, ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";

const FEATURE = "Session Memory" as const;

/** Render a slot value as a compact, truncated JSON preview. */
function valuePreview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    // A value that can't be stringified (shouldn't happen for JSONB-sourced
    // data) still renders something rather than crashing the row.
    text = String(value);
  }
  if (text === undefined) text = "undefined";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** A pending reset — clear a whole session (no `namespace`) or a single slot. */
type ResetTarget = {
  conversationId: string;
  label: string;
  namespace?: string;
};

export default function SessionMemoryPage() {
  return (
    <ErrorBoundary>
      <SessionMemoryPageContent />
    </ErrorBoundary>
  );
}

function SessionMemoryPageContent() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/admin/session-memory", {
    schema: SessionMemoryListResponseSchema,
  });

  const resetMutation = useAdminMutation({ method: "DELETE", invalidates: refetch });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);

  const sessions: SessionMemoryView[] = data?.sessions ?? [];

  function toggleExpanded(conversationId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }

  async function confirmReset() {
    if (!resetTarget) return;
    const qs = resetTarget.namespace ? `?namespace=${encodeURIComponent(resetTarget.namespace)}` : "";
    const result = await resetMutation.mutate({
      path: `/api/v1/admin/session-memory/${resetTarget.conversationId}${qs}`,
    });
    if (result.ok) setResetTarget(null);
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Session Memory</h1>
        <p className="text-sm text-muted-foreground">
          Durable working memory the agent has accumulated per conversation — the facts it threads into
          future turns. View what a session remembers, and reset it (a whole session or one slot) so a
          wrong remembered fact isn&apos;t sticky.
        </p>
      </div>

      <MutationErrorSurface
        error={resetMutation.error}
        feature={FEATURE}
        onRetry={resetMutation.clearError}
      />

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature={FEATURE}
        onRetry={refetch}
        isEmpty={sessions.length === 0}
        emptyIcon={Brain}
        emptyTitle="No sessions have durable memory yet"
        emptyDescription="When the agent stashes working memory during a conversation, the session appears here."
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="size-5" />
              Sessions with memory
            </CardTitle>
            <CardDescription>
              {sessions.length} session{sessions.length === 1 ? "" : "s"} in this workspace with stored
              working memory.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Session</TableHead>
                  <TableHead>Slots</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const isExpanded = expanded.has(session.conversationId);
                  return (
                    <Fragment key={session.conversationId}>
                      <TableRow className="cursor-pointer" onClick={() => toggleExpanded(session.conversationId)}>
                        <TableCell>
                          {isExpanded ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="max-w-sm truncate font-medium">
                          {session.title ?? (
                            <span className="font-mono text-xs text-muted-foreground">
                              {session.conversationId}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{session.slots.length}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <RelativeTimestamp iso={session.updatedAt} />
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setResetTarget({
                                conversationId: session.conversationId,
                                label: session.title ?? session.conversationId,
                              })
                            }
                            aria-label={`Reset memory for ${session.title ?? session.conversationId}`}
                          >
                            <Trash2 className="mr-1 size-4" />
                            Reset
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/30 p-4">
                            <SlotTable
                              session={session}
                              onResetSlot={(namespace) =>
                                setResetTarget({
                                  conversationId: session.conversationId,
                                  label: `${namespace} · ${session.title ?? session.conversationId}`,
                                  namespace,
                                })
                              }
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </AdminContentWrapper>

      <AlertDialog open={!!resetTarget} onOpenChange={(open) => !open && setResetTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resetTarget?.namespace ? "Reset this memory slot?" : "Reset all memory for this session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resetTarget?.namespace
                ? "Clears this one remembered slot. The agent re-derives it the next time it needs it."
                : "Clears every remembered slot for this conversation. The next turn threads no stale value."}
              {resetTarget && (
                <span className="mt-2 block font-mono text-xs text-muted-foreground">{resetTarget.label}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetMutation.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog mounted until the mutation resolves so a
                // failure routes through MutationErrorSurface instead of
                // vanishing with the dialog.
                e.preventDefault();
                void confirmReset();
              }}
              disabled={resetMutation.saving}
            >
              {resetMutation.saving && <Loader2 className="mr-1 size-4 animate-spin" />}
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SlotTable({
  session,
  onResetSlot,
}: {
  session: SessionMemoryView;
  onResetSlot: (namespace: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">Slot</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="whitespace-nowrap">Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {session.slots.map((slot) => (
          <TableRow key={slot.namespace}>
            <TableCell className="align-top font-mono text-xs">{slot.namespace}</TableCell>
            <TableCell className="align-top">
              <pre className="max-w-xl overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {valuePreview(slot.value)}
              </pre>
            </TableCell>
            <TableCell className="align-top whitespace-nowrap text-xs text-muted-foreground">
              <RelativeTimestamp iso={slot.updatedAt} />
            </TableCell>
            <TableCell className="align-top">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onResetSlot(slot.namespace)}
                aria-label={`Reset slot ${slot.namespace}`}
              >
                <Trash2 className="size-4 text-muted-foreground" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
