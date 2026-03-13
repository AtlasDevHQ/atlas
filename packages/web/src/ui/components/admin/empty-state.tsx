"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  message,
  action,
  children,
}: {
  icon: LucideIcon;
  title?: string;
  description?: string;
  /** @deprecated Use `title` instead */
  message?: string;
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  const heading = title ?? message;
  return (
    <div className="flex h-64 items-center justify-center text-muted-foreground">
      <div className="text-center">
        <Icon className="mx-auto size-10 opacity-50" />
        {heading && <p className="mt-3 text-sm font-medium">{heading}</p>}
        {description && (
          <p className="mt-1 text-xs text-muted-foreground/70">{description}</p>
        )}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-3 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
