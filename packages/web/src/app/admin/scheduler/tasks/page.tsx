"use client";

import { useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { CalendarClock, Play, Loader2 } from "lucide-react";

const SchedulerTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  running: z.boolean(),
  systemActor: z.string(),
});

const ListTasksResponseSchema = z.object({
  tasks: z.array(SchedulerTaskSchema),
});

interface TriggerResult {
  inspected: number;
  refreshed: number;
  skippedDecryptFailed: number;
  skippedInBackoff: number;
  skippedMissingKey: number;
  failed: number;
}

export default function SchedulerTasksPage() {
  const [lastRun, setLastRun] = useState<{ taskId: string; result: TriggerResult } | null>(null);

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/scheduler/tasks",
    { schema: ListTasksResponseSchema },
  );

  const { mutate: triggerByot, saving: triggering, error: triggerError, clearError } =
    useAdminMutation<TriggerResult>({
      path: "/api/v1/admin/scheduler/tasks/byot-catalog-refresh/run",
      method: "POST",
      invalidates: refetch,
    });

  async function handleTrigger(taskId: string) {
    if (triggering) return;
    setLastRun(null);
    const result = await triggerByot();
    if (result.ok && result.data) {
      setLastRun({ taskId, result: result.data });
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Scheduler Tasks</h1>
        <p className="text-sm text-muted-foreground">
          System-level background jobs. For user-created agent tasks, see{" "}
          <a href="/admin/scheduled-tasks" className="underline">Scheduled Tasks</a>.
        </p>
      </div>

      <ErrorBoundary>
        <MutationErrorSurface
          error={triggerError}
          feature="Scheduler"
          onRetry={clearError}
        />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Scheduler"
          onRetry={refetch}
          loadingMessage="Loading scheduler tasks..."
          emptyIcon={CalendarClock}
          emptyTitle="No scheduler tasks registered"
          isEmpty={!data || data.tasks.length === 0}
        >
          {data && (
            <div className="space-y-4">
              {data.tasks.map((task) => (
                <Card key={task.id} className="shadow-none">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <CalendarClock className="size-4" />
                          {task.name}
                        </CardTitle>
                        <CardDescription>{task.description}</CardDescription>
                      </div>
                      <Badge variant={task.running ? "default" : "secondary"}>
                        {task.running ? "Running" : "Stopped"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Audit actor: <code className="font-mono">{task.systemActor}</code>
                    </p>
                    {task.id === "byot-catalog-refresh" && (
                      <Button
                        size="sm"
                        onClick={() => handleTrigger(task.id)}
                        disabled={triggering}
                      >
                        {triggering ? (
                          <Loader2 className="mr-2 size-3 animate-spin" />
                        ) : (
                          <Play className="mr-2 size-3" />
                        )}
                        Run now
                      </Button>
                    )}
                    {lastRun?.taskId === task.id && (
                      <div className="rounded-md border bg-muted/30 p-3 text-sm">
                        <p className="mb-1 font-medium">Last manual run:</p>
                        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-3">
                          <li>inspected: {lastRun.result.inspected}</li>
                          <li>refreshed: {lastRun.result.refreshed}</li>
                          <li>failed: {lastRun.result.failed}</li>
                          <li>skipped (decrypt): {lastRun.result.skippedDecryptFailed}</li>
                          <li>skipped (backoff): {lastRun.result.skippedInBackoff}</li>
                          <li>skipped (missing key): {lastRun.result.skippedMissingKey}</li>
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}
