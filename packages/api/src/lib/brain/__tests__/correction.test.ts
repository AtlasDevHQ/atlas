/**
 * The correction verbs' decision matrix (#4915, ADR-0036 §T4).
 *
 * Drives `correctFact` against an in-memory store that dispatches on the
 * module's EXPORTED SQL constants — the same harness shape as
 * `reconcile.test.ts`, and for the same reason: what needs pinning here is
 * WHICH statement each verb runs and which it must never run, and a string
 * dispatch makes "supersede executed the publish adapter's own
 * `SUPERSEDE_STAMP_SQL`" a literal identity check rather than a paraphrase.
 * The statements-parse-and-do-that half lives in `candidates-pg.test.ts` §7.
 *
 * The load-bearing claims, each with a test on the arm it must take:
 *   - retract is the ONLY tombstone writer, and flagging dependents is a
 *     provenance marker — NOTHING about a dependent's lifecycle changes;
 *   - supersede reuses #4912's stamp+edge path byte-for-byte and publishes
 *     the replacement inside the same transaction (no draft queue);
 *   - tier-1 (warehouse-derived) targets are refused for every verb;
 *   - a correction is admin-authority, ACL-gated, and episode-recorded.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CORRECTION_EPISODE_INSERT_SQL,
  CORRECTION_REFUSAL_REASONS,
  CORRECTION_VERBS,
  DEPENDENT_FACTS_SQL,
  DERIVES_FROM_EDGE_SQL,
  MERGE_PROVENANCE_MARKER_SQL,
  PROMOTE_CORRECTION_FACT_SQL,
  REPLACEMENT_ROW_SQL,
  RETRACT_FACT_SQL,
  correctFact,
  isWarehouseDerived,
  type CorrectionRequest,
} from "@atlas/api/lib/brain/correction";
import {
  CORROBORATION_LOOKUP_SQL,
  INSERT_FACT_SQL,
  INSERT_PROVENANCE_EDGE_SQL,
  INSERT_TENSION_EDGE_SQL,
  RECONCILE_LOCK_SQL,
  TENSION_CANDIDATES_SQL,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  INSERT_SUPERSEDES_EDGES_SQL,
  SUPERSEDE_STAMP_SQL,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const WS = "ws-correction";
const NOW = new Date("2026-07-30T12:00:00.000Z");

function admin(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "admin-1",
    role: "admin",
    audienceIds: [],
  };
}

function member(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "member-1",
    role: "member",
    audienceIds: [],
  };
}

// ---------------------------------------------------------------------------
// A store that answers exactly the statements the verbs issue
// ---------------------------------------------------------------------------

interface StoredFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** Set only by the reconcile insert; seeded facts default to null. */
  validFrom?: string | null;
  status: string;
  cardinality: string;
  provenance: Record<string, unknown>;
  visibleTo: string[];
  validTo: string | null;
  invalidatedAt: string | null;
  sourceEpisodeId: string;
  /** Simulates the ACL predicate: a hidden fact never comes back. */
  hidden?: boolean;
}

interface StoredEpisode {
  id: string;
  sourceId: string;
  sourceActor: string;
  body: string;
  occurredAt: string;
  visibleTo: string[];
  extractedAt: string | null;
}

interface StoredEdge {
  edgeType: string;
  fromFactId: string;
  toFactId: string | null;
  toEpisodeId: string | null;
}

class FakeCorrectionStore {
  readonly facts: StoredFact[] = [];
  readonly episodes: StoredEpisode[] = [];
  readonly edges: StoredEdge[] = [];
  /** Every statement executed, in order — the identity assertions read this. */
  readonly executed: string[] = [];
  transactions = 0;
  private seq = 0;

  readonly runner: ReconcileTransactionRunner = async <T>(
    fn: (tx: ReconcileExecutor) => Promise<T>,
  ): Promise<T> => {
    this.transactions++;
    return fn({ query: (sql, params) => this.query(sql, params ?? []) });
  };

  seedFact(partial: Partial<StoredFact> & { id: string }): StoredFact {
    const fact: StoredFact = {
      subject: "Billing",
      predicate: "is owned by",
      object: "Ana",
      status: "published",
      cardinality: "single",
      provenance: { source: "slack", producer: "extraction:v1" },
      visibleTo: ["org"],
      validTo: null,
      invalidatedAt: null,
      sourceEpisodeId: "ep-src",
      ...partial,
    };
    this.facts.push(fact);
    return fact;
  }

  fact(id: string): StoredFact {
    const found = this.facts.find((f) => f.id === id);
    if (!found) throw new Error(`no such fact ${id}`);
    return found;
  }

  private async query(sql: string, params: unknown[]): Promise<{ rows: readonly unknown[] }> {
    this.executed.push(sql);

    // ── correction.ts statements ────────────────────────────────────────
    if (sql.includes("FOR UPDATE") && sql.includes("f.invalidated_at IS NULL")) {
      // correctionTargetSql — a builder, so matched on its two distinctive
      // predicates rather than by identity.
      const factId = params[params.length - 1];
      const fact = this.facts.find(
        (f) => f.id === factId && f.invalidatedAt === null && !f.hidden,
      );
      return { rows: fact ? [this.targetRow(fact)] : [] };
    }
    if (sql === CORRECTION_EPISODE_INSERT_SQL) {
      const id = `ep-corr-${++this.seq}`;
      this.episodes.push({
        id,
        sourceId: String(params[1]),
        sourceActor: String(params[2]),
        body: String(params[3]),
        occurredAt: String(params[4]),
        visibleTo: JSON.parse(String(params[5])) as string[],
        extractedAt: String(params[4]),
      });
      return { rows: [{ id }] };
    }
    if (sql === RETRACT_FACT_SQL) {
      const fact = this.facts.find((f) => f.id === params[1] && f.invalidatedAt === null);
      if (!fact) return { rows: [] };
      fact.invalidatedAt = NOW.toISOString();
      return { rows: [{ id: fact.id, invalidated_at: fact.invalidatedAt }] };
    }
    if (sql === DERIVES_FROM_EDGE_SQL) {
      this.edges.push({
        edgeType: "derives-from",
        fromFactId: String(params[1]),
        toFactId: null,
        toEpisodeId: String(params[2]),
      });
      return { rows: [{ id: `edge-${++this.seq}` }] };
    }
    if (sql === DEPENDENT_FACTS_SQL) {
      const ids = this.edges
        .filter((e) => e.edgeType === "derives-from" && e.toFactId === params[1])
        .map((e) => e.fromFactId)
        .filter((id) => this.facts.some((f) => f.id === id && f.invalidatedAt === null));
      return { rows: ids.map((id) => ({ id })) };
    }
    if (sql === MERGE_PROVENANCE_MARKER_SQL) {
      const ids = params[1] as string[];
      const marker = JSON.parse(String(params[2])) as Record<string, unknown>;
      const touched: { id: string }[] = [];
      for (const fact of this.facts) {
        if (ids.includes(fact.id) && fact.invalidatedAt === null) {
          fact.provenance = { ...fact.provenance, ...marker };
          touched.push({ id: fact.id });
        }
      }
      return { rows: touched };
    }
    if (sql === PROMOTE_CORRECTION_FACT_SQL) {
      const fact = this.facts.find(
        (f) => f.id === params[1] && f.status === "draft" && f.invalidatedAt === null,
      );
      if (!fact) return { rows: [] };
      fact.status = "published";
      return { rows: [{ id: fact.id }] };
    }
    if (sql === REPLACEMENT_ROW_SQL) {
      const fact = this.facts.find((f) => f.id === params[1]);
      if (!fact) return { rows: [] };
      return {
        rows: [
          {
            id: fact.id,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            status: fact.status,
            source_episode_id: fact.sourceEpisodeId,
            provenance: fact.provenance,
            visible_to: fact.visibleTo,
          },
        ],
      };
    }

    // ── The publish adapter's #4912 statements, executed verbatim ───────
    if (sql === SUPERSEDE_STAMP_SQL) {
      const ids = params[1] as string[];
      const stamped: { id: string }[] = [];
      for (const fact of this.facts) {
        if (
          ids.includes(fact.id) &&
          fact.status === "published" &&
          fact.invalidatedAt === null &&
          fact.validTo === null
        ) {
          fact.validTo = NOW.toISOString();
          stamped.push({ id: fact.id });
        }
      }
      return { rows: stamped };
    }
    if (sql === INSERT_SUPERSEDES_EDGES_SQL) {
      const pairs = JSON.parse(String(params[1])) as { newId: string; oldId: string }[];
      for (const pair of pairs) {
        this.edges.push({
          edgeType: "supersedes",
          fromFactId: pair.newId,
          toFactId: pair.oldId,
          toEpisodeId: null,
        });
      }
      return { rows: pairs.map(() => ({ id: `edge-${++this.seq}` })) };
    }

    // ── reconcile's statements (the supersede replacement path) ─────────
    if (sql === RECONCILE_LOCK_SQL) return { rows: [] };
    if (sql === CORROBORATION_LOOKUP_SQL) {
      const [, subject, predicate, object] = params;
      const existing = this.facts.find(
        (f) =>
          f.subject === subject &&
          f.predicate === predicate &&
          f.object === object &&
          f.invalidatedAt === null &&
          f.validTo === null,
      );
      return { rows: existing ? [{ id: existing.id }] : [] };
    }
    if (sql === INSERT_FACT_SQL) {
      const id = `fact-new-${++this.seq}`;
      this.facts.push({
        id,
        subject: String(params[1]),
        predicate: String(params[2]),
        object: String(params[3]),
        validFrom: params[4] === null ? null : String(params[4]),
        status: "draft",
        cardinality: String(params[9]),
        provenance: JSON.parse(String(params[7])) as Record<string, unknown>,
        visibleTo: JSON.parse(String(params[8])) as string[],
        validTo: null,
        invalidatedAt: null,
        sourceEpisodeId: String(params[6]),
      });
      return { rows: [{ id }] };
    }
    if (sql === INSERT_PROVENANCE_EDGE_SQL) {
      const exists = this.edges.some(
        (e) =>
          e.edgeType === "provenance" &&
          e.fromFactId === params[1] &&
          e.toEpisodeId === params[2],
      );
      if (exists) return { rows: [] };
      this.edges.push({
        edgeType: "provenance",
        fromFactId: String(params[1]),
        toFactId: null,
        toEpisodeId: String(params[2]),
      });
      return { rows: [{ id: `edge-${++this.seq}` }] };
    }
    // Implemented with the REAL statement's semantics rather than stubbed
    // empty — this is what catches the supersede-ordering defect: a live
    // (valid_to IS NULL) same-subject/predicate rival of a new single-
    // cardinality claim earns an advisory edge, so if the verb reconciled the
    // replacement BEFORE stamping the target, the target would show up here
    // and the supersede test's no-tension-edge assertion would fail.
    if (sql === TENSION_CANDIDATES_SQL) {
      const [, subject, predicate, object, selfId] = params;
      const rivals = this.facts.filter(
        (f) =>
          f.subject === subject &&
          f.predicate === predicate &&
          f.object !== object &&
          f.id !== selfId &&
          f.invalidatedAt === null &&
          f.validTo === null,
      );
      return { rows: rivals.map((f) => ({ id: f.id })) };
    }
    if (sql === INSERT_TENSION_EDGE_SQL) {
      this.edges.push({
        edgeType: "in-tension-with",
        fromFactId: String(params[1]),
        toFactId: String(params[2]),
        toEpisodeId: null,
      });
      return { rows: [{ id: `edge-${++this.seq}` }] };
    }

    throw new Error(`FakeCorrectionStore: unrecognized statement:\n${sql}`);
  }

  private targetRow(fact: StoredFact): Record<string, unknown> {
    return {
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      status: fact.status,
      predicate_cardinality: fact.cardinality,
      provenance: fact.provenance,
      visible_to: fact.visibleTo,
      valid_to: fact.validTo,
      source_episode_id: fact.sourceEpisodeId,
    };
  }
}

function run(store: FakeCorrectionStore, request: Omit<CorrectionRequest, "ctx"> & { ctx?: BrainPrincipalContext }) {
  return correctFact(
    { ctx: admin(), ...request },
    { withTransaction: store.runner, now: () => NOW, newCorrectionId: () => "test-uuid" },
  );
}

// ---------------------------------------------------------------------------
// retract — the only tombstone path
// ---------------------------------------------------------------------------

describe("retract", () => {
  test("stamps the tombstone, materializes the episode, and links via derives-from", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "fact-1", visibleTo: ["org", "role:admin"] });

    const outcome = await run(store, { factId: "fact-1", verb: "retract", reason: "wrong" });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

    expect(outcome.result.invalidatedAt).toBe(NOW.toISOString());
    expect(store.fact("fact-1").invalidatedAt).toBe(NOW.toISOString());
    // The tombstone writer is THE tombstone writer.
    expect(store.executed).toContain(RETRACT_FACT_SQL);

    // The immutable human record: actor-attributed, off the extraction queue,
    // grant-seeded from the target fact (the narrowest defensible set).
    expect(store.episodes).toHaveLength(1);
    const episode = store.episodes[0]!;
    expect(episode.sourceId).toBe("correction:retract:test-uuid");
    expect(episode.sourceActor).toBe("admin-1");
    expect(episode.extractedAt).not.toBeNull();
    expect(episode.visibleTo).toEqual(["org", "role:admin"]);
    const body = JSON.parse(episode.body) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "correction", verb: "retract", factId: "fact-1", reason: "wrong", actor: "admin-1" });

    // Lineage, not evidence: a retraction must not corroborate the claim.
    expect(store.edges).toEqual([
      { edgeType: "derives-from", fromFactId: "fact-1", toFactId: null, toEpisodeId: episode.id },
    ]);

    // One transaction; nothing supersession- or promotion-shaped ran.
    expect(store.transactions).toBe(1);
    expect(store.executed).not.toContain(SUPERSEDE_STAMP_SQL);
    expect(store.executed).not.toContain(PROMOTE_CORRECTION_FACT_SQL);
  });

  test("flags derives-from dependents for re-review and cascades NOTHING", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "premise" });
    store.seedFact({ id: "conclusion-a", status: "published", object: "Bo" });
    store.seedFact({ id: "conclusion-b", status: "draft", object: "Cy" });
    store.edges.push(
      { edgeType: "derives-from", fromFactId: "conclusion-a", toFactId: "premise", toEpisodeId: null },
      { edgeType: "derives-from", fromFactId: "conclusion-b", toFactId: "premise", toEpisodeId: null },
    );

    const outcome = await run(store, { factId: "premise", verb: "retract" });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    expect([...outcome.result.flaggedForReReview].sort()).toEqual(["conclusion-a", "conclusion-b"]);

    for (const id of ["conclusion-a", "conclusion-b"]) {
      const dependent = store.fact(id);
      // Flagged — and ONLY flagged. The proof that nothing cascades: the
      // dependent's own tombstone, validity, and review state are untouched.
      expect(dependent.provenance.reReview).toMatchObject({
        reason: "derives-from-retracted",
        retractedFactId: "premise",
      });
      expect(dependent.invalidatedAt).toBeNull();
      expect(dependent.validTo).toBeNull();
    }
    expect(store.fact("conclusion-a").status).toBe("published");
    expect(store.fact("conclusion-b").status).toBe("draft");
  });

  test("flagging is ONE hop by design — a transitive dependent is untouched", async () => {
    // A ← B ← C: retracting C flags B; A's re-review is B's reviewer's call,
    // because only a human can say whether B (and therefore A) survives losing
    // its premise. Auto-walking the chain would be the cascade this verb
    // forswears, one edge at a time.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "c" });
    store.seedFact({ id: "b", object: "Bo" });
    store.seedFact({ id: "a", object: "Cy" });
    store.edges.push(
      { edgeType: "derives-from", fromFactId: "b", toFactId: "c", toEpisodeId: null },
      { edgeType: "derives-from", fromFactId: "a", toFactId: "b", toEpisodeId: null },
    );

    const outcome = await run(store, { factId: "c", verb: "retract" });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    expect(outcome.result.flaggedForReReview).toEqual(["b"]);
    expect(store.fact("a").provenance.reReview).toBeUndefined();
  });

  test("a retracted or invisible fact answers not-found, indistinguishably", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "gone", invalidatedAt: NOW.toISOString() });
    store.seedFact({ id: "hidden", hidden: true });

    expect((await run(store, { factId: "gone", verb: "retract" })).kind).toBe("not-found");
    expect((await run(store, { factId: "hidden", verb: "retract" })).kind).toBe("not-found");
    expect((await run(store, { factId: "absent", verb: "retract" })).kind).toBe("not-found");
    expect(store.episodes).toHaveLength(0);
  });

  test("source scan: this module is the only `invalidated_at` UPDATE writer", () => {
    // The acceptance criterion is repository-wide ("retract remains the ONLY
    // invalidated_at writer"), which no fake-store assertion can pin — so scan
    // source the way the promotion guard does, across every root that can
    // hold server code (`ee/` and `plugins/` included — the audit-grep
    // blind-spot lesson), in BOTH spellings: raw SQL (`SET invalidated_at`)
    // and the Drizzle builder (`.set({ … invalidatedAt … })`). Deliberately
    // NOT matched: the region import's INSERT, which restores a stored
    // tombstone verbatim (a restore, not a new arbitration — the same line
    // the promotion guard's allowlist draws). Test files are excluded for the
    // guard's own reason: fixtures may stage tombstoned rows.
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
    const roots = ["packages/api/src", "packages/mcp/src", "ee", "plugins"]
      .map((r) => join(repoRoot, r))
      .filter((r) => {
        try {
          return statSync(r).isDirectory();
        } catch {
          // intentionally ignored: an absent optional root is not scannable
          return false;
        }
      });
    const RAW_SQL_WRITE = /SET\s+invalidated_at/i;
    const ORM_WRITE = /\.set\(\{[^}]*invalidatedAt/s;
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
          walk(path);
          continue;
        }
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        const source = readFileSync(path, "utf8");
        if (RAW_SQL_WRITE.test(source) || ORM_WRITE.test(source)) writers.push(path);
      }
    };
    for (const root of roots) walk(root);
    expect(writers.map((p) => p.substring(repoRoot.length + 1))).toEqual([
      "packages/api/src/lib/brain/correction.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// supersede — #4912's machinery, human-invoked
// ---------------------------------------------------------------------------

describe("supersede", () => {
  test("publishes the replacement and stamps the target through the adapter's own statements", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published", cardinality: "single" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
      reason: "Ana left",
    });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

    const newId = outcome.result.supersededBy;
    if (newId === null) throw new Error("expected a superseding fact id");
    expect(outcome.result.validTo).toBe(NOW.toISOString());

    // Byte-identical reuse of the publish gate's machinery — the pin the
    // acceptance criteria ask for. If correction ever grew its own stamp
    // spelling, these identity checks (and the fake's exact-match dispatch,
    // which would throw on an unknown statement) both fail.
    expect(store.executed).toContain(SUPERSEDE_STAMP_SQL);
    expect(store.executed).toContain(INSERT_SUPERSEDES_EDGES_SQL);

    const oldFact = store.fact("old");
    expect(oldFact.validTo).toBe(NOW.toISOString());
    expect(oldFact.invalidatedAt).toBeNull(); // superseded, not withdrawn

    // Authoritative immediately — the replacement never queues as a draft.
    const replacement = store.fact(newId);
    expect(replacement.status).toBe("published");
    expect(replacement.subject).toBe("Billing");
    expect(replacement.object).toBe("Bo");
    expect(replacement.cardinality).toBe("single"); // inherited from the target
    expect(replacement.visibleTo).toEqual(["org"]); // the target's grant, via the episode
    expect(replacement.provenance.producer).toBe("correction");
    expect(replacement.provenance.actor).toBe("user:admin-1");

    // The arbitration record (new → old) and the evidence pointer.
    expect(store.edges).toContainEqual({
      edgeType: "supersedes",
      fromFactId: newId,
      toFactId: "old",
      toEpisodeId: null,
    });
    expect(store.edges).toContainEqual({
      edgeType: "provenance",
      fromFactId: newId,
      toFactId: null,
      toEpisodeId: store.episodes[0]!.id,
    });
    expect(store.transactions).toBe(1);

    // The ordering property: because the stamp ran BEFORE the replacement
    // reconciled, the retired belief was already settled history when the
    // tension pass looked for live rivals — so the verb that RESOLVES this
    // conflict must not have minted an advisory edge recording it. The fake's
    // tension pass implements the real statement's semantics, so a reordered
    // implementation fails here.
    const pairEdges = store.edges.filter(
      (e) =>
        (e.fromFactId === newId && e.toFactId === "old") ||
        (e.fromFactId === "old" && e.toFactId === newId),
    );
    expect(pairEdges.map((e) => e.edgeType)).toEqual(["supersedes"]);
  });

  test("a THIRD live rival still earns its advisory tension edge — only the arbitrated pair is settled", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published", cardinality: "single" });
    store.seedFact({ id: "third", object: "Cy", status: "published", cardinality: "single" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    const newId = outcome.result.supersededBy;
    if (newId === null) throw new Error("expected a superseding fact id");

    // The human arbitrated old-vs-new; the third value is still a live
    // contested rival of the replacement and must keep its advisory edge.
    expect(store.edges).toContainEqual({
      edgeType: "in-tension-with",
      fromFactId: newId,
      toFactId: "third",
      toEpisodeId: null,
    });
    expect(store.fact("third").validTo).toBeNull();
  });

  test("an invalid replacement.validFrom degrades to the correction time, never an invalid write", async () => {
    // Both entry seams validate ISO-8601; this pins the machinery's own
    // backstop for a future direct caller.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published", cardinality: "single" });
    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo", validFrom: new Date("not a date") },
    });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    expect(store.fact(outcome.result.supersededBy as string).validFrom).toBe(NOW.toISOString());
  });

  test("a whitespace-only replacement object is refused as missing, before anything is written", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old" });
    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "   " },
    });
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe(CORRECTION_REFUSAL_REASONS.replacementMissing);
    expect(outcome.message).toContain("non-blank");
    expect(store.transactions).toBe(0);
  });

  test("a live rival already asserting the value is corroborated and promoted, not duplicated", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published", cardinality: "single" });
    store.seedFact({ id: "rival", object: "Bo", status: "draft", cardinality: "single" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    expect(outcome.result.supersededBy).toBe("rival");
    // The human vouched for the value, so the draft rival publishes now.
    expect(store.fact("rival").status).toBe("published");
    expect(store.fact("old").validTo).toBe(NOW.toISOString());
    // Corroborated: exactly the seeded facts remain — no third row appeared.
    expect(store.facts).toHaveLength(2);
  });

  test("refuses without a replacement, before anything is written", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old" });
    const outcome = await run(store, { factId: "old", verb: "supersede" });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementMissing,
    });
    expect(store.transactions).toBe(0);
    expect(store.episodes).toHaveLength(0);
  });

  test("refuses a replacement restating the current object", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana" });
    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "  Ana " },
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
    });
    expect(store.episodes).toHaveLength(0);
  });

  test("refuses a draft target with a pointer to retract instead", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "draft-1", status: "draft" });
    const outcome = await run(store, {
      factId: "draft-1",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe(CORRECTION_REFUSAL_REASONS.targetNotPublished);
    expect(outcome.message).toContain("retract");
  });

  test("refuses a target whose validity window is already closed", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "settled", validTo: "2026-01-01T00:00:00.000Z" });
    const outcome = await run(store, {
      factId: "settled",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.validityAlreadyClosed,
    });
    expect(store.fact("settled").validTo).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// re-authority and pin — the vouching verbs
// ---------------------------------------------------------------------------

describe("re-authority and pin", () => {
  for (const [verb, markerKey] of [
    ["re-authority", "reAuthority"],
    ["pin", "pinned"],
  ] as const) {
    test(`${verb} attaches the episode as evidence and marks the payload — nothing else`, async () => {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "fact-1", status: "published" });

      const outcome = await run(store, { factId: "fact-1", verb });
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

      const fact = store.fact("fact-1");
      expect(fact.provenance[markerKey]).toMatchObject({
        actor: "admin-1",
        correctionEpisodeId: store.episodes[0]!.id,
      });
      // Evidence, not lineage: the human vouching IS a fresh observation, so
      // it must feed the corroboration count and the decay anchor.
      expect(store.edges).toContainEqual({
        edgeType: "provenance",
        fromFactId: "fact-1",
        toFactId: null,
        toEpisodeId: store.episodes[0]!.id,
      });
      // And nothing lifecycle-shaped moved.
      expect(fact.status).toBe("published");
      expect(fact.invalidatedAt).toBeNull();
      expect(fact.validTo).toBeNull();
      expect(store.executed).not.toContain(RETRACT_FACT_SQL);
      expect(store.executed).not.toContain(SUPERSEDE_STAMP_SQL);
      expect(store.executed).not.toContain(PROMOTE_CORRECTION_FACT_SQL);
    });
  }
});

// ---------------------------------------------------------------------------
// The gates every verb shares
// ---------------------------------------------------------------------------

describe("shared gates", () => {
  test("tier-1 warehouse-derived targets are refused for EVERY verb, with nothing written", async () => {
    for (const verb of CORRECTION_VERBS) {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "wh", provenance: { source: "warehouse", producer: "warehouse:v1" } });
      const outcome = await run(store, {
        factId: "wh",
        verb,
        ...(verb === "supersede" ? { replacement: { object: "Bo" } } : {}),
      });
      if (outcome.kind !== "refused") throw new Error(`${verb}: expected refused, got ${outcome.kind}`);
      expect(outcome.reason).toBe(CORRECTION_REFUSAL_REASONS.warehouseTarget);
      // Actionable, per the issue: the fix is the data or the semantic layer.
      expect(outcome.message).toContain("semantic layer");
      expect(store.episodes).toHaveLength(0);
      expect(store.edges).toHaveLength(0);
      expect(store.fact("wh").invalidatedAt).toBeNull();
    }
  });

  test("a member is refused the verb before the database is touched", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "fact-1" });
    const outcome = await run(store, { ctx: member(), factId: "fact-1", verb: "retract" });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.notAuthorized,
    });
    expect(store.transactions).toBe(0);
  });

  test("an unresolved actor throws rather than degrading", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "fact-1" });
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    await expect(run(store, { ctx: unresolved, factId: "fact-1", verb: "retract" })).rejects.toBeInstanceOf(
      BrainReaderUnresolvedError,
    );
    expect(store.transactions).toBe(0);
  });

  test("the local operator (auth: none) corrects with the operator identity recorded", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "fact-1", visibleTo: ["org"] });
    const local: BrainPrincipalContext = {
      origin: "unauthenticated-local",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    const outcome = await run(store, { ctx: local, factId: "fact-1", verb: "retract" });
    if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
    expect(store.episodes[0]!.sourceActor).toBe("local-operator");
  });

  test("isWarehouseDerived reads only the structural source key", () => {
    expect(isWarehouseDerived({ source: "warehouse" })).toBe(true);
    expect(isWarehouseDerived({ source: "slack" })).toBe(false);
    expect(isWarehouseDerived(null)).toBe(false);
    expect(isWarehouseDerived([])).toBe(false);
  });
});
