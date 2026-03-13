"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type EmptyStateProps = {
  icon: LucideIcon;
  description?: string;
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
} & ({ title: string; message?: string } | { title?: never; /** @deprecated Use `title` instead */ message: string });

export function EmptyState({
  icon: Icon,
  title,
  description,
  message,
  action,
  children,
}: EmptyStateProps) {
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
          <Button
            variant="link"
            size="xs"
            onClick={action.onClick}
            className="mt-3"
          >
            {action.label}
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
