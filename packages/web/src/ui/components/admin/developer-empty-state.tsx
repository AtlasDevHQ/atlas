"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { EmptyStateAction } from "./empty-state-types";

export interface DeveloperEmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
}

/**
 * Empty state shown to admins in developer mode when they haven't drafted
 * anything yet for a given resource.
 *
 * Visually distinct from the generic `EmptyState` — an amber accent bar
 * mirrors the developer-mode banner so admins recognize this as a dev-mode
 * prompt rather than a real "no data" error. Supports either a link CTA
 * (navigates to another admin surface) or an onClick CTA (opens a dialog on
 * the current page) via the tagged `EmptyStateAction` union.
 */
export function DeveloperEmptyState({
  icon: Icon,
  title,
  description,
  action,
}: DeveloperEmptyStateProps) {
  return (
    <div
      role="status"
      data-testid="developer-empty-state"
      className="flex h-64 items-center justify-center"
    >
      <div className="max-w-md rounded-lg border border-amber-300/60 bg-amber-50/40 px-6 py-8 text-center dark:border-amber-700/40 dark:bg-amber-950/10">
        <Icon
          className="mx-auto size-10 text-amber-600 opacity-80 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
        {action && (
          <div className="mt-4">
            {action.kind === "link" ? (
              <Button asChild size="sm" variant="default">
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ) : (
              <Button size="sm" variant="default" onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
