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
 *
 * ---
 *
 * ## When NOT to use this wrapper
 *
 * The wrapper applies `inert + pointer-events-none + opacity-60` to its
 * subtree. That's deliberate — without `inert`, a tabbing admin would still
 * trigger row clicks or sort toggles on the "read-only" list. But it also
 * means **every button and link inside is unreachable** while the wrapper is
 * mounted. That is safe only when every mutation on the page is itself
 * publish-gated (i.e. produces a draft in developer mode, which then
 * promotes via `/api/v1/admin/publish`).
 *
 * If the page exposes any *immediate* mutation — a per-org `archived`
 * tombstone, a demo-hide that bypasses publish, a DELETE/UPDATE handler
 * that doesn't honor `atlasMode`, a connection test, a credential rotate —
 * wrapping the page traps the admin: they entered developer mode to draft
 * something, but the buttons they need to perform those non-draftable
 * actions are now behind an `inert` overlay. PR #2310 hit this exactly on
 * `/admin/connections`; the fix was to remove the wrapper, not work around
 * it.
 *
 * ### Audit snapshot (as of 2026-05 — re-verify before relying on it)
 *
 * | Page | Wrapper? | All mutations draft-aware? | Trap risk |
 * | --- | --- | --- | --- |
 * | `/admin/connections` | **removed** (#2310) | No — DELETE = per-org archived tombstone; demo-hide bypasses publish | was active; mitigated |
 * | `/admin/prompts` | yes (conditional) | Yes — CREATE/PATCH/DELETE all set `status='draft'` in dev mode | none |
 * | `/admin/semantic` | hook only (no wrapper) | Yes — entity edits/deletes go through the overlay tables | none |
 * | `/admin/schema-diff` | hook only (no wrapper) | n/a — read-only page | none |
 *
 * The table is a snapshot — the decision rule below is what's load-bearing.
 * To re-audit, list every current caller:
 *
 *     grep -rln 'PublishedContextWrapper' packages/web/src/app
 *
 * and for each hit, verify the page's mutations are all draft-publishable
 * by reading its backend route(s). If a mutation in dev mode does NOT
 * write `status='draft'` (or go through an overlay table that publish
 * promotes), the wrapper traps that action.
 *
 * ### Decision rule
 *
 *  - **Safe → wrap**: every mutation on the page is draft-publishable
 *    (`status='draft'` on insert / queued via overlay tables).
 *  - **Unsafe → don't wrap**: any immediate mutation exists (tombstones,
 *    archives, bypass-publish toggles, demo-mode probes that mutate state,
 *    operational actions like "drain pool" or "rotate credential").
 *
 * If the page is unsafe to wrap but still wants the dev-mode-no-drafts
 * banner counts to stay accurate, call `useDevModeNoDrafts(["surface"])`
 * directly — the hook drives the global banner without overlaying the
 * page. See `/admin/schema-diff/page.tsx` for the read-only variant of
 * this pattern.
 *
 * The constraint is enforced by the backend handlers, not the type system —
 * adding the wrapper to a page whose handlers mutate immediately will type-
 * check and render fine, then silently break the operator workflow. Re-run
 * the audit (or grep for `<PublishedContextWrapper>`) before adding a new
 * call site.
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
