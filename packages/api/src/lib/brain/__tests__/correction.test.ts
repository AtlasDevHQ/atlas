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
  correctionTargetSql,
  isWarehouseDerived,
  type CorrectionRequest,
} from "@atlas/api/lib/brain/correction";
import {
  EPISODE_SOURCES,
  SLACK_SOURCE,
  WAREHOUSE_CLASS,
  WAREHOUSE_SOURCE,
  episodeSourceClassOf,
} from "@atlas/api/lib/brain/sources";
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
  brainFactCurrentClause,
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

  /**
   * Columns to OMIT from the target projection — the drift `readTargetRow`
   * exists to catch. `pg` yields `undefined` for a column a SELECT never
   * named, so dropping the key here is exactly what a drifted
   * `correctionTargetSql` produces.
   */
  dropTargetColumns: string[] = [];

  /**
   * Columns to REPLACE in the target projection.
   *
   * Distinct from dropping, and both are needed: `pg` yields `undefined` for a
   * column a SELECT never named, but a column whose TYPE drifted (a `::text`
   * cast, a changed type parser) arrives present and wrong. `readTargetRow`
   * has a separate arm for each, and only an override can reach the second.
   *
   * It is also how this fake reaches the shape production ALWAYS sends:
   * `timestamptz` decodes as a `Date`, and the seeded facts here carry ISO
   * strings, so without an override the whole suite runs against a `valid_to`
   * type Postgres never produces.
   */
  overrideTargetColumns: Record<string, unknown> = {};

  private targetRow(fact: StoredFact): Record<string, unknown> {
    const row = { ...this.fullTargetRow(fact), ...this.overrideTargetColumns };
    for (const column of this.dropTargetColumns) delete row[column];
    return row;
  }

  private fullTargetRow(fact: StoredFact): Record<string, unknown> {
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
      // Postgres computes this in `correctionTargetSql` as
      // `NOT brainFactCurrentClause("f")`, so the fake has to as well —
      // against the SAME injected clock the verb is run with. This is a
      // RESTATEMENT and can only pin the fake's own arithmetic: the identity
      // of the production predicate is pinned separately (the "IS
      // brainFactCurrentClause, negated" test), and `candidates-pg.test.ts`
      // executes the real SQL in both directions.
      window_closed: fact.validTo !== null && new Date(fact.validTo).getTime() <= NOW.getTime(),
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
    // source the way `scripts/check-brain-fact-promotion.sh` does, across the
    // same roots (`ee/`, `plugins/`, `apps/` and the scaffold templates
    // included — the audit-grep blind-spot lesson), in BOTH spellings: raw SQL
    // and the Drizzle write-builder.
    //
    // THIS SCAN IS THE WHOLE TOMBSTONE GUARANTEE. `invalidated_at` is
    // deliberately absent from the shell guard's gated columns (it gates
    // `status|(pre_widening_)?visible_to|valid_to`), so nothing else in the
    // repository refuses a second tombstone writer. That is why the matching
    // below is STRUCTURAL — source split into statements, then each rule a set
    // of cheap independent tests AND-ed together, exactly like the guard's
    // `statement_writes_gated_column` — rather than one regex. The single-regex
    // form this replaced (`/SET\s+invalidated_at/`) required the column to come
    // FIRST after `SET`, and its ORM twin (`/\.set\(\{[^}]*invalidatedAt/`)
    // stopped at the first nested brace; both are evaded by ordinary
    // refactors, and the fixtures below pin each evasion.
    //
    // Deliberately NOT matched: a plain INSERT naming the column — the region
    // import restores a stored tombstone verbatim (a restore, not a new
    // arbitration, the same line the promotion guard's allowlist draws). The
    // upsert's `DO UPDATE` half IS matched: it names no table after `UPDATE`,
    // which is precisely how that shape evaded the guard's UPDATE rule when it
    // was first written. Test files are excluded for the guard's own reason:
    // fixtures may stage tombstoned rows.
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
    // REQUIRED vs OPTIONAL, because "absent" and "drifted" are different
    // failures and collapsing them is how a repo-wide scan quietly covers less
    // than it says. All seven roots exist in a clone today, so the `statSync`
    // filter is a backstop rather than a live branch; the split's real job is
    // the file-count floor below. Only the four that must always hold
    // server code are held to it — `examples` and the scaffold roots
    // legitimately contain little or no scannable `.ts`, so a floor there
    // would be a flake rather than a guard.
    const REQUIRED_ROOTS = ["packages", "apps", "ee", "plugins"];
    const OPTIONAL_ROOTS = ["examples", "create-atlas", "create-atlas-plugin"];
    const roots = [...REQUIRED_ROOTS, ...OPTIONAL_ROOTS].filter((r) => {
      try {
        return statSync(join(repoRoot, r)).isDirectory();
      } catch {
        // intentionally ignored: an absent optional root is not scannable, and
        // a missing REQUIRED root is caught by the per-root count below
        return false;
      }
    });

    // The guard's own vocabulary, mirrored: an optional schema qualifier with
    // either identifier independently quoted, so `public.brain_facts`,
    // `"public"."brain_facts"` and `"brain_facts"` all match — and the same for
    // a namespace-qualified Drizzle reference.
    const QUALIFIED = String.raw`("?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?brain_facts"?`;
    const ORM_TABLE = String.raw`([a-zA-Z_$][a-zA-Z0-9_$]*\.)?brainFacts`;
    const UPDATE_TABLE = new RegExp(String.raw`UPDATE\s+(ONLY\s+)?${QUALIFIED}\b`, "i");
    const INSERT_TABLE = new RegExp(String.raw`INSERT\s+INTO\s+${QUALIFIED}\b`, "i");
    const SET_KEYWORD = /\bSET\b/i;
    const ON_CONFLICT = /ON\s+CONFLICT/i;
    const DO_UPDATE = /DO\s+UPDATE/i;
    // `\b` sits at the `"`/identifier boundary, so the quoted spelling matches
    // on the same pattern.
    const RAW_COLUMN = /\binvalidated_at\b/i;
    const ORM_UPDATE_TABLE = new RegExp(String.raw`\.update\(\s*${ORM_TABLE}\s*\)`);
    const ORM_INSERT_TABLE = new RegExp(String.raw`\.insert\(\s*${ORM_TABLE}\s*\)`);
    const ORM_SET = /\.set\(/;
    const ORM_ON_CONFLICT = /\.onConflictDoUpdate\(/;
    const ORM_COLUMN = /\binvalidatedAt\b/;

    /**
     * Does ONE statement stamp the tombstone? Over-broad in the guard's
     * direction on purpose: a mention anywhere in an `UPDATE brain_facts …
     * SET …` counts, WHERE clause included. A legitimate case wants an entry
     * in `ALLOWED` with a rationale, not a loosening.
     */
    const writesTombstone = (stmt: string): boolean => {
      if (UPDATE_TABLE.test(stmt) && SET_KEYWORD.test(stmt) && RAW_COLUMN.test(stmt)) return true;
      if (
        INSERT_TABLE.test(stmt) &&
        ON_CONFLICT.test(stmt) &&
        DO_UPDATE.test(stmt) &&
        RAW_COLUMN.test(stmt)
      ) {
        return true;
      }
      if (ORM_UPDATE_TABLE.test(stmt) && ORM_SET.test(stmt) && ORM_COLUMN.test(stmt)) return true;
      if (ORM_INSERT_TABLE.test(stmt) && ORM_ON_CONFLICT.test(stmt) && ORM_COLUMN.test(stmt)) {
        return true;
      }
      return false;
    };

    // The matcher, falsified before it is trusted. Every entry here is a shape
    // the single-regex form MISSED, so this block fails if anyone reverts to
    // it — the scan below would then be green for the wrong reason, which is
    // the one failure mode a repository-wide grep cannot report on itself.
    for (const evasion of [
      "UPDATE brain_facts SET updated_at = now(), invalidated_at = now() WHERE id = $1",
      `UPDATE public.brain_facts SET "invalidated_at" = now() WHERE id = $1`,
      `UPDATE "brain_facts" SET invalidated_at = now() WHERE id = $1`,
      "db.update(schema.brainFacts).set({ meta: { flagged: true }, invalidatedAt: new Date() })",
      "INSERT INTO brain_facts (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET invalidated_at = now()",
      "db.insert(brainFacts).values({ id }).onConflictDoUpdate({ set: { invalidatedAt: new Date() } })",
      "UPDATE ONLY brain_facts SET invalidated_at = now() WHERE id = $1",
    ]) {
      expect([evasion, writesTombstone(evasion)]).toEqual([evasion, true]);
    }
    // KNOWN RESIDUALS, recorded so the block above is not read as totality.
    // Each of these also evades the shell guard's `statement_writes_gated_column`,
    // so the scan mirrors the guard faithfully rather than regressing from it —
    // but "ordinary refactor" covers them too, and a reader who trusts this
    // scan absolutely should know where it stops:
    //
    //   - an ALIASED import (`import { brainFacts as facts }`), which defeats
    //     both `ORM_TABLE` and the `statementsOf` pre-filter;
    //   - an INTERPOLATED table name (`` `UPDATE ${TABLE} SET …` ``), where the
    //     statement text contains neither spelling;
    //   - a builder SPLIT across statements (`const q = db.update(brainFacts);`
    //     then `q.set({ invalidatedAt })`), which the `;` split separates.
    //
    // Closing them means teaching the shell guard the same tricks, and the two
    // must move together or the mirror claim above stops being true.
    // …and the shapes that are NOT a new arbitration stay out, so the rules
    // above are not merely "mentions the column anywhere".
    for (const legal of [
      "INSERT INTO brain_facts (id, invalidated_at) VALUES ($1, $2)",
      "UPDATE brain_episodes SET invalidated_at = now() WHERE id = $1",
      "SELECT id FROM brain_facts WHERE invalidated_at IS NULL",
      "db.insert(brainFacts).values({ id, invalidatedAt })",
    ]) {
      expect([legal, writesTombstone(legal)]).toEqual([legal, false]);
    }

    /**
     * Comment-strip, then split into STATEMENTS — the guard's
     * `STRIP_COMMENTS | tr '\n' ' ' | tr ';' '\n'` in TypeScript. The unit
     * matters: AND-ing independent tokens only means "in the same write" when
     * the haystack is one statement, and stripping comments is what keeps the
     * prose around `RETRACT_FACT_SQL` (which names the column repeatedly) from
     * reading as a writer.
     */
    const statementsOf = (source: string): string[] =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ")
        .replace(/\s+/g, " ")
        .split(";")
        .filter((stmt) => /brain_facts|\bbrainFacts\b/.test(stmt));

    const SKIP_DIRS = new Set([
      "node_modules",
      "dist",
      ".next",
      ".turbo",
      "coverage",
      "__tests__",
      "__mocks__",
      "__test-utils__",
      "__snapshots__",
    ]);
    const matched = new Map<string, string[]>();
    /** Files actually read, per root — the coverage ledger the asserts below use. */
    const scanned = new Map<string, number>();
    const walk = (root: string, dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        let stat;
        try {
          stat = statSync(path);
        } catch (err) {
          // A broken symlink must not turn a guard into a hard error — but it
          // must not vanish either, because an unreadable path is unscanned
          // surface and this scan's whole claim is coverage.
          console.debug(
            `invalidated_at scan: skipping unreadable path ${path}`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue;
          walk(root, path);
          continue;
        }
        if (!/\.(ts|tsx|js)$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        scanned.set(root, (scanned.get(root) ?? 0) + 1);
        const hits = statementsOf(readFileSync(path, "utf8")).filter(writesTombstone);
        if (hits.length > 0) matched.set(path.substring(repoRoot.length + 1), hits);
      }
    };
    for (const root of roots) walk(root, join(repoRoot, root));

    // COVERAGE FIRST, per root. The sole-writer assertion below is satisfied by
    // an EMPTY result, so every one of its failure modes is a false green: a
    // root that drifted or was renamed, an extension filter that stopped
    // matching, a skip rule that grew too broad. The `toContain` pins further
    // down prove `packages` was walked and nothing more — `ee` and `plugins`
    // could each go to zero files and this test would stay green, which is the
    // audit-grep blind spot the comment at the top invokes.
    for (const root of REQUIRED_ROOTS) {
      expect([root, (scanned.get(root) ?? 0) > 0]).toEqual([root, true]);
    }

    // The scaffold templates carry generated copies of the same modules, so the
    // allowance is a shape rather than a list — the guard's ALLOWLIST makes the
    // same template-glob decision, and for the same reason names the FILE
    // rather than a `src/…` suffix any package could adopt.
    //
    // This list is a strict SUBSET of the guard's, differing only by
    // `admin-migrate.ts` (and its template twin), which the guard allowlists
    // and this scan never matches because the region import is a plain INSERT.
    // Stated precisely because the obvious maintenance move is to diff the two
    // and "fix" the gap.
    //
    // The two template entries are LOCAL-ONLY: `create-atlas/templates/*/src/`
    // is gitignored and regenerated by `prepare-templates.sh`, so they match on
    // a developer's machine after a template build and match nothing in CI.
    // Note what that does NOT buy — the subtree's absence is invisible to this
    // scan, since `create-atlas` itself always exists and the root-level count
    // below cannot see one directory deep. Template coverage is therefore
    // opportunistic, and the guard's own run over the same roots is what
    // actually holds that line.
    //
    // `content-mode/adapters/brain-facts.ts` is here because the match above is
    // deliberately over-broad in the guard's direction: `SUPERSEDE_STAMP_SQL`
    // READS the tombstone as a predicate (`invalidated_at IS NULL`) and sets
    // `valid_to`. Narrowing the rule to "assignment only" would buy that one
    // file back at the cost of the property this whole test exists for — the
    // assignment spellings are open-ended (`SET (updated_at, invalidated_at) =
    // (now(), now())` is valid Postgres), and an evadable rule is what was
    // wrong with the version this replaced. So the file is allowed here and
    // its statements are held to the stricter check below instead.
    const ALLOWED = [
      /^packages\/api\/src\/lib\/brain\/correction\.ts$/,
      /^packages\/api\/src\/lib\/content-mode\/adapters\/brain-facts\.ts$/,
      /^create-atlas\/templates\/[^/]+\/src\/lib\/brain\/correction\.ts$/,
      /^create-atlas\/templates\/[^/]+\/src\/lib\/content-mode\/adapters\/brain-facts\.ts$/,
    ];
    const relative = [...matched.keys()];
    // Asserted FIRST, and not redundant: the sole-writer assertion below is
    // satisfied by an EMPTY result, so naming both expected files is what
    // separates "nothing writes the tombstone outside these two" from "the scan
    // found nothing at all". `correction.ts` anchors the tombstone itself; the
    // publish adapter anchors the read-only check further down, which iterates
    // over exactly these matches.
    expect(relative).toContain("packages/api/src/lib/brain/correction.ts");
    expect(relative).toContain("packages/api/src/lib/content-mode/adapters/brain-facts.ts");
    expect(relative.filter((p) => !ALLOWED.some((allowed) => allowed.test(p)))).toEqual([]);

    // Every matched statement EXCEPT the tombstone itself only READS the column:
    // nothing before its first `WHERE` may name it. Best-effort by construction
    // (a SET list holding a subquery would truncate the slice), which is why it
    // narrows an already-bounded set rather than standing alone — and the SET
    // list of the two statements that actually matter is pinned directly, here
    // for `RETRACT_FACT_SQL` and in `adapters/__tests__/brain-facts.test.ts`
    // for `SUPERSEDE_STAMP_SQL`.
    //
    // `correction.ts` is NOT exempted wholesale, and that distinction is the
    // difference between "this MODULE is the only writer" and "this STATEMENT
    // is the only writer". Only the latter is the invariant: adding
    // `invalidated_at = now()` to `MERGE_PROVENANCE_MARKER_SQL` — which runs
    // against the `derives-from` DEPENDENTS, i.e. the exact cascade the module
    // header forbids — is a second tombstone writer inside the allowed file,
    // and a file-level exemption waves it straight through.
    //
    // The tombstone is EXCISED from each statement rather than used to skip it,
    // and that is not a stylistic choice. Skipping any statement that CONTAINS
    // the retract body exempts a cascade that embeds it — `WITH r AS (<retract
    // body>) UPDATE brain_facts SET invalidated_at = now() WHERE id = ANY(…)`
    // is exactly how someone implements the forbidden cascade, and it would be
    // waved through whole. Cutting the body out and checking the RESIDUE keeps
    // the trailing UPDATE in scope.
    //
    // The excision is by text, not by `===`, because the scanned statement
    // carries the surrounding TypeScript (`export const RETRACT_FACT_SQL =
    // \`…\``) around the same whitespace-collapsed SQL body.
    const retractStatement = statementsOf(RETRACT_FACT_SQL)[0];
    // The excision must name a statement that exists; if `RETRACT_FACT_SQL`
    // stopped matching, its own declaration would be held to a rule the
    // tombstone legitimately breaks, and the failure would read as a cascade
    // bug rather than as drift here.
    expect(["retract statement located", typeof retractStatement]).toEqual([
      "retract statement located",
      "string",
    ]);

    let readOnlyStatementsChecked = 0;
    for (const [path, statements] of matched) {
      for (const stmt of statements) {
        const residue =
          retractStatement === undefined ? stmt : stmt.split(retractStatement).join(" ");
        readOnlyStatementsChecked++;
        const where = residue.search(/\bWHERE\b/i);
        expect([path, RAW_COLUMN.test(where < 0 ? residue : residue.slice(0, where))]).toEqual([
          path,
          false,
        ]);
      }
    }
    // …and the loop ran. Bounded from below rather than left implicit, because
    // an empty `matched` — the failure the two `toContain`s above exist to
    // refuse — would otherwise make this whole block assert nothing, silently.
    expect(readOnlyStatementsChecked).toBeGreaterThan(0);
  });

  test("RETRACT_FACT_SQL's SET list is the tombstone and nothing else", () => {
    // The verb-level tests all watch the fake store's dispatch, which proves
    // WHICH statement ran and never what it SETS — so `SET status = 'draft'`
    // could be added to the statement below and every one of them would stay
    // green (the only real-PG read of the retracted row, `candidates-pg`'s,
    // targets a row seeded `draft`, so it cannot tell a demotion from a no-op).
    // Sliced at `WHERE` because `invalidated_at` legitimately appears as a
    // predicate; the sibling stamp gets exactly this treatment in
    // `content-mode/adapters/__tests__/brain-facts.test.ts`.
    //
    // Withdrawal is a tombstone, NOT a demotion: `status` is the review gate's
    // column and retraction never re-opens the gate — a retracted fact is gone
    // from every fact-serving read, not queued for a second verdict. A demoting
    // retract would also put `correction.ts` in the business of writing the
    // gated column its allowlist entry exists to permit for other reasons.
    const where = RETRACT_FACT_SQL.indexOf("WHERE");
    expect(where).toBeGreaterThan(0);
    const setList = RETRACT_FACT_SQL.slice(0, where);
    expect(setList).toContain("invalidated_at = now()");
    expect(setList).toContain("updated_at = now()");
    expect(setList).not.toContain("status");
    expect(setList).not.toContain("valid_to");
    expect(setList).not.toContain("visible_to");
    // The residual predicates that make the statement correct standalone —
    // dropping the tombstone re-check would let a racing second retract stamp
    // a new instant over a settled withdrawal.
    expect(RETRACT_FACT_SQL.slice(where)).toContain("invalidated_at IS NULL");
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

    // #4939. Both verbs promise an OBSERVABLE effect ("resetting its staleness
    // clock"), delivered through the decay anchor — which is read off a fact
    // no as-of-now query serves once its window has closed. Before this, the
    // verb wrote the edge and the marker on a settled claim and reported the
    // reset anyway.
    test(`${verb} refuses a target whose validity window has ALREADY passed — nothing written`, async () => {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "settled", status: "published", validTo: "2026-01-01T00:00:00.000Z" });

      const outcome = await run(store, { factId: "settled", verb });
      expect(outcome).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.targetNotCurrent,
      });
      if (outcome.kind !== "refused") throw new Error("narrowing");
      // The remedy has to be actionable, not just a "no": the caller reached
      // here holding an id an `asOf` read handed them.
      expect(outcome.message).toContain("2026-01-01T00:00:00.000Z");

      // Refused BEFORE the episode — the marker and the evidence edge are the
      // two writes that would have made a settled claim look re-anchored.
      expect(store.episodes).toHaveLength(0);
      expect(store.edges).toHaveLength(0);
      expect(store.executed).not.toContain(MERGE_PROVENANCE_MARKER_SQL);
      expect(store.executed).not.toContain(INSERT_PROVENANCE_EDGE_SQL);
      expect(store.fact("settled").provenance[markerKey]).toBeUndefined();
    });

    // The arm a `validTo !== null` implementation — the spelling `supersede`
    // uses two screens up — gets WRONG. `brainFactCurrentClause` reads
    // `valid_to > now()`, so a future bound is a live claim whose end is
    // merely scheduled; refusing it would block a vouch on a current belief.
    test(`${verb} still vouches when validTo is in the FUTURE — that claim is still served`, async () => {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "scheduled", status: "published", validTo: "2027-01-01T00:00:00.000Z" });

      const outcome = await run(store, { factId: "scheduled", verb });
      expect(outcome.kind).toBe("corrected");
      expect(store.fact("scheduled").provenance[markerKey]).toBeDefined();
      // And the scheduled end is untouched — vouching is not an arbitration.
      expect(store.fact("scheduled").validTo).toBe("2027-01-01T00:00:00.000Z");
    });

    // The boundary the refusal and the read must agree on. The read's clause
    // is `valid_to > now()`, so a stamp EQUAL to the instant is already shut —
    // a strict `<` in the refusal would admit a vouch on exactly the fact the
    // read declines to serve, and neither side would ever say so.
    test(`${verb} refuses a validTo equal to the instant — \`> now()\` means shut, not open`, async () => {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "edge", status: "published", validTo: NOW.toISOString() });

      expect(await run(store, { factId: "edge", verb })).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.targetNotCurrent,
      });
      expect(store.episodes).toHaveLength(0);
    });
  }

  // The two thresholds are deliberately different, so they get different
  // codes: `supersede` refuses ANY decided end date (a second arbitration of
  // one claim is what it must not permit), the vouching verbs refuse only a
  // window that has already closed. Collapsing them onto one reason would make
  // a caller branching on `VALIDITY_ALREADY_CLOSED` silently wrong for one of
  // the two, and the remedies genuinely differ.
  test("supersede and pin disagree about a FUTURE validTo, each with its own reason", async () => {
    const superseding = new FakeCorrectionStore();
    superseding.seedFact({ id: "f", status: "published", validTo: "2027-01-01T00:00:00.000Z" });
    expect(
      await run(superseding, { factId: "f", verb: "supersede", replacement: { object: "Bo" } }),
    ).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.validityAlreadyClosed,
    });

    const pinning = new FakeCorrectionStore();
    pinning.seedFact({ id: "f", status: "published", validTo: "2027-01-01T00:00:00.000Z" });
    expect(await run(pinning, { factId: "f", verb: "pin" })).toMatchObject({ kind: "corrected" });

    expect(CORRECTION_REFUSAL_REASONS.targetNotCurrent).not.toBe(
      CORRECTION_REFUSAL_REASONS.validityAlreadyClosed,
    );
  });

  // The vouch gate's whole justification is that it and the reads agree about
  // which facts are current, and that only holds while the predicate is the
  // reads' OWN clause rather than a second spelling of it. Identity, not
  // paraphrase — the same treatment `SUPERSEDE_STAMP_SQL` gets in this suite,
  // and for the same reason: a hand-written `valid_to > now()` here would
  // desynchronize the day that clause gains a grace window, and no boundary
  // fixture would notice, because a moved boundary moves the fixture too.
  test("the closed-window predicate IS brainFactCurrentClause, negated — not a second spelling", () => {
    const sql = correctionTargetSql("TRUE", 1);
    expect(sql).toContain(`NOT ${brainFactCurrentClause("f")} AS window_closed`);
    // And no independent spelling of the same comparison survives alongside
    // it. `replace` with a STRING pattern removes only the first occurrence,
    // which fails safe: a second copy of the clause would still trip the
    // regex below. Both operand orders and `CURRENT_TIMESTAMP` are covered,
    // since a paraphrase is exactly what this is looking for.
    const withoutTheImport = sql.replace(brainFactCurrentClause("f"), "");
    expect(
      /valid_to\s*[<>]=?\s*(now\(\)|current_timestamp)|(now\(\)|current_timestamp)\s*[<>]=?\s*[a-z]*\.?valid_to/i.test(
        withoutTheImport,
      ),
      "correctionTargetSql compares `valid_to` against the clock somewhere other than the imported clause — that is the drift this import exists to prevent",
    ).toBe(false);
  });

  // Both temporal gates fail OPEN on a value this module cannot read — an
  // absent column reaches them as "no end date" and silently re-admits the
  // write each exists to refuse, with no log and no refusal. `readTargetRow`
  // therefore treats either column's absence as drift and THROWS (→ a 500 with
  // a requestId), which is the posture its own header states for every other
  // column. Asserted per column so a narrowing that covers only one is a
  // failure, not a coincidence.
  for (const [column, fragment] of [
    ["window_closed", "window_closed"],
    ["valid_to", "valid_to absent"],
  ] as const) {
    test(`a target projection missing \`${column}\` THROWS rather than admitting the vouch`, async () => {
      const store = new FakeCorrectionStore();
      store.dropTargetColumns = [column];
      store.seedFact({ id: "settled", status: "published", validTo: "2026-01-01T00:00:00.000Z" });

      // Not a refusal and not a not-found: this is query drift, and the two
      // outcomes a caller can act on must stay reserved for real answers.
      await expect(run(store, { factId: "settled", verb: "pin" })).rejects.toThrow(fragment);
      expect(store.episodes).toHaveLength(0);
    });
  }

  // The OTHER drift arm: a column that is present but the wrong TYPE. Dropping
  // a column can only ever produce `undefined`, which the arm above catches, so
  // without this the type check is unexercised. What it pins is BEHAVIOURAL,
  // not compile-time: a re-typed column must throw with a nameable message
  // rather than flow on to `iso()` and render a refusal with no date in it.
  // (The compile side is held separately — `TargetRow.validTo` is
  // `Date | string | null`, so the assignment itself would not type-check.)
  test("a target projection whose `valid_to` decodes to the wrong type THROWS", async () => {
    const store = new FakeCorrectionStore();
    store.overrideTargetColumns = { valid_to: 1735689600000 };
    store.seedFact({ id: "settled", status: "published", validTo: "2026-01-01T00:00:00.000Z" });

    await expect(run(store, { factId: "settled", verb: "pin" })).rejects.toThrow("unreadable valid_to");
    expect(store.episodes).toHaveLength(0);
  });

  // …and the shape production ACTUALLY sends. `timestamptz` decodes as a
  // `Date`, and every other test in this file seeds an ISO string, so nothing
  // else here proves a real row survives narrowing at all — deleting the
  // `instanceof Date` arm compiles clean and would 500 every correction on a
  // fact that has a `valid_to`.
  test("a `Date`-valued `valid_to` — what Postgres actually returns — narrows and renders", async () => {
    const store = new FakeCorrectionStore();
    store.overrideTargetColumns = { valid_to: new Date("2026-01-01T00:00:00.000Z") };
    store.seedFact({ id: "settled", status: "published", validTo: "2026-01-01T00:00:00.000Z" });

    const outcome = await run(store, { factId: "settled", verb: "pin" });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.targetNotCurrent,
    });
    if (outcome.kind !== "refused") throw new Error("narrowing");
    // The date reaches the message from a `Date`, which is the only path
    // `iso()`'s Date arm is exercised on from this module.
    expect(outcome.message).toContain("2026-01-01T00:00:00.000Z");
  });

  // Retract has no such gate and must not grow one by sympathy: withdrawing a
  // superseded claim is exactly how a GDPR erasure reaches settled history,
  // and the tension cluster still lists it.
  test("retract is NOT gated on validTo — a superseded claim can still be withdrawn", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "settled", status: "published", validTo: "2026-01-01T00:00:00.000Z" });

    const outcome = await run(store, { factId: "settled", verb: "retract" });
    expect(outcome.kind).toBe("corrected");
    expect(store.fact("settled").invalidatedAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// The gates every verb shares
// ---------------------------------------------------------------------------

describe("shared gates", () => {
  test("tier-1 warehouse-derived targets are refused for EVERY verb, with nothing written", async () => {
    for (const verb of CORRECTION_VERBS) {
      const store = new FakeCorrectionStore();
      // Seeded from the CONSTANT, not the literal: this suite hand-builds the
      // payload `reconcile.ts` would have written, so a literal here would let
      // the fixture and the predicate agree with each other while the real
      // producer drifted away from both (#4938). `reconcile.test.ts` holds the
      // other end — the predicate run against a payload that module actually
      // wrote.
      store.seedFact({
        id: "wh",
        provenance: { source: WAREHOUSE_SOURCE, producer: "warehouse:v1" },
      });
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

  test("an IMPORTED out-of-vocabulary source kind is refused for EVERY verb (#4964)", async () => {
    // The negative the fail-open lane needed. `admin-migrate.ts` restores a
    // bundle's `source` verbatim — deliberately, since 0180 puts no CHECK on
    // the column and refusing would strand the workspace mid-region-migration
    // — so these three values really can reach a stored fact's provenance.
    // Each is a shape `sources.ts` names as the silent-drift hazard, and each
    // is NOT `=== "warehouse"` and NOT warehouse-CLASS, so tier-1 refusal
    // cannot see it. Without this gate every one of them buys a correction
    // path ADR-0036 §T4 forbids, and buys it silently.
    //
    // Run against the REAL vocabulary through `isEpisodeSource` — this file
    // mocks nothing. A fixture that hand-fed its own source list would let the
    // test and the predicate agree with each other while the vocabulary drifted
    // away from both, the #4938 failure `sources.ts` exists to defeat.
    //
    // `""` is a string like the three above it — a degenerate one, and the case
    // that pins `unknownKind !== null` at the gate against a truthiness check.
    // The last two are NON-STRING shapes, on this list because the import can
    // produce them: `validateBundle` requires only that a fact's `provenance`
    // be a non-empty object and never inspects `.source`, so `{"source": null}`
    // on a warehouse-derived fact would otherwise defeat tier-1 refusal AND
    // this quarantine both. They refuse under a DIFFERENT reason — see the
    // resolvable split below.
    for (const source of ["warehouse:prod", "snowflake", "bigquery", "", 42, null]) {
      const resolvable = typeof source === "string";
      for (const verb of CORRECTION_VERBS) {
        const store = new FakeCorrectionStore();
        store.seedFact({ id: "imported", provenance: { source, producer: "region-import" } });
        const outcome = await run(store, {
          factId: "imported",
          verb,
          ...(verb === "supersede" ? { replacement: { object: "Bo" } } : {}),
        });
        if (outcome.kind !== "refused") {
          throw new Error(`${source}/${verb}: expected refused, got ${outcome.kind}`);
        }
        // Its OWN reason, not `warehouseTarget`. Folding the two together
        // would assert the fact IS warehouse-derived, which for a newer chat
        // vendor's message is simply false — and would send an operator
        // looking for a warehouse table that does not exist.
        // A string kind can join the vocabulary in a later release, so it heals
        // and says so. A non-string never can — `isEpisodeSource` requires a
        // string — so promising a deploy there would be a false promise about a
        // fact that also cannot be RETRACTED, the GDPR-erasure verb. Different
        // remediation, different reason.
        expect([source, verb, outcome.reason]).toEqual([
          source,
          verb,
          resolvable
            ? CORRECTION_REFUSAL_REASONS.unrecognizedSourceKind
            : CORRECTION_REFUSAL_REASONS.malformedSourceKind,
        ]);
        // The PROSE, not just the code. The reason's whole justification is
        // that an operator must not be told "warehouse-derived" about what is
        // probably a newer chat vendor's message — a regression that kept the
        // code and reused the tier-1 copy would be green on the line above.
        // `not.toContain("semantic layer")` is what actually discriminates
        // against that copy-paste; the positive half anchors on the remediation
        // each branch promises, which is the half that must never be swapped.
        expect(outcome.message).not.toContain("semantic layer");
        expect(outcome.message).toContain(
          resolvable ? "until this deployment runs a version" : "No release will resolve this",
        );
        // Refused BEFORE any write, exactly like tier-1: the correction
        // episode is what a late refusal would have to roll back.
        expect(store.episodes).toHaveLength(0);
        expect(store.edges).toHaveLength(0);
        expect(store.fact("imported").invalidatedAt).toBeNull();
      }
    }
  });

  test("the quarantine is present-but-unknown only, and lifts when the kind is known", async () => {
    // The two boundaries either side of the refusal above, because both are
    // ways a plausible "tidy-up" silently changes what shipped.
    //
    // BELOW: the carve-out is the ABSENT KEY, and only that. Nothing
    // structurally guarantees `provenance.source` — `promotion.ts`'s refusals
    // check `source_episode_id` — so quarantining this shape would retire the
    // correction path for facts no import ever touched. Note the deliberate
    // asymmetry with the refused loop above, where `{ source: null }` IS
    // quarantined: an absent key is a legacy shape, a present-but-unusable one
    // is a bundle defect, and collapsing the two either reopens the hole or
    // breaks facts that predate the lane.
    for (const provenance of [{}, { producer: "x" }, { detail: { source: "snowflake" } }]) {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "no-source", provenance });
      const outcome = await run(store, { factId: "no-source", verb: "retract" });
      expect([provenance, outcome.kind]).toEqual([provenance, "corrected"]);
    }

    // ABOVE: every member of the real vocabulary is unaffected. This is what
    // makes the quarantine SELF-HEALING rather than a permanent tax — adding a
    // kind to `EPISODE_SOURCE_SPECS` is the one-line PR that moves an imported
    // fact out of the quarantine, with no data migration. Driven off
    // `EPISODE_SOURCES` so a new member is covered the day it lands.
    for (const source of EPISODE_SOURCES) {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "known", provenance: { source, producer: "extraction:v1" } });
      const outcome = await run(store, { factId: "known", verb: "retract" });
      // Keyed on the CLASS, never on `source === WAREHOUSE_SOURCE`. That
      // value-vs-class conflation is the one `sources.ts` spends a section
      // warning about, and here it would cost the one-line-PR property
      // outright: a new member declaring `class: "warehouse"` inherits tier-1
      // refusal by design, and a value-keyed expectation would fail a correct
      // addition — pressuring the next author to special-case the test rather
      // than trust the vocabulary.
      const expected: [string, string, string | null] =
        episodeSourceClassOf(source) === WAREHOUSE_CLASS
          ? [source, "refused", CORRECTION_REFUSAL_REASONS.warehouseTarget]
          : [source, "corrected", null];
      // The full outcome KIND, not just "was it refused". A one-sided check
      // collapses `corrected`, `not-found` and any future kind into the same
      // pass, so a regression that made a known-source target unreadable would
      // be green — while this loop's comment claims it proves the opposite.
      const actual: [string, string, string | null] = [
        source,
        outcome.kind,
        outcome.kind === "refused" ? outcome.reason : null,
      ];
      expect(actual).toEqual(expected);
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
    // The predicate's SHAPE is what this arm owns. Which VALUES it recognises,
    // and the agreement between the constant and the producers that stamp it,
    // are `__tests__/sources.test.ts` — the literals here were the reason
    // tier-1 refusal could have failed open unnoticed (#4938).
    expect(isWarehouseDerived({ source: WAREHOUSE_SOURCE })).toBe(true);
    expect(isWarehouseDerived({ source: SLACK_SOURCE })).toBe(false);
    expect(isWarehouseDerived(null)).toBe(false);
    expect(isWarehouseDerived([])).toBe(false);
  });
});
