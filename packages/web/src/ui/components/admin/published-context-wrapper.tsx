"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { PublishedBadge } from "@/ui/components/admin/mode-badges";

export interface PublishedContextWrapperProps {
  /** The already-rendered content (list/table of published items). */
  children: ReactNode;
  /** Short label describing the resource in singular form ("connection", "prompt collection"). */
  resourceLabel: string;
  /** CTA to start drafting — either an href (navigates) or onClick (opens a dialog on this page). */
  action:
    | { label: string; href: string }
    | { label: string; onClick: () => void };
  className?: string;
}

/**
 * Renders a page's published items as grayed-out, non-interactive context
 * above a "Create draft" CTA. Used in developer mode when an admin has not
 * yet drafted anything for a resource — the current published state is still
 * visible (so the admin can see what's live) but clearly marked as read-only
 * (#1436).
 *
 * This is purely presentational: mode detection and draft-count checks live
 * in the caller so pages remain in control of when to render it.
 */
export function PublishedContextWrapper({
  children,
  resourceLabel,
  action,
  className,
}: PublishedContextWrapperProps) {
  return (
    <div
      className={className}
      data-testid="published-context-wrapper"
      aria-label={`Published ${resourceLabel}s, read-only while in developer mode`}
    >
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <PublishedBadge />
        <span>
          You&rsquo;re viewing the live {resourceLabel} list. Create a draft to
          start editing.
        </span>
      </div>
      {/*
        opacity-60 + pointer-events-none signal read-only visually and
        programmatically. aria-hidden tells assistive tech to skip the list
        — the CTA below is where the admin should focus.
      */}
      <div
        className="pointer-events-none select-none opacity-60"
        aria-hidden="true"
      >
        {children}
      </div>
      <div className="mt-4 flex justify-center">
        {"href" in action ? (
          <Button asChild size="sm" variant="default">
            <Link href={action.href}>
              <Plus className="mr-1.5 size-3.5" />
              {action.label}
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="default" onClick={action.onClick}>
            <Plus className="mr-1.5 size-3.5" />
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
