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
// #4325 — the publish-diff SSOT. This client diff and the server merge
// (`@atlas/api/lib/dashboard-versioning`) consume the SAME card-equality, so a
// thresholds/colours change or a pure reorder is shown here (and publishable)
// exactly when the server treats it as a change. Do NOT re-inline a card
// comparison — the divergence (client diffed only `chartConfig.type` and never
// `position`) is the bug #4325 closes.
import { dashboardCardsEqual } from "@useatlas/schemas";

export type CardFieldChange =
  | { field: "title"; before: string; after: string }
  | { field: "sql"; before: string; after: string }
  | { field: "chartType"; before: string | null; after: string | null }
  // #4325 — a chartConfig change BEYOND `type` (thresholds / colours / columns
  // / drilldown). Stringified for a stable equality check + a generic label.
  | { field: "chartConfig"; before: string; after: string }
  // #3138 — a text / section-block card's markdown body.
  | { field: "content"; before: string; after: string }
  // #3209 — event annotations (stringified for a stable equality check).
  | { field: "annotations"; before: string; after: string }
  | { field: "connectionGroup"; before: string | null; after: string | null }
  // #4325 — a pure reorder (position change) must surface as a change.
  | { field: "position"; before: number; after: number }
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
    // #4325 — the SHARED equality is the single authority for "is this card
    // changed?", so the Publish gate here and the server's updateCard decision
    // never diverge. The field breakdown below is display detail; if the cards
    // are equal we skip regardless of what the breakdown produced.
    if (dashboardCardsEqual(pCard, dCard)) continue;
    let fieldChanges = diffCard(pCard, dCard);
    // Defensive: the breakdown covers the same fields as the equality, so this
    // is effectively unreachable — but never show a changed card with no rows.
    if (fieldChanges.length === 0) {
      fieldChanges = [{ field: "chartConfig", before: "", after: "" }];
    }
    changed.push({ cardId: dCard.id, title: dCard.title, changes: fieldChanges });
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
  } else {
    // #4325 — same type, but the rest of the config may have moved (thresholds,
    // colours, category/value columns, drilldown, KPI options). The old diff
    // compared only `type`, so those edits read as "no change" and Publish went
    // disabled on a real edit. Stringify for a stable structural check.
    const beforeCfg = before.chartConfig ? JSON.stringify(before.chartConfig) : "";
    const afterCfg = after.chartConfig ? JSON.stringify(after.chartConfig) : "";
    if (beforeCfg !== afterCfg) {
      changes.push({ field: "chartConfig", before: beforeCfg, after: afterCfg });
    }
  }
  // #3138 — a text card's only substantive field is its markdown. Without this
  // arm a content-only edit produces zero changes, so the Publish gate would
  // mark the draft `empty` and block a section-header edit that the server's
  // `cardEquals` (in dashboard-versioning.ts) does treat as a change.
  if ((before.content ?? "") !== (after.content ?? "")) {
    changes.push({ field: "content", before: before.content ?? "", after: after.content ?? "" });
  }
  // #3209 — event annotations. Without this arm an annotations-only edit
  // produces zero changes, so the Publish gate marks the draft `empty` and
  // blocks a change the server's `cardEquals` (dashboard-versioning.ts) does
  // treat as real. Stringify (normalizing absent → []) for a stable check,
  // mirroring the server-side `jsonEquals(a.annotations ?? [], ...)`.
  const beforeAnnotations = JSON.stringify(before.annotations ?? []);
  const afterAnnotations = JSON.stringify(after.annotations ?? []);
  if (beforeAnnotations !== afterAnnotations) {
    changes.push({ field: "annotations", before: beforeAnnotations, after: afterAnnotations });
  }
  if ((before.connectionGroupId ?? null) !== (after.connectionGroupId ?? null)) {
    changes.push({
      field: "connectionGroup",
      before: before.connectionGroupId ?? null,
      after: after.connectionGroupId ?? null,
    });
  }
  // #4325 — a pure reorder moves `position` only. The server's card-equality
  // treats it as a change; without this arm the modal would show a changed card
  // (gated on the shared equality) with no visible reason.
  if (before.position !== after.position) {
    changes.push({ field: "position", before: before.position, after: after.position });
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
    case "chartConfig":
      return "Chart configuration updated";
    case "position":
      return "Reordered";
    case "content":
      return "Section text updated";
    case "annotations":
      return "Event annotations updated";
    case "connectionGroup":
      return change.after
        ? `Connection group changed`
        : `Connection group cleared`;
    case "layout":
      return "Moved or resized";
  }
}
