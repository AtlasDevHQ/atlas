/**
 * Dashboard versioning — per-user drafts off a published baseline (#2364).
 *
 * The chat-as-dashboard-editor PRD (#2362) gives every editor a private
 * draft of a dashboard. Edits land on the draft; publish diff-merges
 * the draft into the published row inside a single transaction. Other
 * editors' drafts are unaffected at the moment of publish — they get
 * a "your baseline has changed" signal next time they rebase.
 *
 * This module is the deep one in the slice — the highest test ROI lives
 * in the pure snapshot-in / snapshot-out functions (`forkDraftFromPublished`,
 * `applyChangeToDraft`, `publishDraftMerge`, `rebaseDraftSnapshot`). The
 * DB-touching helpers at the bottom (`forkOrLoadDraft`, `saveDraft`,
 * `publishDraft`, `discardDraft`, `rebaseDraft`) wire the pure functions
 * to `dashboard_user_drafts` + `dashboards` + `dashboard_cards`.
 *
 * Three design rules drove the shape:
 *
 *  1. **Pure first.** Every transformation that reasons about cards is
 *     `(snapshot, change) => snapshot` or `(snapshot, snapshot) => result`.
 *     The DB layer's job is just persistence — no business logic. This
 *     keeps the unit-test surface narrow (no DB) and makes the publish
 *     transaction easy to reason about (compute the merge as a value,
 *     THEN persist).
 *
 *  2. **Conflict detection is explicit.** `publishDraftMerge` and
 *     `rebaseDraftSnapshot` each return a discriminated union; conflicts
 *     are NEVER silently dropped (CLAUDE.md "prefer errors over silent
 *     fallbacks"). A card the user edited in their draft that another
 *     user already removed in published surfaces as `{ kind: "conflict",
 *     conflicts: [...] }` so the route layer can return 409 and the UI
 *     can prompt the user.
 *
 *  3. **No HTTP / Hono / Effect concepts.** Pure module — the route layer
 *     wires it into `/api/v1/dashboards/[id]/draft` and the bound editor
 *     tools (`packages/api/src/lib/tools/bound-dashboard.ts`) route
 *     mutations through `applyChangeToDraft` + `saveDraft` when the
 *     `ATLAS_DASHBOARD_DRAFTS_ENABLED` flag is on.
 *
 * Out of scope for this slice (#2364):
 *  - The destructive-op stage tracker (#2365) — `removeCard` / `updateCardSql`
 *    are NOT modelled here; they're still safe-op-only at the tool layer.
 *  - The Publish UI (#2521) — surface that calls `publishDraft`.
 *  - The "your baseline has changed" banner — read-side of #2521.
 *
 * Feature-flag note: `ATLAS_DASHBOARD_DRAFTS_ENABLED` defaults to false.
 * `isDashboardDraftsEnabled()` is the single gate; the bound editor
 * tools check it before routing through this module. When OFF, the
 * tools mutate `dashboards` / `dashboard_cards` directly (legacy
 * behavior preserved).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { rowToCard } from "@atlas/api/lib/dashboards";
import type {
  Dashboard,
  DashboardCard,
  DashboardWithCards,
  DashboardChartConfig,
  DashboardCardLayout,
} from "@atlas/api/lib/dashboard-types";

const log = createLogger("dashboard-versioning");

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Whether the per-user-draft routing is active. Defaults to FALSE so
 * existing dashboards behave exactly as they did pre-#2364 — the bound
 * editor tools write straight to published. The flag is flipped in
 * #2521 once the Publish UI lands.
 *
 * Read per-call rather than cached at import time so test setups can
 * toggle the flag with `process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED =
 * "true"` between cases without a module reset.
 */
export function isDashboardDraftsEnabled(): boolean {
  return process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

/**
 * The slice of dashboard state that a draft owns. We intentionally
 * snapshot only what the user actually edits in chat — title /
 * description / cards — and leave share / refresh metadata on the
 * live dashboard row. Publishing copies the snapshot back over those
 * fields; it never mutates share tokens or schedules.
 */
export interface DashboardSnapshotCard {
  /** Card id. NULL-string for cards added inside the draft and not yet persisted with a UUID. */
  id: string;
  position: number;
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig | null;
  connectionGroupId: string | null;
  layout: DashboardCardLayout | null;
}

export interface DashboardSnapshot {
  dashboardId: string;
  title: string;
  description: string | null;
  cards: DashboardSnapshotCard[];
}

/** Convert a fully-loaded `DashboardWithCards` to a snapshot. */
export function toSnapshot(dash: DashboardWithCards): DashboardSnapshot {
  return {
    dashboardId: dash.id,
    title: dash.title,
    description: dash.description,
    cards: dash.cards.map((c) => ({
      id: c.id,
      position: c.position,
      title: c.title,
      sql: c.sql,
      chartConfig: c.chartConfig,
      connectionGroupId: c.connectionGroupId,
      layout: c.layout,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pure transformations
// ---------------------------------------------------------------------------

/**
 * Fork a fresh draft snapshot from the live published dashboard.
 *
 * Pure — takes a `DashboardWithCards`, returns a `DashboardSnapshot`. The
 * DB-side wrapper (`forkOrLoadDraft`) is what handles persistence.
 */
export function forkDraftFromPublished(published: DashboardWithCards): DashboardSnapshot {
  return toSnapshot(published);
}

/**
 * Discriminated set of changes the editor tools can apply to a draft.
 *
 * Each change is a snapshot-in / snapshot-out transformation — the tool
 * layer never mutates the snapshot in place. Destructive ops
 * (`removeCard`, `updateCardSql`) are intentionally NOT in this union
 * for the #2364 slice; they ship as staged ghost changes in #2365.
 */
export type DraftChange =
  | { kind: "addCard"; card: DashboardSnapshotCard }
  | {
      kind: "updateCard";
      cardId: string;
      updates: {
        title?: string;
        chartConfig?: DashboardChartConfig | null;
        layout?: DashboardCardLayout | null;
        position?: number;
      };
    }
  | { kind: "updateLayout"; layouts: { cardId: string; layout: DashboardCardLayout }[] }
  | { kind: "updateMeta"; title?: string; description?: string | null };

/**
 * Apply a single change to a draft snapshot. Pure: returns a new
 * snapshot, never mutates the input. The `unknownCard` failure mode is
 * surfaced as a discriminated return rather than a thrown error so the
 * tool layer can map it to a user-facing message without `try/catch`.
 */
export type ApplyChangeResult =
  | { ok: true; snapshot: DashboardSnapshot }
  | { ok: false; reason: "unknown_card"; cardId: string };

export function applyChangeToDraft(
  draft: DashboardSnapshot,
  change: DraftChange,
): ApplyChangeResult {
  switch (change.kind) {
    case "addCard": {
      const cards = [...draft.cards, change.card];
      return { ok: true, snapshot: { ...draft, cards } };
    }
    case "updateCard": {
      const idx = draft.cards.findIndex((c) => c.id === change.cardId);
      if (idx === -1) return { ok: false, reason: "unknown_card", cardId: change.cardId };
      const cards = draft.cards.map((c, i) =>
        i === idx
          ? {
              ...c,
              ...(change.updates.title !== undefined && { title: change.updates.title }),
              ...(change.updates.chartConfig !== undefined && { chartConfig: change.updates.chartConfig }),
              ...(change.updates.layout !== undefined && { layout: change.updates.layout }),
              ...(change.updates.position !== undefined && { position: change.updates.position }),
            }
          : c,
      );
      return { ok: true, snapshot: { ...draft, cards } };
    }
    case "updateLayout": {
      // Each layout entry replaces the named card's layout. Unknown ids
      // surface as a single failure — partial application would leave
      // the snapshot ambiguous and the route layer can't recover.
      const ids = new Set(draft.cards.map((c) => c.id));
      const missing = change.layouts.find((p) => !ids.has(p.cardId));
      if (missing) return { ok: false, reason: "unknown_card", cardId: missing.cardId };
      const byId = new Map(change.layouts.map((p) => [p.cardId, p.layout] as const));
      const cards = draft.cards.map((c) => {
        const next = byId.get(c.id);
        return next ? { ...c, layout: next } : c;
      });
      return { ok: true, snapshot: { ...draft, cards } };
    }
    case "updateMeta": {
      const next: DashboardSnapshot = { ...draft };
      if (change.title !== undefined) next.title = change.title;
      if (change.description !== undefined) next.description = change.description;
      return { ok: true, snapshot: next };
    }
  }
}

// ---------------------------------------------------------------------------
// Publish — diff-merge draft into published
// ---------------------------------------------------------------------------

/**
 * One concrete change publish must perform against the published row.
 * The wrapper translates these into SQL inside a transaction.
 */
export type PublishOp =
  | { kind: "updateMeta"; title: string; description: string | null }
  | { kind: "insertCard"; card: DashboardSnapshotCard }
  | { kind: "updateCard"; cardId: string; card: DashboardSnapshotCard }
  | { kind: "deleteCard"; cardId: string };

export type PublishConflict =
  | {
      kind: "card_missing_in_published";
      cardId: string;
      reason: "card was removed from published since the draft was forked";
    }
  | {
      kind: "card_mutated_in_published";
      cardId: string;
      reason: "card was modified in published since the draft was forked";
    };

export type PublishMergeResult =
  | { kind: "ok"; ops: PublishOp[] }
  | { kind: "conflict"; conflicts: PublishConflict[] };

/**
 * Compute the diff-merge from a draft snapshot back to the currently
 * published snapshot, against the published snapshot AT FORK TIME
 * (`baseline`). This is the three-way merge:
 *
 *   - baseline: what published looked like when the draft was forked.
 *   - published: what published looks like RIGHT NOW.
 *   - draft: what the user has been editing.
 *
 * The merge rules:
 *
 *   1. Card present in draft, absent from published, present in baseline
 *      → conflict (`card_missing_in_published`). Another publisher removed
 *      it; the user has to resolve whether to re-add it.
 *
 *   2. Card in draft, present in published, mutated in both since baseline
 *      → conflict (`card_mutated_in_published`). The two editors changed
 *      the same card; the user has to rebase + reconcile.
 *
 *   3. Card in draft, absent from baseline → insert into published. This
 *      is a card the user ADDED in this draft.
 *
 *   4. Card in draft, present in baseline+published, only the draft side
 *      changed → update published.
 *
 *   5. Card in baseline + published but absent from draft → no-op. The
 *      slice #2364 does NOT model card removal in the draft (no
 *      destructive ops yet). Adding `removeCard` to `DraftChange` is
 *      the #2365 slice's job; this branch will then translate to a
 *      `deleteCard` op.
 *
 *   6. Meta (title / description) — overwrite whenever the draft's value
 *      differs from published's current value. No baseline check because
 *      the meta is small and intent is usually "I changed the title,
 *      publish it." A future slice can tighten this.
 *
 * Pure: no DB, no IO.
 */
export function publishDraftMerge(
  draft: DashboardSnapshot,
  published: DashboardSnapshot,
  baseline: DashboardSnapshot,
): PublishMergeResult {
  const ops: PublishOp[] = [];
  const conflicts: PublishConflict[] = [];

  // Index lookups so each card is O(1).
  const baselineById = new Map(baseline.cards.map((c) => [c.id, c] as const));
  const publishedById = new Map(published.cards.map((c) => [c.id, c] as const));

  for (const dCard of draft.cards) {
    const wasInBaseline = baselineById.has(dCard.id);
    const inPublishedNow = publishedById.get(dCard.id);

    if (!wasInBaseline) {
      // Rule 3 — added in draft, not in baseline.
      // If the same id somehow appears in published already (another tab
      // already published the same suggestion), treat it as a conflict
      // rather than blindly overwriting. The only way a draft-added card
      // shares an id with a published row is malicious / corrupt state.
      if (inPublishedNow) {
        conflicts.push({
          kind: "card_mutated_in_published",
          cardId: dCard.id,
          reason: "card was modified in published since the draft was forked",
        });
        continue;
      }
      ops.push({ kind: "insertCard", card: dCard });
      continue;
    }

    if (!inPublishedNow) {
      // Rule 1 — present in baseline, absent now.
      conflicts.push({
        kind: "card_missing_in_published",
        cardId: dCard.id,
        reason: "card was removed from published since the draft was forked",
      });
      continue;
    }

    const baseCard = baselineById.get(dCard.id)!;
    const draftDiff = !cardEquals(dCard, baseCard);
    const publishedDiff = !cardEquals(inPublishedNow, baseCard);

    if (publishedDiff && draftDiff) {
      // Rule 2 — both sides moved.
      conflicts.push({
        kind: "card_mutated_in_published",
        cardId: dCard.id,
        reason: "card was modified in published since the draft was forked",
      });
      continue;
    }

    if (draftDiff) {
      // Rule 4 — only draft moved; publish overwrites.
      ops.push({ kind: "updateCard", cardId: dCard.id, card: dCard });
    }
    // Otherwise both sides match baseline → no-op for this card.
  }

  // Rule 6 — meta diff (draft vs current published).
  if (draft.title !== published.title || draft.description !== published.description) {
    ops.push({
      kind: "updateMeta",
      title: draft.title,
      description: draft.description,
    });
  }

  if (conflicts.length > 0) {
    return { kind: "conflict", conflicts };
  }
  return { kind: "ok", ops };
}

function cardEquals(a: DashboardSnapshotCard, b: DashboardSnapshotCard): boolean {
  if (a.title !== b.title) return false;
  if (a.sql !== b.sql) return false;
  if (a.position !== b.position) return false;
  if (a.connectionGroupId !== b.connectionGroupId) return false;
  if (!jsonEquals(a.chartConfig, b.chartConfig)) return false;
  if (!jsonEquals(a.layout, b.layout)) return false;
  return true;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Rebase — bring the draft forward to the latest published baseline
// ---------------------------------------------------------------------------

export type RebaseResult =
  | { kind: "fast_forward"; snapshot: DashboardSnapshot; newBaselineAt: string }
  | { kind: "conflict"; conflicts: PublishConflict[] };

/**
 * Pure rebase: try to fast-forward a draft onto the latest published
 * baseline. Returns the updated draft + the new `published_baseline_at`
 * to stamp on the row, OR the conflict set if the user's draft would
 * collide with anything that landed in published since the original
 * fork.
 *
 * Fast-forward semantics:
 *
 *   - Cards present in newPublished + draft, where the draft side hasn't
 *     diverged from baseline → adopt newPublished's version (whatever
 *     changed in published is what the user now sees too).
 *   - Cards present in newPublished + draft, where BOTH have changed
 *     since baseline → conflict.
 *   - Cards added in newPublished (not in baseline, not in draft) → carry
 *     them into the draft so the user sees the new state.
 *   - Cards removed in newPublished, untouched in the draft → drop them
 *     from the draft.
 *   - Cards added in the draft (not in baseline, not in newPublished)
 *     → keep as draft-side additions; publish later.
 *
 * @param newPublishedTimestamp ISO timestamp of the live published row's
 *   `updated_at` — written back to `published_baseline_at` so the next
 *   rebase compares against THIS state, not the original fork.
 */
export function rebaseDraftSnapshot(
  draft: DashboardSnapshot,
  newPublished: DashboardSnapshot,
  baseline: DashboardSnapshot,
  newPublishedTimestamp: string,
): RebaseResult {
  const conflicts: PublishConflict[] = [];

  const baselineById = new Map(baseline.cards.map((c) => [c.id, c] as const));
  const draftById = new Map(draft.cards.map((c) => [c.id, c] as const));

  const mergedCards: DashboardSnapshotCard[] = [];
  const consumedDraftIds = new Set<string>();

  // Walk newPublished first so its ordering survives. Then append any
  // draft-side additions at the end.
  for (const np of newPublished.cards) {
    const baseCard = baselineById.get(np.id);
    const dCard = draftById.get(np.id);

    if (!dCard) {
      // Draft never had this card. Either it's net-new in published
      // (carry it forward) or it existed in baseline but the draft
      // removed it (#2364 doesn't model removal, so this branch can't
      // hit today; #2365 will care).
      mergedCards.push(np);
      continue;
    }

    consumedDraftIds.add(np.id);

    if (!baseCard) {
      // Both sides created a card with the same id — only a malicious
      // / corrupt sequence produces this, treat as conflict.
      conflicts.push({
        kind: "card_mutated_in_published",
        cardId: np.id,
        reason: "card was modified in published since the draft was forked",
      });
      continue;
    }

    const draftDiff = !cardEquals(dCard, baseCard);
    const publishedDiff = !cardEquals(np, baseCard);

    if (draftDiff && publishedDiff) {
      conflicts.push({
        kind: "card_mutated_in_published",
        cardId: np.id,
        reason: "card was modified in published since the draft was forked",
      });
      continue;
    }
    if (draftDiff) {
      mergedCards.push(dCard);
    } else {
      // No draft change → adopt the new published version.
      mergedCards.push(np);
    }
  }

  // Append draft-side additions (cards present in draft but not in
  // newPublished AND not in baseline).
  for (const dCard of draft.cards) {
    if (consumedDraftIds.has(dCard.id)) continue;
    if (baselineById.has(dCard.id)) {
      // Card was in baseline + draft but not in newPublished — published
      // removed it under us.
      conflicts.push({
        kind: "card_missing_in_published",
        cardId: dCard.id,
        reason: "card was removed from published since the draft was forked",
      });
      continue;
    }
    mergedCards.push(dCard);
  }

  if (conflicts.length > 0) {
    return { kind: "conflict", conflicts };
  }

  return {
    kind: "fast_forward",
    snapshot: {
      dashboardId: draft.dashboardId,
      // Meta: prefer the draft's edits if they differ from baseline;
      // otherwise adopt newPublished's.
      title: draft.title !== baseline.title ? draft.title : newPublished.title,
      description:
        draft.description !== baseline.description
          ? draft.description
          : newPublished.description,
      cards: mergedCards,
    },
    newBaselineAt: newPublishedTimestamp,
  };
}

// ---------------------------------------------------------------------------
// DB-touching helpers
// ---------------------------------------------------------------------------

export type DraftRow = {
  userId: string;
  dashboardId: string;
  /** The user's working snapshot. */
  snapshot: DashboardSnapshot;
  /** What published looked like at fork time — drives three-way merge. */
  baseline: DashboardSnapshot;
  publishedBaselineAt: string;
  createdAt: string;
  updatedAt: string;
};

function rowToDraft(r: Record<string, unknown>): DraftRow {
  const draft = typeof r.draft === "string" ? JSON.parse(r.draft) : (r.draft as DashboardSnapshot);
  const baseline = typeof r.baseline === "string" ? JSON.parse(r.baseline) : (r.baseline as DashboardSnapshot);
  return {
    userId: r.user_id as string,
    dashboardId: r.dashboard_id as string,
    snapshot: draft,
    baseline,
    publishedBaselineAt: String(r.published_baseline_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Load the current draft row (snapshot + baseline timestamp) for a
 * user+dashboard pair. Returns `null` when no draft exists or when
 * the internal DB is unavailable.
 *
 * Org-scoping happens at the route layer (the route loads the dashboard
 * scoped to the caller's orgId BEFORE touching drafts). This helper
 * doesn't take an orgId because the FK + the route gate already make
 * cross-org reads impossible.
 */
export async function loadDraft(
  userId: string,
  dashboardId: string,
): Promise<DraftRow | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT user_id, dashboard_id, draft, baseline, published_baseline_at, created_at, updated_at
         FROM dashboard_user_drafts
        WHERE user_id = $1 AND dashboard_id = $2`,
      [userId, dashboardId],
    );
    if (rows.length === 0) return null;
    return rowToDraft(rows[0]);
  } catch (err) {
    log.error({ err: errorMessage(err), userId, dashboardId }, "loadDraft failed");
    return null;
  }
}

/**
 * Load OR fork: if a draft exists for `(userId, dashboardId)` return it;
 * otherwise fork a fresh draft from `published` and persist it. Returns
 * the draft row in both cases. This is the "first edit forks; subsequent
 * edits reuse" guarantee the acceptance criteria call out.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING + a re-select so two concurrent
 * "open the drawer in two tabs" requests converge on the same row
 * without a race.
 */
export async function forkOrLoadDraft(
  userId: string,
  published: DashboardWithCards,
): Promise<DraftRow | null> {
  if (!hasInternalDB()) return null;
  const existing = await loadDraft(userId, published.id);
  if (existing) return existing;
  const snapshot = forkDraftFromPublished(published);
  const baselineSnapshot = toSnapshot(published);
  const baselineAt = published.updatedAt;
  try {
    await internalQuery(
      `INSERT INTO dashboard_user_drafts
         (user_id, dashboard_id, draft, baseline, published_baseline_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (user_id, dashboard_id) DO NOTHING`,
      [
        userId,
        published.id,
        JSON.stringify(snapshot),
        JSON.stringify(baselineSnapshot),
        baselineAt,
      ],
    );
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId, dashboardId: published.id },
      "forkOrLoadDraft insert failed",
    );
    return null;
  }
  return loadDraft(userId, published.id);
}

/**
 * Persist an updated draft snapshot. Caller is responsible for having
 * loaded the row, applied a change, and computing the new snapshot via
 * `applyChangeToDraft`. Returns `true` on success.
 */
export async function saveDraft(
  userId: string,
  dashboardId: string,
  snapshot: DashboardSnapshot,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    const rows = await internalQuery<{ user_id: string }>(
      `UPDATE dashboard_user_drafts
          SET draft = $1::jsonb,
              updated_at = now()
        WHERE user_id = $2 AND dashboard_id = $3
        RETURNING user_id`,
      [JSON.stringify(snapshot), userId, dashboardId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId, dashboardId },
      "saveDraft failed",
    );
    return false;
  }
}

/** Discard the user's draft for a dashboard. Idempotent. */
export async function discardDraft(userId: string, dashboardId: string): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    await internalQuery(
      `DELETE FROM dashboard_user_drafts WHERE user_id = $1 AND dashboard_id = $2`,
      [userId, dashboardId],
    );
    return true;
  } catch (err) {
    log.error({ err: errorMessage(err), userId, dashboardId }, "discardDraft failed");
    return false;
  }
}

export type PublishDraftResult =
  | { ok: true; opsApplied: number }
  | { ok: false; reason: "no_db" | "no_draft" | "dashboard_missing" | "stale_baseline" | "error" }
  | { ok: false; reason: "conflict"; conflicts: PublishConflict[] };

/**
 * Publish the user's draft into the live `dashboards` + `dashboard_cards`
 * tables, transactionally. After a successful publish the draft row is
 * deleted (the user has nothing left to publish on this dashboard).
 *
 * The merge is computed BEFORE the transaction opens — pure function
 * call against the snapshots. The transaction body is just the SQL
 * that executes the ops, plus the draft delete + dashboards.updated_at
 * touch. Conflicts return 409 from the route layer; the user gets a
 * "rebase" affordance.
 *
 * NOTE: Other editors' draft rows are NOT touched here. They'll get a
 * `published_baseline_at` mismatch on their next rebase, which is the
 * "your baseline has changed" signal user story 13 calls out.
 *
 * Dependency-injectable load fns let unit tests exercise this without
 * a real Postgres. The default impls hit `dashboards.getDashboard`.
 */
export async function publishDraft(opts: {
  userId: string;
  dashboardId: string;
  orgId: string | null | undefined;
  loadDashboardForOrg: (id: string, orgId: string | null | undefined) => Promise<DashboardWithCards | null>;
}): Promise<PublishDraftResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const draftRow = await loadDraft(opts.userId, opts.dashboardId);
  if (!draftRow) return { ok: false, reason: "no_draft" };

  const published = await opts.loadDashboardForOrg(opts.dashboardId, opts.orgId);
  if (!published) return { ok: false, reason: "dashboard_missing" };

  // Stale-baseline guard: when published has moved since the user
  // forked, force the user to rebase first. The route layer surfaces
  // this as a 409 with `reason: "stale_baseline"` so the UI can prompt
  // for rebase. Even though `publishDraftMerge` is correct with the
  // persisted baseline, requiring rebase here ensures the user has
  // SEEN the changes before they publish over them — refusing to
  // diff-merge without an explicit rebase is the "your baseline has
  // changed" user-experience the PRD's user story 13 calls out.
  // (CLAUDE.md "prefer errors over silent fallbacks".)
  if (published.updatedAt !== draftRow.publishedBaselineAt) {
    return { ok: false, reason: "stale_baseline" };
  }

  const merge = publishDraftMerge(
    draftRow.snapshot,
    toSnapshot(published),
    draftRow.baseline,
  );
  if (merge.kind === "conflict") {
    return { ok: false, reason: "conflict", conflicts: merge.conflicts };
  }

  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let opsApplied = 0;
    for (const op of merge.ops) {
      switch (op.kind) {
        case "updateMeta": {
          await client.query(
            `UPDATE dashboards
                SET title = $1,
                    description = $2,
                    updated_at = now()
              WHERE id = $3 AND deleted_at IS NULL`,
            [op.title, op.description, opts.dashboardId],
          );
          opsApplied++;
          break;
        }
        case "insertCard": {
          // Snapshot card may have a synthetic id from the draft (e.g.
          // a UUID the bound tool minted). We INSERT honouring that id
          // so subsequent updates in the same publish still resolve.
          await client.query(
            `INSERT INTO dashboard_cards
               (id, dashboard_id, position, title, sql, chart_config, connection_group_id, layout)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
              op.card.id,
              opts.dashboardId,
              op.card.position,
              op.card.title,
              op.card.sql,
              op.card.chartConfig ? JSON.stringify(op.card.chartConfig) : null,
              op.card.connectionGroupId,
              op.card.layout ? JSON.stringify(op.card.layout) : null,
            ],
          );
          opsApplied++;
          break;
        }
        case "updateCard": {
          await client.query(
            `UPDATE dashboard_cards
                SET title = $1,
                    chart_config = $2,
                    layout = $3,
                    position = $4,
                    updated_at = now()
              WHERE id = $5 AND dashboard_id = $6`,
            [
              op.card.title,
              op.card.chartConfig ? JSON.stringify(op.card.chartConfig) : null,
              op.card.layout ? JSON.stringify(op.card.layout) : null,
              op.card.position,
              op.cardId,
              opts.dashboardId,
            ],
          );
          opsApplied++;
          break;
        }
        case "deleteCard": {
          await client.query(
            `DELETE FROM dashboard_cards WHERE id = $1 AND dashboard_id = $2`,
            [op.cardId, opts.dashboardId],
          );
          opsApplied++;
          break;
        }
      }
    }
    // Touch the parent dashboard so the cards bump in too.
    await client.query(
      `UPDATE dashboards SET updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [opts.dashboardId],
    );
    // Drop the draft row — there's nothing left to publish.
    await client.query(
      `DELETE FROM dashboard_user_drafts WHERE user_id = $1 AND dashboard_id = $2`,
      [opts.userId, opts.dashboardId],
    );
    await client.query("COMMIT");
    return { ok: true, opsApplied };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      log.warn(
        { err: errorMessage(rollbackErr), userId: opts.userId, dashboardId: opts.dashboardId },
        "publishDraft ROLLBACK failed",
      );
    }
    log.error(
      { err: errorMessage(err), userId: opts.userId, dashboardId: opts.dashboardId },
      "publishDraft transaction failed",
    );
    return { ok: false, reason: "error" };
  } finally {
    client.release();
  }
}

export type RebaseDraftResult =
  | { ok: true; snapshot: DashboardSnapshot; newBaselineAt: string }
  | { ok: false; reason: "no_db" | "no_draft" | "dashboard_missing" | "error" }
  | { ok: false; reason: "conflict"; conflicts: PublishConflict[] };

/**
 * Bring the user's draft up to the latest published baseline. Pure
 * `rebaseDraftSnapshot` does the merge; this helper just loads + saves.
 */
export async function rebaseDraft(opts: {
  userId: string;
  dashboardId: string;
  orgId: string | null | undefined;
  loadDashboardForOrg: (
    id: string,
    orgId: string | null | undefined,
  ) => Promise<DashboardWithCards | null>;
}): Promise<RebaseDraftResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  const draftRow = await loadDraft(opts.userId, opts.dashboardId);
  if (!draftRow) return { ok: false, reason: "no_draft" };
  const published = await opts.loadDashboardForOrg(opts.dashboardId, opts.orgId);
  if (!published) return { ok: false, reason: "dashboard_missing" };

  // Rebase is a no-op when nothing has moved on published since the
  // user forked. Fast-forward returns the existing snapshot + the same
  // baseline; the route layer can short-circuit without a write.
  if (published.updatedAt === draftRow.publishedBaselineAt) {
    return {
      ok: true,
      snapshot: draftRow.snapshot,
      newBaselineAt: draftRow.publishedBaselineAt,
    };
  }

  // True three-way merge against the persisted baseline (snapshot of
  // what published looked like at fork time).
  const result = rebaseDraftSnapshot(
    draftRow.snapshot,
    toSnapshot(published),
    draftRow.baseline,
    published.updatedAt,
  );
  if (result.kind === "conflict") {
    return { ok: false, reason: "conflict", conflicts: result.conflicts };
  }

  try {
    const newBaselineSnapshot = toSnapshot(published);
    const rows = await internalQuery<{ user_id: string }>(
      `UPDATE dashboard_user_drafts
          SET draft = $1::jsonb,
              baseline = $2::jsonb,
              published_baseline_at = $3,
              updated_at = now()
        WHERE user_id = $4 AND dashboard_id = $5
        RETURNING user_id`,
      [
        JSON.stringify(result.snapshot),
        JSON.stringify(newBaselineSnapshot),
        result.newBaselineAt,
        opts.userId,
        opts.dashboardId,
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "no_draft" };
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId: opts.userId, dashboardId: opts.dashboardId },
      "rebaseDraft persist failed",
    );
    return { ok: false, reason: "error" };
  }
  return { ok: true, snapshot: result.snapshot, newBaselineAt: result.newBaselineAt };
}

// ---------------------------------------------------------------------------
// Helpers shared with the route layer / view path
// ---------------------------------------------------------------------------

/**
 * Materialize a `DashboardWithCards` from a stored draft + the live
 * published dashboard. Used by `GET /dashboards/[id]?view=draft` to
 * answer "show me what the user would see if they switched to their
 * draft" without losing fields the draft doesn't track (share token,
 * refresh schedule, etc.).
 */
export function materializeDraftView(
  published: DashboardWithCards,
  draft: DashboardSnapshot,
): DashboardWithCards {
  return {
    ...published,
    title: draft.title,
    description: draft.description,
    cards: draft.cards.map((c, idx) => snapshotCardToDashboardCard(c, published.id, idx)),
  };
}

function snapshotCardToDashboardCard(
  c: DashboardSnapshotCard,
  dashboardId: string,
  fallbackIndex: number,
): DashboardCard {
  // Best-effort row → card via the existing helper for consistency
  // with the published read path.
  return rowToCard({
    id: c.id,
    dashboard_id: dashboardId,
    position: c.position ?? fallbackIndex,
    title: c.title,
    sql: c.sql,
    chart_config: c.chartConfig,
    cached_columns: null,
    cached_rows: null,
    cached_at: null,
    connection_group_id: c.connectionGroupId,
    layout: c.layout,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

/** Sentinel used by route layers — re-exports the Dashboard type for callers that need it. */
export type { Dashboard, DashboardCard, DashboardWithCards };
