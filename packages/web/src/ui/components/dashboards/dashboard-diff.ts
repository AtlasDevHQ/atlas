/**
 * Visual diff helpers for the Publish modal (#2521).
 *
 * Pure functions — no React, no fetch. Given a published `DashboardWithCards`
 * and a draft `DashboardWithCards` (the materialized view returned by
 * `GET /:id/draft`), compute the user-facing change set:
 *
 *   - added: cards present in the draft, absent from published
 *   - removed: cards present in published, absent from the draft —
 *     populated when the user has accepted a `removeCard` stage (#2365)
 *     that the apply path dropped from the draft snapshot
 *   - changed: cards present in both, with at least one field differing
 *     (title / sql / chartConfig / content / connectionGroupId / layout)
 *   - meta: title / description diff (independent of card-level diff)
 *
 * Card identity is by `id` — the bound editor tools mint UUIDs on insert
 * so a "card I added in this draft" survives the round-trip. The diff
 * is therefore stable across re-renders and the modal can show the same
 * card-level breakdown every time.
 */

import type { DashboardWithCards, DashboardCard } from "@/ui/lib/types";

export type CardFieldChange =
  | { field: "title"; before: string; after: string }
  | { field: "sql"; before: string; after: string }
  | { field: "chartType"; before: string | null; after: string | null }
  // #3138 — a text / section-block card's markdown body.
  | { field: "content"; before: string; after: string }
  | { field: "connectionGroup"; before: string | null; after: string | null }
  | { field: "layout"; before: string; after: string };

export interface ChangedCardDiff {
  cardId: string;
  /** Use the draft's title (matches what the user will see post-publish). */
  title: string;
  changes: CardFieldChange[];
}

export interface DashboardDiff {
  added: DashboardCard[];
  removed: DashboardCard[];
  changed: ChangedCardDiff[];
  meta: {
    title: { changed: boolean; before: string; after: string };
    description: { changed: boolean; before: string | null; after: string | null };
  };
  /** True when nothing visibly changed — Publish should disable in this state. */
  empty: boolean;
}

export function diffDashboards(
  published: DashboardWithCards,
  draft: DashboardWithCards,
): DashboardDiff {
  const publishedById = new Map(published.cards.map((c) => [c.id, c] as const));
  const draftById = new Map(draft.cards.map((c) => [c.id, c] as const));

  const added: DashboardCard[] = [];
  const removed: DashboardCard[] = [];
  const changed: ChangedCardDiff[] = [];

  for (const dCard of draft.cards) {
    const pCard = publishedById.get(dCard.id);
    if (!pCard) {
      added.push(dCard);
      continue;
    }
    const fieldChanges = diffCard(pCard, dCard);
    if (fieldChanges.length > 0) {
      changed.push({ cardId: dCard.id, title: dCard.title, changes: fieldChanges });
    }
  }

  for (const pCard of published.cards) {
    if (!draftById.has(pCard.id)) {
      removed.push(pCard);
    }
  }

  const titleChanged = published.title !== draft.title;
  const descriptionChanged = (published.description ?? null) !== (draft.description ?? null);

  const empty =
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    !titleChanged &&
    !descriptionChanged;

  return {
    added,
    removed,
    changed,
    meta: {
      title: { changed: titleChanged, before: published.title, after: draft.title },
      description: {
        changed: descriptionChanged,
        before: published.description ?? null,
        after: draft.description ?? null,
      },
    },
    empty,
  };
}

function diffCard(before: DashboardCard, after: DashboardCard): CardFieldChange[] {
  const changes: CardFieldChange[] = [];
  if (before.title !== after.title) {
    changes.push({ field: "title", before: before.title, after: after.title });
  }
  if (before.sql !== after.sql) {
    changes.push({ field: "sql", before: before.sql, after: after.sql });
  }
  const beforeType = before.chartConfig?.type ?? null;
  const afterType = after.chartConfig?.type ?? null;
  if (beforeType !== afterType) {
    changes.push({ field: "chartType", before: beforeType, after: afterType });
  }
  // #3138 — a text card's only substantive field is its markdown. Without this
  // arm a content-only edit produces zero changes, so the Publish gate would
  // mark the draft `empty` and block a section-header edit that the server's
  // `cardEquals` (in dashboard-versioning.ts) does treat as a change.
  if ((before.content ?? "") !== (after.content ?? "")) {
    changes.push({ field: "content", before: before.content ?? "", after: after.content ?? "" });
  }
  if ((before.connectionGroupId ?? null) !== (after.connectionGroupId ?? null)) {
    changes.push({
      field: "connectionGroup",
      before: before.connectionGroupId ?? null,
      after: after.connectionGroupId ?? null,
    });
  }
  // Layout is a small JSON; stringify for a stable equality check. The
  // surface that renders it shows "moved or resized" rather than
  // before/after coordinates, so we don't need a structural diff here.
  const beforeLayout = before.layout ? JSON.stringify(before.layout) : "";
  const afterLayout = after.layout ? JSON.stringify(after.layout) : "";
  if (beforeLayout !== afterLayout) {
    changes.push({ field: "layout", before: beforeLayout, after: afterLayout });
  }
  return changes;
}

/** Short human-readable summary of a field change for the modal row label. */
export function describeFieldChange(change: CardFieldChange): string {
  switch (change.field) {
    case "title":
      return `Title: "${change.before}" → "${change.after}"`;
    case "sql":
      return "SQL query updated";
    case "chartType":
      return `Chart type: ${change.before ?? "none"} → ${change.after ?? "none"}`;
    case "content":
      return "Section text updated";
    case "connectionGroup":
      return change.after
        ? `Connection group changed`
        : `Connection group cleared`;
    case "layout":
      return "Moved or resized";
  }
}
