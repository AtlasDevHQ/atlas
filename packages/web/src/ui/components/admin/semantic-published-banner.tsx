"use client";

import { PublishedBadge } from "@/ui/components/admin/mode-badges";

/**
 * Thin notice rendered above the semantic-editor file tree when an admin
 * is in developer mode, has no entity drafts, and published entities
 * exist (e.g. a seeded `__demo__` workspace). Makes "what you see is live"
 * explicit without graying out the tree — admins still need to browse
 * entities to decide what to draft.
 */
export function SemanticPublishedBanner() {
  return (
    <div
      role="note"
      data-testid="semantic-published-banner"
      className="flex items-center gap-2 border-b bg-amber-50/40 px-6 py-2.5 text-xs text-muted-foreground dark:bg-amber-950/10"
    >
      <PublishedBadge />
      <span>
        You&rsquo;re viewing the live semantic layer. Use{" "}
        <span className="font-medium">Add Entity</span> to start a draft.
      </span>
    </div>
  );
}
