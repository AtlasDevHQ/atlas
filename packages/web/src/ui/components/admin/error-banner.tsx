"use client";

import { Button } from "@/components/ui/button";

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="m-6 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 flex items-center justify-between gap-4">
      <p className="text-sm text-red-800 dark:text-red-300">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}
