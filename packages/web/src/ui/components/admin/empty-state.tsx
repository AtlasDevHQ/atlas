"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  message,
  children,
}: {
  icon: LucideIcon;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-64 items-center justify-center text-muted-foreground">
      <div className="text-center">
        <Icon className="mx-auto size-10 opacity-50" />
        <p className="mt-3 text-sm">{message}</p>
        {children}
      </div>
    </div>
  );
}
