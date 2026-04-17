"use client";

import { useModeStatus } from "@/ui/hooks/use-mode-status";
import { cn } from "@/lib/utils";
import type { ModeDraftCounts } from "@useatlas/types/mode";

/**
 * Compact pending-changes chip rendered inside the developer-mode banner.
 *
 * Shows the number of drafts split by resource type (connections, entities,
 * prompts) so admins can see at a glance what's in flight. The underlying
 * counts come from `GET /api/v1/mode` which unions five `COUNT(*)` queries
 * over indexed `(org_id, status)` pairs — cheap enough to poll on every
 * focus via TanStack Query.
 *
 * Renders nothing when there are no drafts so the banner stays visually
 * quiet in the common "admin just toggled developer mode" case.
 */
export function PendingChangesSummary({ className }: { className?: string }) {
  const { data, loading } = useModeStatus();

  if (loading) return null;
  const counts = data?.draftCounts;
  if (!counts) return null;

  const segments = formatDraftSegments(counts);
  if (segments.length === 0) return null;

  const label = segments.join(" \u00b7 ");
  const total = totalDrafts(counts);
  const plural = total === 1 ? "change" : "changes";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-amber-950/80",
        className,
      )}
      aria-label={`${total} pending ${plural}: ${label}`}
      title={`${total} pending ${plural}: ${label}`}
    >
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">
        {total} pending
      </span>
    </span>
  );
}

/**
 * Build the display segments for a draft counts object, skipping zero
 * counts. Exposed for tests so we can assert ordering and singular/plural
 * without rendering React.
 *
 * Ordering (connections → entities → prompts → starter prompts) matches
 * the user's mental model of the publish dependency chain: connections
 * define data sources, entities expose them, prompts reference them, and
 * starter prompts are the empty-state surface. `entityEdits` and
 * `entityDeletes` fold into `entities` so the chip stays compact — the
 * full breakdown lives in the future Publish modal.
 */
export function formatDraftSegments(counts: ModeDraftCounts): string[] {
  const segments: string[] = [];
  const entityTotal = counts.entities + counts.entityEdits + counts.entityDeletes;

  if (counts.connections > 0) {
    segments.push(pluralize(counts.connections, "connection", "connections"));
  }
  if (entityTotal > 0) {
    segments.push(pluralize(entityTotal, "entity", "entities"));
  }
  if (counts.prompts > 0) {
    segments.push(pluralize(counts.prompts, "prompt", "prompts"));
  }
  if (counts.starterPrompts > 0) {
    segments.push(
      pluralize(counts.starterPrompts, "starter prompt", "starter prompts"),
    );
  }
  return segments;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function totalDrafts(counts: ModeDraftCounts): number {
  return (
    counts.connections +
    counts.entities +
    counts.entityEdits +
    counts.entityDeletes +
    counts.prompts +
    counts.starterPrompts
  );
}
