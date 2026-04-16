"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { PublishedBadge } from "@/ui/components/admin/mode-badges";
import type {
  EmptyStateAction,
  ResourceLabel,
} from "./empty-state-types";

export interface PublishedContextWrapperProps {
  /** The already-rendered content (list/table of published items). */
  children: ReactNode;
  /** Singular + plural label pair — plural is used in the aria-label so
   *  irregular plurals ("entity" → "entities") render correctly. */
  resourceLabel: ResourceLabel;
  /** CTA to start drafting — either a link (navigates) or a button (opens
   *  a dialog on this page). See `EmptyStateAction`. */
  action: EmptyStateAction;
  className?: string;
}

/**
 * Renders a page's published items as grayed-out, non-interactive context
 * above a "Create draft" CTA. Used in developer mode when an admin has not
 * yet drafted anything for a resource — the current published state is still
 * visible (so the admin can see what's live) but clearly marked as read-only.
 *
 * This is purely presentational: mode detection and draft-count checks live
 * in the caller (`useDevModeNoDrafts`) so pages remain in control of when
 * to render it.
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
      aria-label={`Published ${resourceLabel.plural}, read-only while in developer mode`}
    >
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <PublishedBadge />
        <span>
          You&rsquo;re viewing the live {resourceLabel.singular} list. Create
          a draft to start editing.
        </span>
      </div>
      {/*
        `inert` removes the subtree from tab order AND the a11y tree in one
        go — pointer-events-none alone doesn't block keyboard focus, so
        without `inert` a tabbing admin could trigger row clicks or sort
        toggles on the "read-only" list. opacity-60 carries the visual
        signal; select-none blocks accidental text selection.
      */}
      <div
        className="pointer-events-none select-none opacity-60"
        inert
      >
        {children}
      </div>
      <div className="mt-4 flex justify-center">
        {action.kind === "link" ? (
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
