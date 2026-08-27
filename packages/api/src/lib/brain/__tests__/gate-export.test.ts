/**
 * Unit coverage for the gate-decision export (#5335).
 *
 * Everything here runs against a literal handle — the module takes a
 * structural `GateExportReader`, so no `mock.module()` and no singleton. The
 * questions that need a real database (are the three classes actually
 * reachable? does a purged workspace really export zero rows?) live in
 * `gate-export-pg.test.ts`; what this file pins is the SHAPE: which columns can
 * possibly leave, how the classes are labelled, and that each refusal is
 * fail-closed rather than a partial bundle.
 */
import { describe, expect, it } from "bun:test";
import {
  EVALUATION_ONLY_NOTICE,
  GATE_DECISION_CLASSES,
  GATE_EXPORT_REFUSALS,
  buildGateExportBundle,
  checkRegionContainment,
  approvalRateOf,
  loadGateDecisions,
  summarizeGateDecisions,
  type GateDecision,
  type GateExportReader,
} from "@atlas/api/lib/brain/gate-export";

/** A reader that returns the given rows and records the SQL it was handed. */
function readerOf(rows: readonly unknown[]): GateExportReader & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string) => {
      sql.push(text);
      return { rows };
    },
  };
}

/** One raw row in the shape the projection produces. */
function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "positive",
    episode_id: "ep-1",
    source: "slack",
    source_id: "C1:100",
    source_actor: "slack:U1",
    body: "ship it",
    locator: null,
    occurred_at: "2026-08-01T00:00:00.000Z",
    ingested_at: "2026-08-01T00:00:01.000Z",
    episode_extracted_at: "2026-08-01T00:00:02.000Z",
    episode_visible_to: ["org"],
    fact_id: "fact-1",
    subject: "Ana",
    predicate: "leads",
    object: "Platform",
    status: "published",
    fact_extracted_at: "2026-08-01T00:00:02.000Z",
    invalidated_at: null,
    fact_visible_to: ["org"],
    actor: "slack:U1",
    provenance_source_id: "C1:100",
    ...over,
  };
}

describe("gate export — the evaluation-only contract", () => {
  it("carries the notice in the BUNDLE, not only in the source", async () => {
    const built = await buildGateExportBundle(readerOf([]), {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // A bundle outlives the process that cut it. The prohibition has to be a
    // string in the file, readable by someone who never opened this repo.
    expect(built.bundle.notice).toBe(EVALUATION_ONLY_NOTICE);
    expect(built.bundle.notice).toContain("EVALUATION ONLY");
    expect(built.bundle.notice).toContain("never a training corpus");
    expect(built.bundle.notice).toContain("5339");
  });

  it("names exactly three decision classes", () => {
    expect([...GATE_DECISION_CLASSES]).toEqual(["positive", "rejected", "negative"]);
  });
});

describe("gate export — what can possibly leave", () => {
  it("never projects the provenance jsonb whole", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    const sql = reader.sql.join("\n");
    // The column holds a PINNED SQL statement plus a data snapshot for
    // warehouse-derived facts. `SELECT provenance` would put arbitrary
    // operator-authored SQL and its result set into a file that leaves the
    // machine, which is exactly what the settings-audit posture forbids.
    expect(sql).not.toMatch(/f\.provenance(?!->>)/);
    expect(sql).toContain("f.provenance->>'actor'");
    expect(sql).toContain("f.provenance->>'sourceId'");
  });

  it("never projects extraction_batch_id — a vendor handle only one region's key can poll", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    expect(reader.sql.join("\n")).not.toContain("extraction_batch_id");
  });

  it("uses no SELECT * over a brain table", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    const sql = reader.sql.join("\n");
    // A column added to `brain_episodes` later must be a deliberate decision to
    // export, never a silent consequence of a migration.
    expect(sql).not.toMatch(/SELECT\s+\*\s+FROM\s+brain_/i);
  });

  it("requires POSITIVE evidence of the human act for a rejection", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    const sql = reader.sql.join("\n");
    // `retract` is not the only writer of `invalidated_at` — `admin-migrate.ts`
    // lands unkeyable imported facts tombstoned (#5047) and migration 0194 did
    // the same in place. A bare tombstone test would label those import
    // artifacts as human rejections and poison #5338's measurement.
    expect(sql).toContain("'derives-from'");
    expect(sql).toContain("ce.source = 'human'");
  });

  it("only calls an episode silent when every claim on it is archived, or there are none", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    // A negative asserts the extractor produced nothing a reviewer promoted and
    // nothing is pending. Any non-archived claim — a live draft, or a tombstone
    // with no correction episode behind it — means the extractor DID speak, so
    // the episode must not be labelled silent.
    expect(reader.sql.join("\n")).toContain("f.status <> 'archived'");
  });

  it("excludes warehouse observations on BOTH grains", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    const sql = reader.sql.join("\n");
    // A human made no call on a machine reading of a column (ADR-0042), so
    // carrying one would dilute every measurement built on the corpus.
    expect(sql).toContain("f.provenance->>'source' = ANY");
    expect(sql).toContain("e.source = ANY");
  });

  it("orders totally, so two exports of an unchanged workspace agree", async () => {
    const reader = readerOf([]);
    await loadGateDecisions(reader, "ws-1");
    expect(reader.sql.join("\n")).toContain(
      "ORDER BY occurred_at NULLS LAST, episode_id, fact_id NULLS FIRST",
    );
  });
});

describe("gate export — refusals are fail-closed", () => {
  it("refuses a workspace resident in another region", () => {
    const refusal = checkRegionContainment("us", "eu");
    expect(refusal?.refusal).toBe(GATE_EXPORT_REFUSALS.regionBoundary);
    expect(refusal?.detail).toContain("eu");
    expect(refusal?.detail).toContain("us");
  });

  it("allows a matching region, and a workspace with no region assigned", () => {
    expect(checkRegionContainment("us", "us")).toBeNull();
    // An unassigned workspace is a NEW one, not a foreign one — the same call
    // `detectMisrouting` makes. Refusing it would block the export on a
    // condition the operator cannot fix from here, and on a self-hosted
    // deployment (no regions anywhere) it would block every export.
    expect(checkRegionContainment("us", null)).toBeNull();
    expect(checkRegionContainment(null, null)).toBeNull();
  });

  it("REFUSES when the workspace has a region and this process cannot name its own", () => {
    // The `--database-url` path from an operator laptop: no ATLAS_API_REGION,
    // so containment is unproven. Unproven fails closed — the first cut
    // returned null here, which made the criterion nearly unreachable on the
    // one invocation that can point at any region on earth.
    const refusal = checkRegionContainment(null, "eu");
    expect(refusal?.refusal).toBe(GATE_EXPORT_REFUSALS.regionBoundary);
    expect(refusal?.detail).toContain("ATLAS_API_REGION");
  });

  it("refuses the whole workspace when one EPISODE grant is unrepresentable", async () => {
    const result = await loadGateDecisions(
      readerOf([rawRow({ episode_visible_to: ["org", "everyone"] })]),
      "ws-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.refusal).toBe(GATE_EXPORT_REFUSALS.unrepresentableGrant);
    expect(result.refusal.detail).toContain("ep-1");
  });

  it("refuses the whole workspace when one FACT grant is unrepresentable", async () => {
    const result = await loadGateDecisions(
      readerOf([rawRow({ fact_visible_to: ["nonsense"] })]),
      "ws-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.refusal).toBe(GATE_EXPORT_REFUSALS.unrepresentableGrant);
    expect(result.refusal.detail).toContain("fact-1");
  });

  it("refuses rather than dropping the row — a bundle's gaps must not be invisible", async () => {
    const result = await loadGateDecisions(
      readerOf([rawRow(), rawRow({ episode_id: "ep-2", episode_visible_to: [null] })]),
      "ws-1",
    );
    // The good row is NOT returned alongside a warning. An operator who asked
    // for a workspace and received some of it has a corpus whose measurements
    // are silently wrong.
    expect(result.ok).toBe(false);
  });

  it("region containment refuses BEFORE the query runs", async () => {
    const reader = readerOf([rawRow()]);
    const built = await buildGateExportBundle(reader, {
      workspaceId: "ws-1",
      apiRegion: "us",
      workspaceRegion: "apac",
    });
    expect(built.ok).toBe(false);
    // Not merely "no file written" — no tenant content was READ across the
    // boundary either.
    expect(reader.sql).toHaveLength(0);
  });

  it("throws on an unknown decision class rather than defaulting it", async () => {
    await expect(
      loadGateDecisions(readerOf([rawRow({ decision: "maybe" })]), "ws-1"),
    ).rejects.toThrow(/unknown decision class/);
  });
});

describe("gate export — analytics", () => {
  function decision(over: Partial<GateDecision> = {}): GateDecision {
    return {
      decision: "positive",
      episode: {
        id: "ep",
        source: "slack",
        sourceId: "s",
        sourceActor: null,
        body: null,
        locator: null,
        occurredAt: null,
        ingestedAt: "2026-08-01T00:00:00.000Z",
        extractedAt: null,
        visibleTo: ["org"],
      },
      fact: null,
      ...over,
    };
  }

  const fact = (over: Record<string, unknown> = {}) => ({
    id: "f",
    subject: "Ana",
    predicate: "leads",
    object: "Platform",
    status: "published",
    extractedAt: null,
    invalidatedAt: null,
    visibleTo: ["org"],
    actor: null,
    provenanceSourceId: null,
    ...over,
  });

  it("reports null — never 0% — when nothing has been decided", () => {
    const summary = summarizeGateDecisions([decision({ decision: "negative" })]);
    // An unstarted queue and a reviewer who rejects everything are different
    // states, and only one of them is alarming.
    expect(summary.approvalRate).toBeNull();
    expect(summary.negatives).toBe(1);
  });

  it("computes the approval rate over DECIDED claims only", () => {
    const summary = summarizeGateDecisions([
      decision({ fact: fact() }),
      decision({ fact: fact() }),
      decision({ fact: fact() }),
      decision({ decision: "rejected", fact: fact({ invalidatedAt: "2026-08-02T00:00:00.000Z" }) }),
      // Negatives must not dilute the rate — the extractor staying silent is
      // not a reviewer rejecting anything.
      decision({ decision: "negative" }),
      decision({ decision: "negative" }),
    ]);
    expect(summary.positives).toBe(3);
    expect(summary.rejected).toBe(1);
    expect(summary.negatives).toBe(2);
    expect(summary.approvalRate).toBe(0.75);
  });

  it("ranks rejected predicates by count, then by name — a total order", () => {
    const reject = (predicate: string) =>
      decision({
        decision: "rejected",
        fact: fact({ predicate, invalidatedAt: "2026-08-02T00:00:00.000Z" }),
      });
    const summary = summarizeGateDecisions([
      reject("owns"),
      reject("owns"),
      reject("beta"),
      reject("alpha"),
    ]);
    expect(summary.topRejectedPredicates).toEqual([
      { predicate: "owns", rejections: 2 },
      // Ties break on the name so the panel does not reshuffle between reads.
      { predicate: "alpha", rejections: 1 },
      { predicate: "beta", rejections: 1 },
    ]);
  });

  it("times RETRACTIONS only, and reports null when none carries both stamps", () => {
    // An approval leaves no timestamp of its own, so there is no approval clock
    // to median. The field name says retraction rather than implying one.
    expect(summarizeGateDecisions([decision({ fact: fact() })]).medianHoursToRetraction).toBeNull();

    const summary = summarizeGateDecisions([
      decision({
        decision: "rejected",
        fact: fact({
          extractedAt: "2026-08-01T00:00:00.000Z",
          invalidatedAt: "2026-08-01T02:00:00.000Z",
        }),
      }),
      decision({
        decision: "rejected",
        fact: fact({
          extractedAt: "2026-08-01T00:00:00.000Z",
          invalidatedAt: "2026-08-01T04:00:00.000Z",
        }),
      }),
    ]);
    expect(summary.medianHoursToRetraction).toBe(3);
  });

  it("excludes positives from the retraction clock rather than counting them as zero", () => {
    const summary = summarizeGateDecisions([
      decision({ fact: fact({ extractedAt: "2026-08-01T00:00:00.000Z" }) }),
      decision({
        decision: "rejected",
        fact: fact({
          extractedAt: "2026-08-01T00:00:00.000Z",
          invalidatedAt: "2026-08-01T06:00:00.000Z",
        }),
      }),
    ]);
    // Six, not three: the positive is absent from the sample, not a zero in it.
    expect(summary.medianHoursToRetraction).toBe(6);
  });

  it("shares one approval-rate function with the reader-scoped panel", () => {
    // A bundle and a panel disagreeing in the third decimal gets investigated
    // as a data bug, so the rounding lives in one place.
    expect(approvalRateOf(0, 0)).toBeNull();
    expect(approvalRateOf(3, 1)).toBe(0.75);
    expect(approvalRateOf(1, 2)).toBe(0.333);
  });
});
