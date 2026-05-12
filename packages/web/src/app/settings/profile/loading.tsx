import { Skeleton } from "@/components/ui/skeleton";

/**
 * Suspense fallback for `/settings/profile`. The route renders four
 * section-shaped cards (identity, password, MFA, sessions); mirroring that
 * skeleton-side keeps the layout from collapsing-then-jumping on first paint.
 */
export default function Loading() {
  // `role="status"` + a polite live region so screen readers announce a load
  // is in progress rather than narrate a silent stretch of decorative pulse
  // rectangles. The shadcn primitive is a bare div with no ARIA of its own
  // (packages/web/src/components/ui/skeleton.tsx), so the announcement has
  // to live on the wrapper.
  return (
    <div
      className="mx-auto max-w-3xl px-6 py-10"
      role="status"
      aria-busy
      aria-live="polite"
      aria-label="Loading profile settings"
    >
      <header className="mb-10 flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-80" />
      </header>

      <div className="space-y-10">
        <SectionSkeleton rows={2} />
        <SectionSkeleton rows={3} />
        <SectionSkeleton rows={2} />
        <SectionSkeleton rows={3} />
      </div>
    </div>
  );
}

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <section>
      <div className="mb-3 space-y-2">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <div className="flex justify-end pt-1">
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
    </section>
  );
}
