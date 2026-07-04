/**
 * Unit tests for the dashboard versioning deep module (#2364).
 *
 * Pure-function tests live up top — `forkDraftFromPublished`,
 * `applyChangeToDraft`, `publishDraftMerge`, `rebaseDraftSnapshot`.
 * DB-touching helpers (`forkOrLoadDraft`, `saveDraft`, `publishDraft`,
 * `discardDraft`, `rebaseDraft`) use the `_resetPool(mockPool)` idiom
 * — same as `packages/api/src/lib/__tests__/conversations.test.ts` —
 * to avoid `mock.module()`'s async-loader deadlock under bun's full
 * test suite (see feedback_bun_test_async_mock_module).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  _resetPool,
  type InternalPool,
  type InternalPoolClient,
} from "../db/internal";
import {
  forkDraftFromPublished,
  applyChangeToDraft,
  publishDraftMerge,
  rebaseDraftSnapshot,
  toSnapshot,
  loadDraft,
  forkOrLoadDraft,
  saveDraft,
  applyEditToDraft,
  discardDraft,
  publishDraft,
  rebaseDraft,
  isDashboardDraftsEnabled,
  materializeDraftView,
  type DashboardSnapshot,
  type DashboardSnapshotCard,
} from "../dashboard-versioning";
import type { DashboardWithCards, DashboardCard } from "../dashboard-types";

// ---------------------------------------------------------------------------
// Snapshot fixtures
// ---------------------------------------------------------------------------

function card(
  id: string,
  overrides: Partial<DashboardSnapshotCard> = {},
): DashboardSnapshotCard {
  return {
    id,
    position: 0,
    title: `Card ${id}`,
    sql: `SELECT 1 AS v_${id}`,
    chartConfig: { type: "table", categoryColumn: "v_x", valueColumns: ["v_y"] },
    connectionGroupId: null,
    layout: null,
    ...overrides,
  };
}

function snapshot(
  cards: DashboardSnapshotCard[],
  overrides: Partial<Omit<DashboardSnapshot, "cards">> = {},
): DashboardSnapshot {
  return {
    dashboardId: "dash-1",
    title: "Test Dashboard",
    description: null,
    cards,
    ...overrides,
  };
}

function dashboardWithCards(
  cards: DashboardSnapshotCard[],
  overrides: Partial<DashboardWithCards> = {},
): DashboardWithCards {
  return {
    id: "dash-1",
    orgId: "org-1",
    ownerId: "u-owner",
    title: "Test Dashboard",
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public",
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    parameters: [],
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    cards: cards.map((c) => ({
      id: c.id,
      dashboardId: "dash-1",
      position: c.position,
      title: c.title,
      kind: (c.content != null ? "text" : "chart") as DashboardCard["kind"],
      sql: c.sql,
      chartConfig: c.chartConfig,
      content: c.content ?? null,
      annotations: c.annotations ?? [],
      cachedColumns: null,
      cachedRows: null,
      cachedAt: null,
      connectionGroupId: c.connectionGroupId,
      layout: c.layout,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure: feature flag
// ---------------------------------------------------------------------------

describe("isDashboardDraftsEnabled", () => {
  const orig = process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;
    else process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = orig;
  });

  it("is true by default (#2521 flipped the default ON)", () => {
    delete process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;
    expect(isDashboardDraftsEnabled()).toBe(true);
  });

  it("is false only when env var is exactly 'false'", () => {
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "false";
    expect(isDashboardDraftsEnabled()).toBe(false);
  });

  it("is true when env var is anything other than 'false' (no accidental opt-out)", () => {
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "true";
    expect(isDashboardDraftsEnabled()).toBe(true);
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "1";
    expect(isDashboardDraftsEnabled()).toBe(true);
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "0";
    expect(isDashboardDraftsEnabled()).toBe(true);
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "FALSE";
    expect(isDashboardDraftsEnabled()).toBe(true);
    process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "no";
    expect(isDashboardDraftsEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure: forkDraftFromPublished
// ---------------------------------------------------------------------------

describe("forkDraftFromPublished", () => {
  it("produces an exact snapshot of the published dashboard", () => {
    const published = dashboardWithCards([card("c1"), card("c2", { position: 1 })]);
    const draft = forkDraftFromPublished(published);
    expect(draft.dashboardId).toBe("dash-1");
    expect(draft.title).toBe("Test Dashboard");
    expect(draft.cards).toHaveLength(2);
    expect(draft.cards[0].id).toBe("c1");
    expect(draft.cards[1].id).toBe("c2");
  });

  it("preserves null fields on the snapshot", () => {
    const published = dashboardWithCards([], { description: null });
    const draft = forkDraftFromPublished(published);
    expect(draft.description).toBeNull();
    expect(draft.cards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure: applyChangeToDraft
// ---------------------------------------------------------------------------

describe("applyChangeToDraft", () => {
  it("addCard appends to cards", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, { kind: "addCard", card: card("c2", { position: 1 }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    // Pure: original snapshot unmodified.
    expect(base.cards).toHaveLength(1);
  });

  it("updateCard applies only the supplied fields", () => {
    const base = snapshot([card("c1", { title: "Old" })]);
    const result = applyChangeToDraft(base, {
      kind: "updateCard",
      cardId: "c1",
      updates: { title: "New" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards[0].title).toBe("New");
    expect(result.snapshot.cards[0].sql).toBe(base.cards[0].sql);
  });

  it("updateCard returns unknown_card when card is missing", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, {
      kind: "updateCard",
      cardId: "missing",
      updates: { title: "X" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_card");
    expect(result.cardId).toBe("missing");
  });

  it("updateLayout replaces only the listed cards", () => {
    const base = snapshot([card("c1"), card("c2")]);
    const result = applyChangeToDraft(base, {
      kind: "updateLayout",
      layouts: [{ cardId: "c1", layout: { x: 0, y: 0, w: 12, h: 8 } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards[0].layout).toEqual({ x: 0, y: 0, w: 12, h: 8 });
    expect(result.snapshot.cards[1].layout).toBeNull();
  });

  it("updateLayout returns unknown_card when any entry is missing", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, {
      kind: "updateLayout",
      layouts: [
        { cardId: "c1", layout: { x: 0, y: 0, w: 12, h: 8 } },
        { cardId: "missing", layout: { x: 0, y: 8, w: 12, h: 8 } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_card");
    expect(result.cardId).toBe("missing");
  });

  it("updateMeta overwrites title and/or description", () => {
    const base = snapshot([], { title: "Old", description: null });
    const titleOnly = applyChangeToDraft(base, {
      kind: "updateMeta",
      title: "New",
    });
    expect(titleOnly.ok).toBe(true);
    if (!titleOnly.ok) return;
    expect(titleOnly.snapshot.title).toBe("New");
    expect(titleOnly.snapshot.description).toBeNull();

    const both = applyChangeToDraft(base, {
      kind: "updateMeta",
      title: "X",
      description: "Y",
    });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.snapshot.title).toBe("X");
    expect(both.snapshot.description).toBe("Y");
  });

  // ---------- destructive #2365 variants ----------------------------------

  it("removeCard drops the card from the snapshot", () => {
    const base = snapshot([card("c1"), card("c2"), card("c3")]);
    const result = applyChangeToDraft(base, { kind: "removeCard", cardId: "c2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards.map((c) => c.id)).toEqual(["c1", "c3"]);
    // Pure: source unchanged.
    expect(base.cards.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("removeCard returns unknown_card when the target is missing", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, { kind: "removeCard", cardId: "missing" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_card");
    expect(result.cardId).toBe("missing");
  });

  it("editSql replaces the card's SQL in place; other fields unchanged", () => {
    const base = snapshot([card("c1", { sql: "SELECT 1", title: "First" })]);
    const result = applyChangeToDraft(base, {
      kind: "editSql",
      cardId: "c1",
      newSql: "SELECT 2 FROM t WHERE x = 1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards[0].sql).toBe("SELECT 2 FROM t WHERE x = 1");
    expect(result.snapshot.cards[0].title).toBe("First");
  });

  it("editSql returns unknown_card when the target is missing", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, {
      kind: "editSql",
      cardId: "missing",
      newSql: "SELECT 1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_card");
  });
});

// ---------------------------------------------------------------------------
// Event annotations (#3209) — persist through propose/save/publish + bound edit
// ---------------------------------------------------------------------------

describe("event annotations (#3209)", () => {
  const annotations = [
    { x: "2026-01-15", label: "Launch", color: "#10b981" },
    { x: "2026-03-01", label: "Campaign" },
  ];

  it("toSnapshot carries a card's annotations (propose/save round-trip)", () => {
    const dash = dashboardWithCards([card("c1")], {});
    dash.cards[0].annotations = annotations;
    expect(toSnapshot(dash).cards[0].annotations).toEqual(annotations);
  });

  it("applyChangeToDraft updateCard SETS annotations (bound-chat edit authoring)", () => {
    const base = snapshot([card("c1")]);
    const result = applyChangeToDraft(base, {
      kind: "updateCard",
      cardId: "c1",
      updates: { annotations },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards[0].annotations).toEqual(annotations);
  });

  it("applyChangeToDraft updateCard PRESERVES annotations when the patch omits them", () => {
    // A bound edit that only renames the card must not drop its markers.
    const base = snapshot([card("c1", { annotations })]);
    const result = applyChangeToDraft(base, {
      kind: "updateCard",
      cardId: "c1",
      updates: { title: "Renamed" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cards[0].title).toBe("Renamed");
    expect(result.snapshot.cards[0].annotations).toEqual(annotations);
  });

  it("publishDraftMerge emits an updateCard op when only annotations changed (publish persists them)", () => {
    const baseline = snapshot([card("c1")]);
    const draft = applyChangeToDraft(baseline, {
      kind: "updateCard",
      cardId: "c1",
      updates: { annotations },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const result = publishDraftMerge(draft.snapshot, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([{ kind: "updateCard", cardId: "c1", card: draft.snapshot.cards[0] }]);
  });

  it("an unchanged annotated card produces no ops (empty array == today; undefined↔[] normalized)", () => {
    const withMarkers = snapshot([card("c1", { annotations })]);
    expect((publishDraftMerge(withMarkers, withMarkers, withMarkers) as { ops: unknown[] }).ops).toHaveLength(0);

    // A card with no `annotations` key (pre-#3209 draft) vs one carrying `[]`
    // must NOT read as a spurious change.
    const noKey = snapshot([card("c1")]);
    const emptyKey = snapshot([card("c1", { annotations: [] })]);
    expect((publishDraftMerge(emptyKey, noKey, noKey) as { ops: unknown[] }).ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure: publishDraftMerge
// ---------------------------------------------------------------------------

describe("publishDraftMerge", () => {
  it("no-op merge returns ok with zero ops", () => {
    const s = snapshot([card("c1")]);
    const result = publishDraftMerge(s, s, s);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toHaveLength(0);
  });

  it("draft-only addCard → insertCard op", () => {
    const baseline = snapshot([card("c1")]);
    const draft = applyChangeToDraft(baseline, { kind: "addCard", card: card("c2", { position: 1 }) });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const result = publishDraftMerge(draft.snapshot, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].kind).toBe("insertCard");
  });

  it("draft-only updateCard → updateCard op", () => {
    const baseline = snapshot([card("c1", { title: "Old" })]);
    const draft = applyChangeToDraft(baseline, {
      kind: "updateCard",
      cardId: "c1",
      updates: { title: "New" },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const result = publishDraftMerge(draft.snapshot, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([{ kind: "updateCard", cardId: "c1", card: draft.snapshot.cards[0] }]);
  });

  // #3138 — `cardEquals` is gated on card kind (derived from `content`).
  it("an unchanged text card produces no ops (content-equality gating)", () => {
    const base = snapshot([card("t1", { content: "## A", sql: "", chartConfig: null })]);
    const result = publishDraftMerge(base, base, base);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toHaveLength(0);
  });

  it("an edited text card's markdown → updateCard op", () => {
    const baseline = snapshot([card("t1", { content: "## A", sql: "", chartConfig: null })]);
    const draftCard = card("t1", { content: "## B", sql: "", chartConfig: null });
    const result = publishDraftMerge(snapshot([draftCard]), baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([{ kind: "updateCard", cardId: "t1", card: draftCard }]);
  });

  it("flipping a chart card to a text card is a change (kind discriminates)", () => {
    const baseline = snapshot([card("c1", { content: null })]); // chart
    const draftCard = card("c1", { content: "## Now a header", sql: "", chartConfig: null });
    const result = publishDraftMerge(snapshot([draftCard]), baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([{ kind: "updateCard", cardId: "c1", card: draftCard }]);
  });

  it("title change → updateMeta op", () => {
    const baseline = snapshot([], { title: "Old" });
    const draft: DashboardSnapshot = { ...baseline, title: "New" };
    const result = publishDraftMerge(draft, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([
      { kind: "updateMeta", title: "New", description: null },
    ]);
  });

  it("card removed from published since fork → conflict (card_missing_in_published)", () => {
    const baseline = snapshot([card("c1"), card("c2")]);
    // Draft edits c2.
    const draft = applyChangeToDraft(baseline, {
      kind: "updateCard",
      cardId: "c2",
      updates: { title: "Renamed" },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    // Meanwhile published removed c2.
    const newPublished = snapshot([card("c1")]);
    const result = publishDraftMerge(draft.snapshot, newPublished, baseline);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts[0].kind).toBe("card_missing_in_published");
    expect(result.conflicts[0].cardId).toBe("c2");
  });

  it("card modified in both draft and published since fork → conflict (card_mutated_in_published)", () => {
    const baseline = snapshot([card("c1", { title: "Original" })]);
    const draft: DashboardSnapshot = {
      ...baseline,
      cards: [{ ...baseline.cards[0], title: "Draft change" }],
    };
    const newPublished: DashboardSnapshot = {
      ...baseline,
      cards: [{ ...baseline.cards[0], title: "Published change" }],
    };
    const result = publishDraftMerge(draft, newPublished, baseline);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts[0].kind).toBe("card_mutated_in_published");
    expect(result.conflicts[0].cardId).toBe("c1");
  });

  // ---------- destructive #2365 ops on the merge path ----------------------

  it("removeCard in draft → deleteCard op when published still has it untouched", () => {
    const baseline = snapshot([card("c1"), card("c2")]);
    const draft = applyChangeToDraft(baseline, { kind: "removeCard", cardId: "c2" });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    // Published unchanged.
    const result = publishDraftMerge(draft.snapshot, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toEqual([{ kind: "deleteCard", cardId: "c2" }]);
  });

  it("removeCard in draft + same card already removed in published → no-op (both sides agree)", () => {
    const baseline = snapshot([card("c1"), card("c2")]);
    const draft = applyChangeToDraft(baseline, { kind: "removeCard", cardId: "c2" });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const newPublished = snapshot([card("c1")]);
    const result = publishDraftMerge(draft.snapshot, newPublished, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // c2 was removed both sides — no op needed.
    expect(result.ops).toHaveLength(0);
  });

  it("removeCard in draft + published mutated that card → conflict (card_mutated_in_published)", () => {
    const baseline = snapshot([card("c1"), card("c2", { title: "Original" })]);
    const draft = applyChangeToDraft(baseline, { kind: "removeCard", cardId: "c2" });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const newPublished: DashboardSnapshot = {
      ...baseline,
      cards: [card("c1"), { ...baseline.cards[1], title: "Published edit" }],
    };
    const result = publishDraftMerge(draft.snapshot, newPublished, baseline);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts[0].kind).toBe("card_mutated_in_published");
    expect(result.conflicts[0].cardId).toBe("c2");
  });

  it("editSql in draft → updateCard op with new SQL preserved", () => {
    const baseline = snapshot([card("c1", { sql: "SELECT 1" })]);
    const draft = applyChangeToDraft(baseline, {
      kind: "editSql",
      cardId: "c1",
      newSql: "SELECT 2",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const result = publishDraftMerge(draft.snapshot, baseline, baseline);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.ops).toHaveLength(1);
    if (result.ops[0]?.kind !== "updateCard") throw new Error("expected updateCard");
    expect(result.ops[0].card.sql).toBe("SELECT 2");
  });

  it("draft-add with the same id colliding with published → conflict", () => {
    const baseline = snapshot([]);
    const draft = applyChangeToDraft(baseline, { kind: "addCard", card: card("c1") });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const newPublished = snapshot([card("c1", { title: "Snuck in" })]);
    const result = publishDraftMerge(draft.snapshot, newPublished, baseline);
    expect(result.kind).toBe("conflict");
  });

  it("multiple conflicts surface together (not silently dropped)", () => {
    const baseline = snapshot([card("c1"), card("c2")]);
    const draft: DashboardSnapshot = {
      ...baseline,
      cards: [
        { ...baseline.cards[0], title: "draft1" },
        { ...baseline.cards[1], title: "draft2" },
      ],
    };
    const newPublished: DashboardSnapshot = {
      ...baseline,
      cards: [
        { ...baseline.cards[0], title: "pub1" },
        { ...baseline.cards[1], title: "pub2" },
      ],
    };
    const result = publishDraftMerge(draft, newPublished, baseline);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Pure: rebaseDraftSnapshot
// ---------------------------------------------------------------------------

describe("rebaseDraftSnapshot", () => {
  it("fast-forwards cleanly when only published has moved (new card)", () => {
    const baseline = snapshot([card("c1")]);
    const draft = snapshot([card("c1")]);
    const newPublished = snapshot([card("c1"), card("c2", { position: 1 })]);
    const result = rebaseDraftSnapshot(draft, newPublished, baseline, "2026-05-17T01:00:00.000Z");
    expect(result.kind).toBe("fast_forward");
    if (result.kind !== "fast_forward") return;
    expect(result.snapshot.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(result.newBaselineAt).toBe("2026-05-17T01:00:00.000Z");
  });

  it("keeps draft-only additions after rebase", () => {
    const baseline = snapshot([card("c1")]);
    const draftWithAdd = applyChangeToDraft(baseline, { kind: "addCard", card: card("c-draft", { position: 1 }) });
    expect(draftWithAdd.ok).toBe(true);
    if (!draftWithAdd.ok) return;
    const newPublished = snapshot([card("c1")]);
    const result = rebaseDraftSnapshot(
      draftWithAdd.snapshot,
      newPublished,
      baseline,
      "2026-05-17T01:00:00.000Z",
    );
    expect(result.kind).toBe("fast_forward");
    if (result.kind !== "fast_forward") return;
    expect(result.snapshot.cards.map((c) => c.id)).toEqual(["c1", "c-draft"]);
  });

  it("adopts published-only changes when the draft hasn't touched that card", () => {
    const baseline = snapshot([card("c1", { title: "v1" })]);
    const draft = snapshot([card("c1", { title: "v1" })]);
    const newPublished = snapshot([card("c1", { title: "v2 from teammate" })]);
    const result = rebaseDraftSnapshot(draft, newPublished, baseline, "2026-05-17T01:00:00.000Z");
    expect(result.kind).toBe("fast_forward");
    if (result.kind !== "fast_forward") return;
    expect(result.snapshot.cards[0].title).toBe("v2 from teammate");
  });

  it("surfaces conflicts when both sides changed the same card", () => {
    const baseline = snapshot([card("c1", { title: "v1" })]);
    const draft = snapshot([card("c1", { title: "draft" })]);
    const newPublished = snapshot([card("c1", { title: "teammate" })]);
    const result = rebaseDraftSnapshot(draft, newPublished, baseline, "2026-05-17T01:00:00.000Z");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts[0].kind).toBe("card_mutated_in_published");
  });

  it("flags missing-in-published as a conflict for cards present in baseline + draft", () => {
    const baseline = snapshot([card("c1"), card("c2")]);
    const draft = snapshot([card("c1"), card("c2", { title: "edited" })]);
    const newPublished = snapshot([card("c1")]);
    const result = rebaseDraftSnapshot(draft, newPublished, baseline, "2026-05-17T01:00:00.000Z");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts[0].kind).toBe("card_missing_in_published");
    expect(result.conflicts[0].cardId).toBe("c2");
  });

  it("prefers draft meta over baseline when both moved", () => {
    const baseline = snapshot([], { title: "v1" });
    const draft = snapshot([], { title: "draft-title" });
    const newPublished = snapshot([], { title: "teammate-title" });
    const result = rebaseDraftSnapshot(draft, newPublished, baseline, "2026-05-17T01:00:00.000Z");
    expect(result.kind).toBe("fast_forward");
    if (result.kind !== "fast_forward") return;
    // Draft's title diverged from baseline → keep draft's version.
    expect(result.snapshot.title).toBe("draft-title");
  });
});

// ---------------------------------------------------------------------------
// Pure: materializeDraftView
// ---------------------------------------------------------------------------

describe("materializeDraftView", () => {
  it("overlays draft meta + cards onto the published row", () => {
    const published = dashboardWithCards([card("c1", { title: "pub" })], {
      title: "Published Title",
      shareToken: "tok",
    });
    const draft = snapshot([card("c1", { title: "draft" }), card("c2", { position: 1 })], {
      title: "Draft Title",
    });
    const view = materializeDraftView(published, draft);
    expect(view.title).toBe("Draft Title");
    expect(view.cards).toHaveLength(2);
    expect(view.cards[0].title).toBe("draft");
    expect(view.cards[1].title).toBe("Card c2");
    // Untracked fields fall through from published.
    expect(view.shareToken).toBe("tok");
  });

  it("preserves cached_columns / cached_rows / cachedAt from the matching published card", () => {
    // Without this fall-through, a draft view would render cards as
    // empty placeholders even when the user only changed the title.
    const baseCard = card("c1", { title: "pub" });
    // Build the published row directly so we can inject the cached-*
    // fields that the dashboardWithCards helper hard-nulls.
    const publishedCardRow: DashboardCard = {
      id: baseCard.id,
      dashboardId: "dash-1",
      position: baseCard.position,
      title: baseCard.title,
      kind: "chart",
      sql: baseCard.sql,
      chartConfig: baseCard.chartConfig,
      content: null,
      annotations: [],
      cachedColumns: ["a", "b"],
      cachedRows: [{ a: 1, b: 2 }],
      cachedAt: "2026-05-01T00:00:00.000Z",
      connectionGroupId: baseCard.connectionGroupId,
      layout: baseCard.layout,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const published: DashboardWithCards = {
      ...dashboardWithCards([], {}),
      cards: [publishedCardRow],
    };
    const draft = snapshot([{ ...baseCard, title: "draft" }], {});
    const view = materializeDraftView(published, draft);
    expect(view.cards[0].cachedColumns).toEqual(["a", "b"]);
    expect(view.cards[0].cachedRows).toEqual([{ a: 1, b: 2 }]);
    expect(view.cards[0].cachedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("falls back to published.updatedAt for card timestamps instead of new Date()", () => {
    // Forward-compat: a draft view rendered twice should show the
    // same card timestamps (so ordering-by-updated_at consumers
    // don't see "everything edited just now"). New cards (no matching
    // published row) inherit the parent dashboard's updatedAt as a
    // best-effort fallback.
    const published = dashboardWithCards([card("c1", { title: "pub" })], {
      updatedAt: "2026-05-10T00:00:00.000Z",
    });
    const draft = snapshot(
      [card("c1", { title: "draft" }), card("c2", { position: 1, title: "new" })],
      { title: "Draft Title" },
    );
    const view = materializeDraftView(published, draft);
    expect(view.cards[1].updatedAt).toBe("2026-05-10T00:00:00.000Z");
    expect(view.cards[1].createdAt).toBe("2026-05-10T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// DB-touching helpers — mock pool
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

let connectCalls = 0;
let clientCalls: Array<{ sql: string; params?: unknown[] }> = [];
let clientResults: Array<{ rows: Record<string, unknown>[] }> = [];
let clientResultIndex = 0;
let clientThrow: Error | null = null;
let releaseCalls = 0;

const mockClient: InternalPoolClient = {
  query: async (sql: string, params?: unknown[]) => {
    if (clientThrow) throw clientThrow;
    clientCalls.push({ sql, params });
    const result = clientResults[clientResultIndex] ?? { rows: [] };
    clientResultIndex++;
    return result;
  },
  release: () => {
    releaseCalls++;
  },
};

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    connectCalls++;
    return mockClient;
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

function setClientResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  clientResults = results;
  clientResultIndex = 0;
}

/** Builds a draft DB row that includes the persisted baseline column. */
function draftRow(opts: {
  userId?: string;
  dashboardId?: string;
  draft: DashboardSnapshot;
  baseline?: DashboardSnapshot;
  publishedBaselineAt?: string;
}): Record<string, unknown> {
  return {
    user_id: opts.userId ?? "u1",
    dashboard_id: opts.dashboardId ?? "dash-1",
    draft: opts.draft,
    baseline: opts.baseline ?? opts.draft,
    published_baseline_at: opts.publishedBaselineAt ?? "2026-05-17T00:00:00.000Z",
    created_at: "2026-05-17T00:00:00.000Z",
    updated_at: "2026-05-17T00:00:00.000Z",
  };
}

describe("dashboard-versioning DB helpers", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    connectCalls = 0;
    clientCalls = [];
    clientResults = [];
    clientResultIndex = 0;
    clientThrow = null;
    releaseCalls = 0;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -------------------------------------------------------------------------
  // loadDraft
  // -------------------------------------------------------------------------

  describe("loadDraft", () => {
    it("returns null when DB is unavailable", async () => {
      const result = await loadDraft("u1", "dash-1");
      expect(result).toBeNull();
    });

    it("returns null when no row exists", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const result = await loadDraft("u1", "dash-1");
      expect(result).toBeNull();
    });

    it("parses a draft row into a DraftRow", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      setResults({
        rows: [
          {
            user_id: "u1",
            dashboard_id: "dash-1",
            draft: snap,
            baseline: snap,
            published_baseline_at: "2026-05-17T00:00:00.000Z",
            created_at: "2026-05-17T00:00:00.000Z",
            updated_at: "2026-05-17T00:00:00.000Z",
          },
        ],
      });
      const result = await loadDraft("u1", "dash-1");
      expect(result).not.toBeNull();
      expect(result?.userId).toBe("u1");
      expect(result?.snapshot.cards[0].id).toBe("c1");
      expect(result?.baseline.cards[0].id).toBe("c1");
    });

    it("returns null on DB error (and does not throw)", async () => {
      enableInternalDB();
      queryThrow = new Error("connection refused");
      const result = await loadDraft("u1", "dash-1");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // forkOrLoadDraft
  // -------------------------------------------------------------------------

  describe("forkOrLoadDraft", () => {
    it("loads the existing draft when present (no insert)", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      // First load returns existing row → skip insert; no second load needed.
      setResults({ rows: [draftRow({ draft: snap })] });
      const published = dashboardWithCards([card("c1")]);
      const result = await forkOrLoadDraft("u1", published);
      expect(result?.userId).toBe("u1");
      // Exactly one query — the initial load.
      expect(queryCalls.length).toBe(1);
      expect(queryCalls[0].sql).toContain("SELECT user_id, dashboard_id, draft");
    });

    it("inserts a fresh draft when no row exists then re-loads it", async () => {
      enableInternalDB();
      const published = dashboardWithCards([card("c1")]);
      // 1: initial load — empty. 2: INSERT — no rows return. 3: re-load.
      const snap = forkDraftFromPublished(published);
      setResults(
        { rows: [] },
        { rows: [] },
        {
          rows: [
            draftRow({ draft: snap, baseline: snap, publishedBaselineAt: published.updatedAt }),
          ],
        },
      );
      const result = await forkOrLoadDraft("u1", published);
      expect(result?.userId).toBe("u1");
      expect(queryCalls[1].sql).toContain("INSERT INTO dashboard_user_drafts");
      expect(queryCalls[1].sql).toContain("ON CONFLICT (user_id, dashboard_id) DO NOTHING");
      // INSERT params include the persisted baseline column.
      expect(queryCalls[1].params?.length).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // saveDraft
  // -------------------------------------------------------------------------

  describe("saveDraft", () => {
    it("returns true on a 1-row update", async () => {
      enableInternalDB();
      setResults({ rows: [{ user_id: "u1" }] });
      const ok = await saveDraft("u1", "dash-1", snapshot([card("c1")]));
      expect(ok).toBe(true);
      expect(queryCalls[0].sql).toContain("UPDATE dashboard_user_drafts");
    });

    it("returns false when no row matched", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const ok = await saveDraft("u1", "dash-1", snapshot([]));
      expect(ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // applyEditToDraft — the single seam every direct-manipulation REST route
  // funnels through (#4315). Exercises the real fork→apply→save wiring + all
  // four failure returns (the route tests mock this function out).
  // -------------------------------------------------------------------------

  describe("applyEditToDraft", () => {
    it("happy path: forks/loads, applies the change, saves, returns the draft view", async () => {
      enableInternalDB();
      const published = dashboardWithCards([card("c1")]);
      const snap = snapshot([card("c1")]);
      // forkOrLoadDraft loads the existing row (1 query), then saveDraft UPDATE.
      setResults({ rows: [draftRow({ draft: snap })] }, { rows: [{ user_id: "u1" }] });
      const result = await applyEditToDraft("u1", published, {
        kind: "updateMeta",
        title: "Renamed in draft",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.snapshot.title).toBe("Renamed in draft");
        expect(result.view.title).toBe("Renamed in draft");
      }
      // The persisted UPDATE targeted the draft table, never a published one.
      const sqls = queryCalls.map((q) => q.sql).join("\n");
      expect(sqls).toContain("UPDATE dashboard_user_drafts");
      expect(sqls).not.toContain("dashboard_cards");
    });

    it("returns no_db when the internal DB is not configured", async () => {
      // DB intentionally NOT enabled.
      const result = await applyEditToDraft("u1", dashboardWithCards([card("c1")]), {
        kind: "updateMeta",
        title: "x",
      });
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns load_failed (not no_db) when the DB is configured but the load throws", async () => {
      enableInternalDB();
      queryThrow = new Error("connection reset by peer");
      const result = await applyEditToDraft("u1", dashboardWithCards([card("c1")]), {
        kind: "updateMeta",
        title: "x",
      });
      expect(result).toEqual({ ok: false, reason: "load_failed" });
    });

    it("returns unknown_card when the change targets a card absent from the draft", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      setResults({ rows: [draftRow({ draft: snap })] });
      const result = await applyEditToDraft("u1", dashboardWithCards([card("c1")]), {
        kind: "updateCard",
        cardId: "does-not-exist",
        updates: { title: "nope" },
      });
      expect(result).toEqual({ ok: false, reason: "unknown_card", cardId: "does-not-exist" });
    });

    it("returns save_failed when the persist UPDATE matches no row", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      // load returns the row; saveDraft UPDATE returns no rows → false.
      setResults({ rows: [draftRow({ draft: snap })] }, { rows: [] });
      const result = await applyEditToDraft("u1", dashboardWithCards([card("c1")]), {
        kind: "updateMeta",
        title: "x",
      });
      expect(result).toEqual({ ok: false, reason: "save_failed" });
    });
  });

  // -------------------------------------------------------------------------
  // discardDraft
  // -------------------------------------------------------------------------

  describe("discardDraft", () => {
    it("issues a DELETE keyed on (user_id, dashboard_id)", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const ok = await discardDraft("u1", "dash-1");
      expect(ok).toBe(true);
      expect(queryCalls[0].sql).toContain("DELETE FROM dashboard_user_drafts");
      expect(queryCalls[0].params).toEqual(["u1", "dash-1"]);
    });
  });

  // -------------------------------------------------------------------------
  // publishDraft (transactional)
  // -------------------------------------------------------------------------

  describe("publishDraft (transactional)", () => {
    it("returns no_draft when nothing to publish", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // loadDraft → empty
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => dashboardWithCards([]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("no_draft");
    });

    it("returns dashboard_not_found when the parent dashboard is gone", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      setResults({ rows: [draftRow({ draft: snap })] });
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("dashboard_not_found");
    });

    it("returns stale_baseline when published has moved underneath the draft", async () => {
      enableInternalDB();
      const baseline = snapshot([card("c1", { title: "v1" })]);
      const draftSnap: DashboardSnapshot = {
        ...baseline,
        cards: [{ ...baseline.cards[0], title: "draft" }],
      };
      setResults({ rows: [draftRow({ draft: draftSnap, baseline })] });
      const newPublished = dashboardWithCards([card("c1", { title: "teammate" })], {
        updatedAt: "2026-05-17T02:00:00.000Z",
      });
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => newPublished,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // PRD user story 13 — "your baseline has changed" surface. The
      // route layer maps stale_baseline → 409 + a rebase affordance.
      expect(result.reason).toBe("stale_baseline");
    });

    it("returns conflict when persisted baseline says BOTH sides edited the same card", async () => {
      // Real three-way merge: baseline persisted at fork time, draft
      // and published BOTH diverged. Demonstrates publishDraftMerge's
      // `card_mutated_in_published` conflict surfaces through the
      // DB-wrapper exactly as the pure tests assert.
      enableInternalDB();
      const baseline = snapshot([card("c1", { title: "v1" })]);
      const draftSnap: DashboardSnapshot = {
        ...baseline,
        cards: [{ ...baseline.cards[0], title: "draft" }],
      };
      // Stash the baseline distinct from current published — the route
      // would have called rebase to bump baselineAt = current published.
      setResults({
        rows: [
          draftRow({
            draft: draftSnap,
            baseline,
            publishedBaselineAt: "2026-05-17T02:00:00.000Z",
          }),
        ],
      });
      const newPublished = dashboardWithCards(
        [card("c1", { title: "teammate" })],
        { updatedAt: "2026-05-17T02:00:00.000Z" }, // matches baselineAt
      );
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => newPublished,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("conflict");
    });

    it("issues BEGIN/COMMIT and applies the ops + draft delete in a single transaction", async () => {
      enableInternalDB();
      const baselineCards: DashboardSnapshotCard[] = [card("c1")];
      const baseline = snapshot(baselineCards);
      // Draft adds a card.
      const draftWithAdd = applyChangeToDraft(baseline, { kind: "addCard", card: card("c-new", { position: 1 }) });
      expect(draftWithAdd.ok).toBe(true);
      if (!draftWithAdd.ok) return;

      setResults({
        rows: [draftRow({ draft: draftWithAdd.snapshot, baseline })],
      });

      // BEGIN, SELECT updated_at FOR UPDATE (lock + re-check), INSERT
      // card, touch dashboards, DELETE draft, COMMIT.
      setClientResults(
        { rows: [] }, // BEGIN
        { rows: [{ updated_at: "2026-05-17T00:00:00.000Z" }] }, // SELECT FOR UPDATE
        { rows: [] }, // INSERT INTO dashboard_cards
        { rows: [] }, // UPDATE dashboards SET updated_at
        { rows: [] }, // DELETE FROM dashboard_user_drafts
        { rows: [] }, // COMMIT
      );

      const published = dashboardWithCards([card("c1")], {
        updatedAt: "2026-05-17T00:00:00.000Z", // matches baselineAt
      });

      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => published,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(connectCalls).toBe(1);
      expect(clientCalls[0].sql).toBe("BEGIN");
      const commitIdx = clientCalls.findIndex((c) => c.sql === "COMMIT");
      expect(commitIdx).toBeGreaterThan(-1);
      const sqls = clientCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("INSERT INTO dashboard_cards");
      expect(sqls).toContain("DELETE FROM dashboard_user_drafts");
      // Pool client returned exactly once.
      expect(releaseCalls).toBe(1);
    });

    // Regression: an accepted `editSql` stage rewrites the draft card's SQL,
    // which surfaces as an updateCard op — the publish UPDATE must persist it
    // (it previously wrote every field EXCEPT sql, silently dropping the edit).
    it("persists an edited card's SQL in the publish updateCard path", async () => {
      enableInternalDB();
      const baseline = snapshot([card("c1")]);
      const draftEdit = applyChangeToDraft(baseline, {
        kind: "editSql",
        cardId: "c1",
        newSql: "SELECT 2 AS edited",
      });
      expect(draftEdit.ok).toBe(true);
      if (!draftEdit.ok) return;

      setResults({ rows: [draftRow({ draft: draftEdit.snapshot, baseline })] });
      setClientResults(
        { rows: [] }, // BEGIN
        { rows: [{ updated_at: "2026-05-17T00:00:00.000Z" }] }, // SELECT FOR UPDATE
        { rows: [] }, // UPDATE dashboard_cards
        { rows: [] }, // UPDATE dashboards touch
        { rows: [] }, // DELETE draft
        { rows: [] }, // COMMIT
      );

      const published = dashboardWithCards([card("c1")], {
        updatedAt: "2026-05-17T00:00:00.000Z",
      });
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => published,
      });
      expect(result.ok).toBe(true);

      const updateCall = clientCalls.find(
        (c) => /UPDATE dashboard_cards/.test(c.sql) && /\bsql =/.test(c.sql),
      );
      expect(updateCall).toBeDefined();
      // The new SQL is bound, not dropped.
      expect(updateCall!.params).toContain("SELECT 2 AS edited");
    });

    it("rolls back on transaction error and returns error", async () => {
      enableInternalDB();
      const baseline = snapshot([card("c1")]);
      const draftAdd = applyChangeToDraft(baseline, { kind: "addCard", card: card("c-new", { position: 1 }) });
      expect(draftAdd.ok).toBe(true);
      if (!draftAdd.ok) return;
      setResults({ rows: [draftRow({ draft: draftAdd.snapshot, baseline })] });
      // BEGIN + SELECT FOR UPDATE succeed, then the next op throws.
      let serviced = 0;
      clientThrow = null;
      clientCalls = [];
      const customClient: InternalPoolClient = {
        query: async (sql: string, params?: unknown[]) => {
          clientCalls.push({ sql, params });
          serviced++;
          // 1. BEGIN
          if (serviced === 1) return { rows: [] };
          // 2. SELECT updated_at FOR UPDATE — return matching baseline
          //    so the in-tx stale guard passes and we proceed to the
          //    real op (which throws on call 3).
          if (serviced === 2) {
            return { rows: [{ updated_at: "2026-05-17T00:00:00.000Z" }] };
          }
          if (sql === "ROLLBACK") return { rows: [] };
          throw new Error("synthetic op failure");
        },
        release: () => {
          releaseCalls++;
        },
      };
      const customPool: InternalPool = {
        ...mockPool,
        connect: async () => customClient,
      };
      _resetPool(customPool);

      const published = dashboardWithCards([card("c1")], {
        updatedAt: "2026-05-17T00:00:00.000Z",
      });

      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => published,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("error");
      expect(clientCalls.some((c) => c.sql === "ROLLBACK")).toBe(true);
      expect(releaseCalls).toBe(1);
    });

    it("returns stale_baseline (with currentBaselineAt) when SELECT FOR UPDATE sees published moved post-pre-check", async () => {
      // Concurrent-publish race: pre-tx check passes (published.updatedAt
      // == draftRow.publishedBaselineAt), but inside the transaction the
      // FOR UPDATE select sees a NEWER updated_at because another user's
      // publish committed in the gap. The lock catches it, rolls back,
      // and returns stale_baseline with the new baseline so the UI can
      // surface "X changed since you last loaded the draft" without a
      // second round-trip.
      enableInternalDB();
      const baseline = snapshot([card("c1")]);
      const draftAdd = applyChangeToDraft(baseline, {
        kind: "addCard",
        card: card("c-new", { position: 1 }),
      });
      expect(draftAdd.ok).toBe(true);
      if (!draftAdd.ok) return;
      setResults({
        rows: [
          draftRow({
            draft: draftAdd.snapshot,
            baseline,
            publishedBaselineAt: "2026-05-17T00:00:00.000Z",
          }),
        ],
      });
      setClientResults(
        { rows: [] }, // BEGIN
        // SELECT updated_at FOR UPDATE — another user's publish already
        // committed; the locked row shows a NEWER timestamp than the
        // draft's persisted baseline.
        { rows: [{ updated_at: "2026-05-17T05:00:00.000Z" }] },
        { rows: [] }, // ROLLBACK
      );

      const published = dashboardWithCards([card("c1")], {
        // Pre-tx check still matches (cached read) so the race is
        // realistic — only the lock catches it.
        updatedAt: "2026-05-17T00:00:00.000Z",
      });
      const result = await publishDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => published,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("stale_baseline");
      if (result.reason !== "stale_baseline") return;
      expect(result.currentBaselineAt).toBe("2026-05-17T05:00:00.000Z");
      // Rolled back, no DELETE / INSERT happened.
      const sqls = clientCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("ROLLBACK");
      expect(sqls).not.toContain("INSERT INTO dashboard_cards");
      expect(sqls).not.toContain("DELETE FROM dashboard_user_drafts");
    });
  });

  // -------------------------------------------------------------------------
  // rebaseDraft
  // -------------------------------------------------------------------------

  describe("rebaseDraft", () => {
    it("fast-forwards and persists the new baseline timestamp", async () => {
      enableInternalDB();
      const baseline = snapshot([card("c1")]);
      // Draft equals baseline; published added c2.
      setResults(
        // loadDraft
        { rows: [draftRow({ draft: baseline, baseline })] },
        // UPDATE dashboard_user_drafts
        { rows: [{ user_id: "u1" }] },
      );
      const newPublished = dashboardWithCards(
        [card("c1"), card("c2", { position: 1 })],
        { updatedAt: "2026-05-17T02:00:00.000Z" },
      );
      const result = await rebaseDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => newPublished,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
      expect(result.newBaselineAt).toBe("2026-05-17T02:00:00.000Z");
      // Second query is the UPDATE; params: [draft, baseline, baselineAt, user, dash]
      const updateCall = queryCalls[1];
      expect(updateCall.sql).toContain("UPDATE dashboard_user_drafts");
      expect(updateCall.sql).toContain("baseline = $2");
      expect(updateCall.params?.[2]).toBe("2026-05-17T02:00:00.000Z");
    });

    it("returns conflict and does not persist when both sides changed the same card", async () => {
      enableInternalDB();
      const baseline = snapshot([card("c1", { title: "v1" })]);
      const draftSnap: DashboardSnapshot = {
        ...baseline,
        cards: [{ ...baseline.cards[0], title: "draft" }],
      };
      setResults({ rows: [draftRow({ draft: draftSnap, baseline })] });
      const newPublished = dashboardWithCards([card("c1", { title: "teammate" })], {
        updatedAt: "2026-05-17T02:00:00.000Z",
      });
      const result = await rebaseDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => newPublished,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("conflict");
      // Exactly one query — the loadDraft — no UPDATE.
      expect(queryCalls.length).toBe(1);
    });

    it("short-circuits without an UPDATE when published hasn't moved", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      setResults({
        rows: [
          draftRow({
            draft: snap,
            baseline: snap,
            publishedBaselineAt: "2026-05-17T00:00:00.000Z",
          }),
        ],
      });
      const published = dashboardWithCards([card("c1")], {
        updatedAt: "2026-05-17T00:00:00.000Z",
      });
      const result = await rebaseDraft({
        userId: "u1",
        dashboardId: "dash-1",
        orgId: "org-1",
        loadDashboardForOrg: async () => published,
      });
      expect(result.ok).toBe(true);
      // Only the load — no UPDATE.
      expect(queryCalls.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent edits within the same user → same draft row
  // (acceptance-criteria check, exercised via mock pool to keep unit fast)
  // -------------------------------------------------------------------------

  describe("concurrent edit isolation", () => {
    it("two forkOrLoadDraft calls in the same user converge on the same row", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      const row = draftRow({ draft: snap });
      // Both forkOrLoadDraft calls hit existing-row path → single SELECT each.
      setResults({ rows: [row] }, { rows: [row] });
      const published = dashboardWithCards([card("c1")]);
      const [a, b] = await Promise.all([
        forkOrLoadDraft("u1", published),
        forkOrLoadDraft("u1", published),
      ]);
      expect(a?.userId).toBe("u1");
      expect(b?.userId).toBe("u1");
      expect(a?.dashboardId).toBe(b?.dashboardId);
    });

    it("two different users get distinct draft rows", async () => {
      enableInternalDB();
      const snap = snapshot([card("c1")]);
      setResults(
        { rows: [draftRow({ userId: "u1", draft: snap })] },
        { rows: [draftRow({ userId: "u2", draft: snap })] },
      );
      const published = dashboardWithCards([card("c1")]);
      const u1 = await forkOrLoadDraft("u1", published);
      const u2 = await forkOrLoadDraft("u2", published);
      expect(u1?.userId).toBe("u1");
      expect(u2?.userId).toBe("u2");
      // Each load issued ONE SELECT — independent rows.
      expect(queryCalls.length).toBe(2);
      expect(queryCalls.every((c) => c.sql.includes("SELECT"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // toSnapshot pure helper
  // -------------------------------------------------------------------------

  describe("toSnapshot", () => {
    it("strips published-only fields (shareToken, refreshSchedule, etc.)", () => {
      const published = dashboardWithCards([card("c1")], {
        shareToken: "tok",
        refreshSchedule: "0 * * * *",
      });
      const snap = toSnapshot(published);
      // Snapshot type doesn't include those keys.
      expect("shareToken" in snap).toBe(false);
      expect("refreshSchedule" in snap).toBe(false);
      expect(snap.cards[0].id).toBe("c1");
    });
  });
});
