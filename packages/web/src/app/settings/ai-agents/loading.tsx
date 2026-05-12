import { Skeleton } from "@/components/ui/skeleton";

/**
 * Suspense fallback for `/settings/ai-agents`. Mirrors the rendered
 * shape so the layout doesn't collapse-then-jump on first paint.
 */
export default function Loading() {
  return (
    <div
      className="mx-auto max-w-3xl px-6 py-10"
      role="status"
      aria-busy
      aria-live="polite"
      aria-label="Loading AI Agents settings"
    >
      <header className="mb-10 flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex items-baseline justify-between gap-6">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="mt-4 h-8 w-44" />
      </header>

      <section>
        <div className="mb-3 space-y-1">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <div className="space-y-2">
          <AgentShellSkeleton />
          <AgentShellSkeleton />
        </div>
      </section>
    </div>
  );
}

function AgentShellSkeleton() {
  return (
    <section className="overflow-hidden rounded-xl border bg-card/60">
      <header className="flex items-start gap-3 p-4 pb-3">
        <Skeleton className="size-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
          <Skeleton className="h-3 w-56" />
        </div>
      </header>
      <div className="space-y-2 px-4 pb-3">
        <div className="rounded-lg border bg-muted/20 px-3 py-2 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-20" />
      </footer>
    </section>
  );
}
