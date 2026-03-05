"use client";

import { Loader2 } from "lucide-react";

export function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm">{message}</span>
      </div>
    </div>
  );
}
