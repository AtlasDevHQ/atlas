/**
 * The correction verbs' decision matrix (#4915, ADR-0036 §T4).
 *
 * Drives `correctFact` against an in-memory store that dispatches on the
 * module's EXPORTED SQL constants — the same harness shape as
 * `reconcile.test.ts`, and for the same reason: what needs pinning here is
 * WHICH statement each verb runs and which it must never run, and a string
 * dispatch makes "supersede executed the publish adapter's own
 * `SUPERSEDE_STAMP_EXPLICIT_SQL`" a literal identity check rather than a paraphrase.
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

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- logger: every VALUE export stubbed (mock-all-exports) -----------------
//
// Added by #5027's third review round, for one reason: the post-commit
// cardinality proposer's ONLY operator-facing output is a log line, and its two
// arms say materially different things — "the gate FAILED and the proposal did
// NOT land" versus "it timed out and the statement may still commit". An
// unbranched line shipped in round 2 saying the second on a `42P01` that had
// definitively rolled back, and nothing in this file could see it.
//
// A PARTIAL mock is the hazard here (a new export in `lib/logger` breaks every
// consumer of a partial stub), so this is the same complete block
// `correction-audit.test.ts` carries, copied deliberately rather than trimmed.
type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];
const recorder = {
  error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
  warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
  info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
  debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
};
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => recorder,
  getLogger: () => ({ ...recorder, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => ({ requestId: "req-test", user: { id: "admin-1" } }),
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const warns = () => logCalls.filter((c) => c.level === "warn");

/**
 * Poll until a condition holds — for the two POST-DEADLINE continuation arms,
 * which by construction land after `correctFact` has already returned.
 *
 * Same shape as `correction-audit.test.ts`'s, which tests the same ordering on
 * the audit write beside this one.
 */
async function waitFor(predicate: () => void, capMs = 2_000): Promise<void> {
  const deadline = Date.now() + capMs;
  for (;;) {
    try {
      predicate();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

beforeEach(() => {
  logCalls.length = 0;
});
// DYNAMIC, and it has to be: `mock.module` above only reaches a module that
// has not been evaluated yet, and a static `import` is hoisted above every
// statement in this file — so the logger stub would apply to nothing and the
// log assertions below would silently read an empty array. This is the same
// shape `correction-audit.test.ts` uses, and for the same reason.
const {
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
} = await import("@atlas/api/lib/brain/correction");
import type { CorrectionRequest } from "@atlas/api/lib/brain/correction";
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
  SUPERSEDE_STAMP_EXPLICIT_SQL,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  identityAlias,
  identityVocabulary,
  slotKey,
  type ClaimVocabulary,
} from "@atlas/api/lib/brain/identity";
import {
  CORRECTION_EVENT_PRODUCER,
  CORRECTION_REPEAT_COUNT_SQL,
  CORRECTION_REPEAT_THRESHOLD,
} from "@atlas/api/lib/brain/cardinality";
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
  /**
   * The materialized identity (#5020) — what reconcile's two lookups match on.
   * A seeded fact stands for a row already in the corpus, so `seedFact` keys it
   * the way the ingest path would; the reconcile INSERT arm records the keys it
   * was actually BOUND, which is what would catch a stage that stopped
   * supplying them.
   */
  slot: { subject: string | null; predicate: string | null; object: string | null };
  /** Set only by the reconcile insert; seeded facts default to null. */
  validFrom?: string | null;
  status: string;
  provenance: Record<string, unknown>;
  visibleTo: string[];
  validTo: string | null;
  invalidatedAt: string | null;
  sourceEpisodeId: string;
  /** Simulates the ACL predicate: a hidden fact never comes back. */
  hidden?: boolean;
}

/** Three consecutive key binds, read positionally — `null` survives as `null`. */
function slotParams(
  params: readonly unknown[],
  from: number,
): { subject: string | null; predicate: string | null; object: string | null } {
  const at = (i: number): string | null => {
    const v = params[from + i];
    return v === null || v === undefined ? null : String(v);
  };
  return { subject: at(0), predicate: at(1), object: at(2) };
}

/** Postgres `=` / `<>`: both UNKNOWN — never a match — when either side is NULL. */
const sqlEq = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;
const sqlNe = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== b;

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
  /**
   * Cardinality proposals this store accepted (#5027) — `pending` rows, never
   * approved ones, because the correction-event source may only propose.
   */
  readonly cardinalityProposals: {
    predicateKey: string;
    cardinality: string;
    sourceClass: string;
    proposedBy: string;
  }[] = [];
  /**
   * Distinct subjects ALREADY corrected at the predicate before this test's own
   * verb ran — the corpus history the repeat gate reads and this fake has no
   * `brain_edges` rows for. Set it to stand a workspace up just below or just
   * over `CORRECTION_REPEAT_THRESHOLD`.
   */
  priorCorrectedSubjects = 0;
  /**
   * Make the proposal INSERT throw — the post-commit failure path (#5027).
   *
   * A flag rather than a mocked module: the claim under test is that the
   * CALLER absorbs it, and only a real throw crossing the real seam shows that.
   */
  failCardinalityProposal = false;
  /**
   * Make the repeat-gate COUNT never settle — a DEGRADED internal database,
   * reachable but not answering (#5027).
   *
   * The realistic shape rather than a throw, and it is the one a `try`/`catch`
   * cannot absorb: the internal pool sets no `statement_timeout` and
   * `internalQuery` bypasses the circuit breaker, so nothing upstream ever
   * rejects. Only a deadline turns this into an error.
   */
  hangCardinalityProposal = false;
  /**
   * Settle the repeat-gate COUNT only AFTER this many ms — the ordering the
   * hang knob cannot produce.
   *
   * `hangCardinalityProposal` never settles, so with it alone the two
   * post-deadline continuation arms are structurally unreachable and deleting
   * all 28 lines of them is green. This is what makes "the losing branch is not
   * discarded" a claim a test can check rather than a paragraph.
   */
  delayCardinalityProposalMs: number | null = null;
  /** With {@link delayCardinalityProposalMs}, settle by REJECTING. */
  delayedProposalRejects = false;
  /** Every statement executed, in order — the identity assertions read this. */
  readonly executed: string[] = [];
  /**
   * The params each statement was bound with, parallel to {@link executed}.
   *
   * Kept separately rather than folded in so every existing `toContain(SQL)`
   * assertion keeps working on a plain string array — and so a param-count
   * claim (which is what catches a column silently re-entering an INSERT's
   * list) has something to read.
   */
  readonly executedParamsLog: (readonly unknown[])[] = [];
  transactions = 0;
  private seq = 0;

  readonly runner: ReconcileTransactionRunner = async <T>(
    fn: (tx: ReconcileExecutor) => Promise<T>,
  ): Promise<T> => {
    this.transactions++;
    return fn({ query: (sql, params) => this.query(sql, params ?? []) });
  };

  /** The params one statement was bound with, or `undefined` if it never ran. */
  executedParams(sql: string): readonly unknown[] | undefined {
    const at = this.executed.indexOf(sql);
    return at === -1 ? undefined : this.executedParamsLog[at];
  }

  seedFact(partial: Partial<StoredFact> & { id: string }): StoredFact {
    const base = {
      subject: "Billing",
      predicate: "is owned by",
      object: "Ana",
      status: "published",
      provenance: { source: "slack", producer: "extraction:v1" },
      visibleTo: ["org"],
      validTo: null,
      invalidatedAt: null,
      sourceEpisodeId: "ep-src",
      ...partial,
    };
    const fact: StoredFact = {
      // Keyed through the SAME function the ingest path calls, so a seeded row
      // stands for a real corpus row rather than for a hand-written key that
      // happens to agree with one. An explicit `slot` in `partial` still wins —
      // that is how a test seeds the unkeyed rows a region import leaves
      // behind (#5035).
      slot: {
        subject: slotKey(base.subject, identityAlias),
        predicate: slotKey(base.predicate, identityAlias),
        object: slotKey(base.object, identityAlias),
      },
      ...base,
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
    this.executedParamsLog.push(params);

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
    if (sql === SUPERSEDE_STAMP_EXPLICIT_SQL) {
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
      const slot = slotParams(params, 1);
      const existing = this.facts.find(
        (f) =>
          sqlEq(f.slot.subject, slot.subject) &&
          sqlEq(f.slot.predicate, slot.predicate) &&
          sqlEq(f.slot.object, slot.object) &&
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
        slot: slotParams(params, 9),
        validFrom: params[4] === null ? null : String(params[4]),
        status: "draft",
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
      const slot = slotParams(params, 1);
      const selfId = params[4];
      const rivals = this.facts.filter(
        (f) =>
          sqlEq(f.slot.subject, slot.subject) &&
          sqlEq(f.slot.predicate, slot.predicate) &&
          sqlNe(f.slot.object, slot.object) &&
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

    // ── The cardinality proposer (#5027, ADR-0037 §3(d)2) ──────────────
    //
    // The repeat gate is a COUNT over `brain_edges`, and this fake holds the
    // edges the verb just wrote — so the gate is answered from the same store
    // the verb mutated rather than stubbed to a constant. That is what makes
    // "three distinct subjects raises a proposal" a claim about the production
    // query's INPUTS; the query's own SQL is executed for real in
    // `cardinality-pg.test.ts`.
    //
    // `object_cmp` has no representation here (the fake stores no comparables),
    // so this arm deliberately answers the SUBJECT-DISTINCTNESS half only. The
    // provable-difference half is a SQL arm and is falsified only against real
    // Postgres — stubbing it here would be a fixture that agrees with itself.
    if (sql === CORRECTION_REPEAT_COUNT_SQL) {
      if (this.hangCardinalityProposal) return new Promise<never>(() => {});
      if (this.delayCardinalityProposalMs !== null) {
        const delay = this.delayCardinalityProposalMs;
        const rejects = this.delayedProposalRejects;
        return new Promise((resolve, reject) =>
          setTimeout(
            () =>
              rejects
                ? reject(new Error("repeat gate failed late"))
                : resolve({ rows: [{ n: 0 }] }),
            delay,
          ),
        );
      }
      const subjects = new Set(
        this.edges
          .filter((e) => e.edgeType === "supersedes")
          .map((e) => this.facts.find((f) => f.id === e.fromFactId))
          .filter((f): f is StoredFact => f !== undefined && f.slot.predicate === params[1])
          .map((f) => f.slot.subject)
          .filter((k): k is string => k !== null),
      );
      return { rows: [{ n: subjects.size + this.priorCorrectedSubjects }] };
    }
    if (sql.startsWith("INSERT INTO brain_predicate_cardinality")) {
      if (this.failCardinalityProposal) {
        throw new Error("FakeCorrectionStore: cardinality proposal insert failed (simulated)");
      }
      const key = String(params[1]);
      if (this.cardinalityProposals.some((row) => row.predicateKey === key)) return { rows: [] };
      this.cardinalityProposals.push({
        predicateKey: key,
        cardinality: String(params[2]),
        sourceClass: String(params[3]),
        proposedBy: String(params[4]),
      });
      return { rows: [{ predicate_key: key }] };
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
      // The STORED keys (#5037). The whole point of the slice is that these are
      // read rather than re-derived, so the fake must serve what the row HOLDS —
      // serving `slotKey(fact.subject, vocabulary)` here would make every test
      // below agree by construction and the falsification vacuous.
      subject_key: fact.slot.subject,
      predicate_key: fact.slot.predicate,
      object_key: fact.slot.object,
      status: fact.status,
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

/**
 * `vocabulary` is defaulted here rather than at every call site, and EXPOSED so
 * the threading tests below can override it. The production field is required
 * on purpose (`identity.ts`, "`alias` is REQUIRED"); a test helper is exactly
 * where a default belongs, since forgetting it here costs nothing and
 * forgetting it in production keys a corpus under the wrong identity function.
 */
function run(
  store: FakeCorrectionStore,
  request: Omit<CorrectionRequest, "ctx" | "vocabulary"> & {
    ctx?: BrainPrincipalContext;
    vocabulary?: ClaimVocabulary;
  },
) {
  return correctFact(
    { ctx: admin(), vocabulary: identityVocabulary, ...request },
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
    expect(store.executed).not.toContain(SUPERSEDE_STAMP_EXPLICIT_SQL);
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
    // deliberately over-broad in the guard's direction: `SUPERSEDE_STAMP_EXPLICIT_SQL`
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
    // for `SUPERSEDE_STAMP_EXPLICIT_SQL`.
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
    store.seedFact({ id: "old", object: "Ana", status: "published" });

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
    expect(store.executed).toContain(SUPERSEDE_STAMP_EXPLICIT_SQL);
    expect(store.executed).toContain(INSERT_SUPERSEDES_EDGES_SQL);

    const oldFact = store.fact("old");
    expect(oldFact.validTo).toBe(NOW.toISOString());
    expect(oldFact.invalidatedAt).toBeNull(); // superseded, not withdrawn

    // Authoritative immediately — the replacement never queues as a draft.
    const replacement = store.fact(newId);
    expect(replacement.status).toBe("published");
    expect(replacement.subject).toBe("Billing");
    expect(replacement.object).toBe("Bo");
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
    // The VERB is still ONE transaction — the episode, the stamp, the edges and
    // the replacement commit together or not at all. The second is the #5027
    // cardinality proposer, and its separation is deliberate rather than
    // incidental: it reads the `supersedes` edge this transaction wrote, so it
    // needs that edge COMMITTED, and a failure in it must not roll back a
    // correction the user was told succeeded. Inside, it could not — Postgres
    // aborts the whole transaction after any statement error, so the verb's own
    // COMMIT would fail with it. The other three verbs still run exactly one
    // (asserted in the proposer suite).
    expect(store.transactions).toBe(2);

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
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.seedFact({ id: "third", object: "Cy", status: "published" });

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
    store.seedFact({ id: "old", object: "Ana", status: "published" });
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
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.seedFact({ id: "rival", object: "Bo", status: "draft" });

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

  test("the workspace's OBJECT vocabulary decides what 'restates' means (#5022)", async () => {
    // The threading through corrections was entirely unfalsifiable before this:
    // no test constructed a non-identity vocabulary, so both
    // `slotKey(…, vocabulary.object)` calls could be repointed at
    // `vocabulary.predicate` — or the whole vocabulary swapped for the empty one
    // on the way into `reconcileFacts` — with the suite still green.
    //
    // The failure it prohibits is the destructive direction: a supersession
    // PERMITTED that the corpus considers identical closes a published belief
    // and replaces it with a successor in the very same slot.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Ana Torres" },
      vocabulary: {
        ...identityVocabulary,
        object: (norm) => (norm === "ana torres" ? "ana" : norm),
      },
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
    });
    expect(store.episodes).toHaveLength(0);
  });

  test("the same rule at the PREDICATE position does not reach the object guard (#5022)", async () => {
    // The control, and the half that catches a `vocabulary.object` →
    // `vocabulary.predicate` repoint: the identical rule hung on the wrong
    // position must leave `Ana Torres` a genuinely different object, so the
    // supersession is ADMITTED. Without it, a guard that refused everything
    // would satisfy the prohibition above.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Ana Torres" },
      vocabulary: {
        ...identityVocabulary,
        predicate: (norm) => (norm === "ana torres" ? "ana" : norm),
      },
    });

    expect(outcome.kind).toBe("corrected");
  });

  test("'restates' is judged against the target's STORED object key (#5037)", async () => {
    // The module's SECOND re-derivation site, and the one whose divergence falls
    // on the guard deciding whether an irreversible write happens at all.
    //
    // The scenario is ADR-0037 §8's alias REMOVAL, the one vocabulary operation
    // that is not a rewrite. The fact was written while `ana` aliased to
    // `ana torres`, so that is what its `object_key` HOLDS. A reviewer has since
    // removed the alias, so the surface `Ana` now derives `ana` — and the stored
    // key and the derived key have come apart.
    //
    // A human now supersedes the fact with `Ana Torres`, which keys to
    // `ana torres`: the value the corpus already records this fact as asserting.
    // Read against the STORED key the guard sees the restatement and refuses.
    // Re-derived, it compares `ana torres` against `ana`, sees a difference that
    // exists only in the vocabulary's history, and passes the correction through
    // to `SUPERSEDE_STAMP_EXPLICIT_SQL` — closing a published belief to stand up
    // a successor asserting the same value in the same slot, with a `supersedes`
    // edge recording an arbitration that settled nothing.
    //
    // ⚠️ Not covered by the two inherit tests: they assert on the keys the
    // reconcile INSERT bound, and this guard runs BEFORE reconcile is reached at
    // all — a supersede it wrongly permits still binds a perfectly consistent
    // slot. The refusal is the only observable.
    const store = new FakeCorrectionStore();
    store.seedFact({
      id: "old",
      object: "Ana",
      slot: { subject: "billing", predicate: "is owned by", object: "ana torres" },
    });

    const target = store.fact("old");
    // The anti-vacuity precondition. With an unmoved vocabulary the stored and
    // derived keys agree and the mutant is indistinguishable from the fix.
    expect(
      slotKey(target.object, identityVocabulary.object),
      "the object vocabulary did not move — re-deriving would give the same answer",
    ).not.toBe(target.slot.object);

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Ana Torres" },
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
    });
    // Nothing was retired, and no episode was written for a correction that
    // never happened.
    expect(store.fact("old").validTo).toBeNull();
    expect(store.episodes).toHaveLength(0);
  });

  test("an UNKEYED target still refuses a restatement — the guard does not switch off (#5037)", async () => {
    // ⚠️ THE REGRESSION THE FIRST CUT OF #5037 SHIPPED, and the reason this test
    // exists rather than the reasoning that said it could not happen.
    //
    // Reading the target's key instead of deriving it is right whenever there IS
    // a stored key. When there is not — a region-imported corpus, every fact
    // unkeyed — a derived replacement key can never equal a stored NULL, so the
    // comparison stops being a comparison: the refusal cannot fire for ANY
    // input, and a byte-identical restatement reaches
    // `SUPERSEDE_STAMP_EXPLICIT_SQL`. A published belief is retired in favour of
    // a successor asserting the same value, with a `supersedes` edge recording an
    // arbitration that settled nothing, and there is no inverse verb.
    //
    // The near-miss is the instructive part: "an UNKEYED target inherits its null
    // slot" (below) seeds the identical fixture and supersedes with a DIFFERENT
    // object, so it passes over this defect without touching it. The two tests
    // differ only in whether the replacement restates — which is the whole of
    // what the guard decides.
    const store = new FakeCorrectionStore();
    store.seedFact({
      id: "unkeyed",
      object: "Ana",
      slot: { subject: null, predicate: null, object: null },
    });

    // The precondition that makes this the unkeyed case rather than a duplicate
    // of the stored-key test above: nothing to read, and a surface that keys
    // perfectly well.
    expect(store.fact("unkeyed").slot.object).toBeNull();
    expect(slotKey("Ana", identityVocabulary.object)).toBe("ana");

    const outcome = await run(store, {
      factId: "unkeyed",
      verb: "supersede",
      replacement: { object: "Ana" },
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
    });
    // The load-bearing half: nothing was retired, and no successor was minted.
    expect(store.fact("unkeyed").validTo).toBeNull();
    expect(store.facts).toHaveLength(1);
    expect(store.episodes).toHaveLength(0);
  });

  test("the replacement claim lands keyed under the workspace's vocabulary (#5022)", async () => {
    // The OTHER half of the threading, and the one the guard tests cannot see:
    // `applySupersede` passes the vocabulary through to `reconcileFacts`, and
    // replacing that with `identityVocabulary` leaves every guard assertion
    // green while the successor lands in a DIFFERENT slot from every other row
    // in the workspace — unreachable from the slot future collisions join on.
    //
    // The key asserted here is a value the reconcile INSERT bound, not one the
    // test wrote: the fake records `slot` off the statement's binds.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Ana Torres" },
      vocabulary: {
        ...identityVocabulary,
        object: (norm) => (norm === "ana torres" ? "ana torres (crm)" : norm),
      },
    });

    expect(outcome.kind).toBe("corrected");
    const replacement = store.facts.find((f) => f.object === "Ana Torres");
    expect(replacement?.slot.object).toBe("ana torres (crm)");
  });

  test("the replacement INHERITS the target's slot when the vocabulary has MOVED (#5037)", async () => {
    // ADR-0037 §8: *a row-copy path carries keys verbatim; a claim-supply path
    // never supplies them.* `correction.ts` was called the immune producer
    // because it carries identity from the target row — true only while identity
    // == surface. Once keys are computed at the reconcile seam, passing the
    // target's SURFACES down is a RE-DERIVATION, and it agrees with the stored
    // key only until the vocabulary moves.
    //
    // The failure it prohibits is silent and irreversible. The stamp is id-based
    // (`SUPERSEDE_STAMP_EXPLICIT_SQL`), so it fires whatever the vocabulary says:
    // the target's belief is retired, `supersedes` records new→old, and the
    // replacement lands in a DIFFERENT slot — unreachable from the slot every
    // future collision joins on. The audit trail says "superseded by X"; the slot
    // says empty.
    //
    // ⚠️ **THE VOCABULARY MUST ACTUALLY MOVE BETWEEN THE WRITE AND THE
    // CORRECTION, and the assertions below prove it did before they prove
    // anything else.** Written the natural way — seed a fact, correct it, check
    // the keys match — this test passes against the DEFECT, because an unmoved
    // vocabulary derives exactly the key it would have inherited. Every
    // assertion would be green and nothing would be tested. The stored keys here
    // are therefore seeded as what ingest wrote under the OLD vocabulary, and
    // `movedVocabulary` is a different function from the one that produced them.
    const store = new FakeCorrectionStore();
    // Written under the vocabulary of the day: no aliases, so the keys are the
    // bare norms of the surfaces.
    store.seedFact({
      id: "old",
      subject: "Billing",
      predicate: "is owned by",
      object: "Ana",
      slot: { subject: "billing", predicate: "is owned by", object: "ana" },
    });

    // ...and then a human approved two alias edges, at the subject and the
    // predicate. `vocabulary-decide-pg.test.ts` owns the real seam (#5023); what
    // matters here is only that the lookup is no longer identity.
    const movedVocabulary: ClaimVocabulary = {
      ...identityVocabulary,
      subject: (norm) => (norm === "billing" ? "billing department" : norm),
      predicate: (norm) => (norm === "is owned by" ? "is led by" : norm),
      object: (norm) => (norm === "bo" ? "bob" : norm),
    };

    // ── The anti-vacuity precondition ──────────────────────────────────────
    // If either of these ever holds, the test below is asserting that two equal
    // things are equal. They are assertions rather than a comment because a
    // future edit to `movedVocabulary` that quietly restores identity at one
    // position must fail HERE, loudly, rather than turn the real assertions into
    // tautologies that stay green.
    const target = store.fact("old");
    expect(
      slotKey(target.subject, movedVocabulary.subject),
      "the subject vocabulary did not move — the inherit assertion below would be vacuous",
    ).not.toBe(target.slot.subject);
    expect(
      slotKey(target.predicate, movedVocabulary.predicate),
      "the predicate vocabulary did not move — the inherit assertion below would be vacuous",
    ).not.toBe(target.slot.predicate);

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
      vocabulary: movedVocabulary,
    });

    expect(outcome.kind).toBe("corrected");
    const replacement = store.facts.find((f) => f.object === "Bo");
    expect(replacement).toBeDefined();

    // ── The slot is INHERITED ──────────────────────────────────────────────
    // The stored keys, verbatim — NOT `billing department` / `is led by`, which
    // is what re-deriving under the moved vocabulary produces. These are values
    // the reconcile INSERT actually bound; the fake records `slot` off the
    // statement's binds rather than from anything this test wrote.
    expect(replacement?.slot.subject).toBe("billing");
    expect(replacement?.slot.predicate).toBe("is owned by");

    // ── ...and the OBJECT is derived FRESH ─────────────────────────────────
    // The other half of the rule, and the one an over-broad fix breaks: a
    // correction is *about this claim*, so the slot is the target's — but the
    // object is new, human-authored text and keys on its own terms. `Bo` norms
    // to `bo`, which the CURRENT vocabulary maps to `bob`. Inheriting here
    // instead would make the replacement identical to the target at every
    // identity position, which is the one thing a supersession cannot be.
    expect(replacement?.slot.object).toBe("bob");
  });

  test("an UNKEYED target inherits its null slot rather than acquiring one (#5037)", async () => {
    // The other arm of the inherit, and the one that says what "verbatim" means
    // when there is nothing to copy. A region import leaves rows whose keys came
    // from a foreign vocabulary, and rows written before #5020 have none at all.
    //
    // Deriving a key to fill the hole is the tempting repair and it is the wrong
    // one: it would invent identity for a row that has none and move its
    // successor into a LIVE slot, where it can collide with — and at the publish
    // gate supersede — claims the unkeyed row never had any relationship to.
    // Carrying the nulls keeps the successor exactly as un-collidable as the
    // fact it replaces, which is today's behaviour for that row and the
    // recoverable direction.
    const store = new FakeCorrectionStore();
    store.seedFact({
      id: "unkeyed",
      object: "Ana",
      slot: { subject: null, predicate: null, object: null },
    });

    const outcome = await run(store, {
      factId: "unkeyed",
      verb: "supersede",
      replacement: { object: "Bo" },
    });

    expect(outcome.kind).toBe("corrected");
    const replacement = store.facts.find((f) => f.object === "Bo");
    expect(replacement?.slot.subject).toBeNull();
    expect(replacement?.slot.predicate).toBeNull();
    // The object still keys — it is derived, not inherited, so an unkeyed TARGET
    // does not make an unkeyed successor at every position. This is what
    // distinguishes "the slot was copied" from "the candidate lost its keys".
    expect(replacement?.slot.object).toBe("bo");
  });

  test("refuses a replacement that restates the object in a DIFFERENT SPELLING (#5020)", async () => {
    // "Restates what the fact already says" has to mean what the rest of the
    // system means by the same claim, and since #5020 that is the slot key.
    // Left byte-exact, this guard would pass `Bob` → `bob` through to
    // `SUPERSEDE_STAMP_EXPLICIT_SQL`: a published belief closed and replaced by a
    // successor in the IDENTICAL slot, with a `supersedes` edge recording an
    // arbitration that settled nothing — the irreversible direction, reached
    // through a spelling difference.
    // Case, edge whitespace, and — on a multi-token object — the separator
    // class. NOT `A_N-A`: interior separators norm to spaces, so that is
    // `a n a` and a genuinely different slot, which is the line the lexical
    // layer is drawing.
    for (const [target, restatement] of [
      ["Ana", "ana"],
      ["Ana", "  ANA  "],
      ["Deploy Box", "deploy_box"],
      ["Deploy Box", "DEPLOY-BOX"],
    ] as const) {
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "old", object: target });
      const outcome = await run(store, {
        factId: "old",
        verb: "supersede",
        replacement: { object: restatement },
      });
      expect(outcome, `${JSON.stringify(restatement)} was accepted as a new claim`).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
      });
      // Refused BEFORE any write — no correction episode, and no stamp.
      expect(store.episodes).toHaveLength(0);
      expect(store.fact("old").validTo).toBeNull();
    }
  });

  test("still accepts a replacement that lands in a genuinely different slot", async () => {
    // The positive control for the arm above: the guard must not have become a
    // blanket refusal. `Bo` is not a spelling of `Ana`.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana" });
    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    expect(outcome.kind).toBe("corrected");
  });

  test("refuses when BOTH objects norm away — there is no belief to retire", async () => {
    // Two surfaces with no identity are not two claims; `slotKey` returns null
    // for each, and the conservative arm is the one that does not stamp
    // `valid_to` on a row that asserts nothing.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "-" });
    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "___" },
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.replacementIdentical,
    });
    expect(store.fact("old").validTo).toBeNull();
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
// The cardinality proposer (#5027, ADR-0037 §3(d)2)
//
// The verb's side of source 2. What it can falsify here is the WIRING — which
// verbs feed the gate, what a proposal carries, and that a proposal is all it
// ever is. What it cannot falsify is the gate's SQL, which needs real Postgres
// and lives in `cardinality-pg.test.ts`; in particular the provable-difference
// arm that the typo target turns on has no representation in this fake, and
// stubbing one here would be a fixture agreeing with itself (#5000's trap).
// ---------------------------------------------------------------------------

describe("cardinality proposer", () => {
  test("supersede does NOT write the row's cardinality — the column left INSERT_FACT_SQL", async () => {
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published" });

    await run(store, { factId: "old", verb: "supersede", replacement: { object: "Bo" } });

    // The falsification of "extract stops feeding the column, and so does the
    // correction path". Re-adding `predicate_cardinality` to the insert's column
    // list restores the stochastic gate #5027 deleted, and the ONLY thing that
    // catches it is a parameter count: the statement would still be valid SQL
    // and every other assertion in this file would still pass.
    const insert = store.executedParams(INSERT_FACT_SQL);
    expect(insert).not.toBeUndefined();
    // 14 since #5032 added `subject_cmp` as `$14`; a re-added cardinality bind
    // makes it 15.
    expect(insert).toHaveLength(14);
    expect(INSERT_FACT_SQL).not.toContain("predicate_cardinality");
  });

  test("raises a `single` PROPOSAL once enough distinct subjects have been superseded", async () => {
    const store = new FakeCorrectionStore();
    // One short of the bar before this verb runs; the verb itself supplies the
    // subject that reaches it, so the gate is crossed by a REAL correction
    // rather than by the fixture.
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });

    expect(outcome.kind).toBe("corrected");
    expect(store.cardinalityProposals).toEqual([
      {
        // Non-null by construction (`is owned by` norms to itself), and asserted
        // as such rather than `!`-ed: a `slotKey` that started answering null
        // here would make the proposal's KEY wrong, which is the one field that
        // decides which population a `single` entry licenses.
        predicateKey: expect.stringMatching(/^is owned by$/),
        cardinality: "single",
        sourceClass: "correction_event",
        proposedBy: CORRECTION_EVENT_PRODUCER,
      },
    ]);
  });

  test("the proposal keys on the TARGET'S STORED predicate, not a re-derivation (#5037)", async () => {
    // The module's THIRD re-derivation site, and the one with the longest fuse:
    // `supersededKey` leaves the transaction entirely, so a wrong value here
    // shows up as a cardinality proposal filed against a slot no correction ever
    // touched — while the slot that WAS corrected accretes no evidence at all.
    // Nothing downstream can detect the mismatch, because a proposal carries no
    // pointer back to the fact that produced it.
    //
    // ⚠️ This case exists because the two inherit tests above do NOT cover it.
    // They assert on the keys the reconcile INSERT bound; `supersededKey` is a
    // separate read that reaches a separate consumer, and re-deriving it left
    // them both green. The class was fixed at three sites and only two had a
    // falsifier — which is exactly the gap a sibling sweep is supposed to close.
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({
      id: "old",
      object: "Ana",
      status: "published",
      // Written under the old vocabulary: the bare norm.
      slot: { subject: "billing", predicate: "is owned by", object: "ana" },
    });

    const movedVocabulary: ClaimVocabulary = {
      ...identityVocabulary,
      predicate: (norm) => (norm === "is owned by" ? "is led by" : norm),
    };
    // The anti-vacuity precondition, for the reason the inherit test states at
    // length: under an UNMOVED vocabulary the derived key equals the stored one
    // and this test cannot fail.
    expect(
      slotKey("is owned by", movedVocabulary.predicate),
      "the predicate vocabulary did not move — the assertion below would be vacuous",
    ).not.toBe("is owned by");

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
      vocabulary: movedVocabulary,
    });

    expect(outcome.kind).toBe("corrected");
    // `is owned by` — the key the corrected row actually sits under. NOT
    // `is led by`, which is what re-deriving the target's surface produces.
    expect(store.cardinalityProposals).toEqual([
      {
        predicateKey: "is owned by",
        cardinality: "single",
        sourceClass: "correction_event",
        proposedBy: CORRECTION_EVENT_PRODUCER,
      },
    ]);
  });

  test("stays silent below the repeat threshold", async () => {
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 2;
    store.seedFact({ id: "old", object: "Ana", status: "published" });

    await run(store, { factId: "old", verb: "supersede", replacement: { object: "Bo" } });

    expect(store.cardinalityProposals).toEqual([]);
  });

  test("the proposal is `pending` — the write path admits no `approved` from a producer", async () => {
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });

    await run(store, { factId: "old", verb: "supersede", replacement: { object: "Bo" } });

    // Not an assertion about the row this fake stored — an assertion about the
    // STATEMENT, which is where the guarantee lives. A producer that could write
    // `approved` would make `cardinalitySingleSql` read a repeat-gated heuristic
    // with no human anywhere in the loop, which is the whole thing §3(d)
    // exists to prevent.
    const proposeSql = store.executed.find((sql) =>
      sql.startsWith("INSERT INTO brain_predicate_cardinality"),
    );
    expect(proposeSql).toContain("'pending'");
    expect(proposeSql).not.toContain("'approved'");
    expect(proposeSql).toContain("ON CONFLICT (workspace_id, predicate_key) DO NOTHING");
  });

  test.each(["retract", "re-authority", "pin"] as const)(
    "%s proposes nothing — only supersede is evidence about cardinality",
    async (verb) => {
      const store = new FakeCorrectionStore();
      // Far past the bar, so a verb that fed the gate would certainly propose.
      store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD + 5;
      store.seedFact({ id: "old", object: "Ana", status: "published" });

      const outcome = await run(store, { factId: "old", verb });

      expect(outcome.kind).toBe("corrected");
      // Retracting a claim says nothing about how many could have coexisted, and
      // vouching says less. Only `supersede` is a human asserting BY ACTION that
      // the slot holds one value.
      expect(store.cardinalityProposals).toEqual([]);
      expect(store.executed).not.toContain(CORRECTION_REPEAT_COUNT_SQL);
      // And no second transaction is opened at all — the proposer is not merely
      // silent for these verbs, it is not reached.
      expect(store.transactions).toBe(1);
    },
  );

  test("a HUNG proposal never reaches the caller either — the deadline is what makes that true", async () => {
    // The failure a `try`/`catch` cannot absorb, and the one the placement
    // argument does not cover on its own. A degraded internal DB never throws:
    // `internalQuery` bypasses the circuit breaker and the internal pool sets no
    // `statement_timeout`, so without a deadline this await never settles,
    // `correctFact` never returns, and the caller's own timeout fires. The agent
    // tool's error copy then says *"nothing was changed — retry"* about a
    // correction that IS committed, and the retry mints a SECOND correction
    // episode for one human decision — exactly what the audit deadline beside it
    // exists to prevent.
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.hangCardinalityProposal = true;

    const outcome = await correctFact(
      {
        ctx: admin(),
        vocabulary: identityVocabulary,
        factId: "old",
        verb: "supersede",
        replacement: { object: "Bo" },
      },
      {
        withTransaction: store.runner,
        now: () => NOW,
        newCorrectionId: () => "test-uuid",
        // The same knob the audit write uses, deliberately: two post-commit
        // writes with different answers to one hazard is how one of them ends
        // up unbounded again.
        auditWriteTimeoutMs: 50,
      },
    );

    expect(outcome.kind).toBe("corrected");
    expect(store.fact("old").validTo).toBe(NOW.toISOString());
    expect(store.cardinalityProposals).toEqual([]);
  }, 5_000);

  test("a SUPERSEDE clears the proposer's deadline timer instead of leaving it armed", async () => {
    // The mutation table published this row as a `0` with the note "invisible to
    // a test suite — `bun test` force-exits". That was wrong, and the technique
    // that falsifies it was already in `correction-audit.test.ts`, one file over,
    // guarding the SAME defect in the SAME module — it stays green under this
    // mutation only because it drives `pin`, which never reaches the proposer.
    //
    // The defect it catches is round 1's own: a `finally` attached to the TIMER
    // PROMISE settles only when the timer fires, so `clearTimeout` is always a
    // no-op and the fast path leaves a 5s timer armed on every supersede. Every
    // other assertion in this file is blind to it, because the race has already
    // settled on the winning branch.
    type SetTimeoutFn = typeof globalThis.setTimeout;
    type ClearTimeoutFn = typeof globalThis.clearTimeout;
    const realSetTimeout: SetTimeoutFn = globalThis.setTimeout;
    const realClearTimeout: ClearTimeoutFn = globalThis.clearTimeout;
    const created = new Set<ReturnType<SetTimeoutFn>>();
    const cleared = new Set<unknown>();
    globalThis.setTimeout = ((...args: Parameters<SetTimeoutFn>) => {
      const handle = realSetTimeout(...args);
      created.add(handle);
      return handle;
    }) as SetTimeoutFn;
    globalThis.clearTimeout = ((handle: Parameters<ClearTimeoutFn>[0]) => {
      cleared.add(handle);
      realClearTimeout(handle);
    }) as ClearTimeoutFn;

    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    try {
      await run(store, { factId: "old", verb: "supersede", replacement: { object: "Bo" } });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    // Every timer armed during a correction must be disarmed by the time it
    // returns. Stated that way rather than "the deadline timer specifically",
    // so the assertion survives a second timer being added.
    expect(created.size).toBeGreaterThan(0);
    expect([...created].filter((h) => !cleared.has(h))).toEqual([]);
  });

  test("a FAST store failure is reported as a failure, not as a timeout", async () => {
    // The catch branches on `timedOut`, and this is the arm that says so. An
    // unbranched line — the first cut — told an operator a `42P01` thrown in 2ms
    // "could not be evaluated within its deadline" (no deadline event happened)
    // and that the statement "may still commit" (`withTransaction` had rolled it
    // back). A lying disclosure in the helper written to stop one.
    //
    // Also asserts there is exactly ONE line: the pre-race continuation is
    // guarded on `timedOut` too, and without that guard this single event
    // produces two warns whose `err` strings are identical — double-counting any
    // alert built on it.
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.failCardinalityProposal = true;

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    expect(outcome.kind).toBe("corrected");

    const gateWarns = warns().filter((c) => c.message.includes("cardinality repeat gate"));
    expect(gateWarns).toHaveLength(1);
    expect(gateWarns[0]?.message).toContain("did NOT land");
    expect(gateWarns[0]?.message).not.toContain("may still commit");
    expect(gateWarns[0]?.message).not.toContain("within its deadline");
    expect(gateWarns[0]?.payload).toMatchObject({ timedOut: false });
  });

  test("a TIMED-OUT proposal says its fate is unknown, and does not claim it failed", async () => {
    // The other arm. `Promise.race` does not cancel the query, so the statement
    // may still commit — and a line claiming otherwise would be the same lie in
    // the opposite direction.
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.hangCardinalityProposal = true;

    const outcome = await correctFact(
      {
        ctx: admin(),
        vocabulary: identityVocabulary,
        factId: "old",
        verb: "supersede",
        replacement: { object: "Bo" },
      },
      {
        withTransaction: store.runner,
        now: () => NOW,
        newCorrectionId: () => "test-uuid",
        auditWriteTimeoutMs: 50,
      },
    );
    expect(outcome.kind).toBe("corrected");

    const gateWarns = warns().filter((c) => c.message.includes("cardinality repeat gate"));
    expect(gateWarns).toHaveLength(1);
    expect(gateWarns[0]?.message).toContain("may still commit");
    expect(gateWarns[0]?.message).not.toContain("did NOT land");
    expect(gateWarns[0]?.payload).toMatchObject({ timedOut: true });
  }, 5_000);

  test("a proposal that FAILS after the deadline still surfaces its real cause", async () => {
    // The post-deadline continuation, which nothing could reach before: the hang
    // knob never settles, so both arms were unfalsifiable and deleting all 28
    // lines of them was green. `Promise.race` marks the loser's rejection
    // HANDLED, so without the continuation a `42P01` arriving two seconds late
    // is dropped with no line and not even an unhandled rejection — and the only
    // record an operator holds says "may still commit".
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.delayCardinalityProposalMs = 120;
    store.delayedProposalRejects = true;

    const outcome = await correctFact(
      {
        ctx: admin(),
        vocabulary: identityVocabulary,
        factId: "old",
        verb: "supersede",
        replacement: { object: "Bo" },
      },
      {
        withTransaction: store.runner,
        now: () => NOW,
        newCorrectionId: () => "test-uuid",
        auditWriteTimeoutMs: 30,
      },
    );
    expect(outcome.kind).toBe("corrected");

    // The deadline line lands first; the cause follows once the query settles.
    await waitFor(() =>
      expect(
        warns().filter((c) => c.message.includes("FAILED after its deadline")),
      ).toHaveLength(1),
    );
    const late = warns().find((c) => c.message.includes("FAILED after its deadline"));
    expect(late?.message).toContain("underlying cause");
    expect(late?.message).toContain("no proposal landed");
  }, 5_000);

  test("a proposal that SUCCEEDS after the deadline says so — and stays silent when it wins", async () => {
    // The other continuation arm, and the reason it needs its own test: with the
    // guard INVERTED (`if (timedOut) return`) this line would fire on every
    // ordinary supersede — alert fatigue on the happy path, which is the defect
    // the sibling logging suite guards with its own "stays silent" test. Both
    // halves are asserted here because either alone is satisfiable by a
    // permanently silent arm.
    const late = new FakeCorrectionStore();
    late.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    late.seedFact({ id: "old", object: "Ana", status: "published" });
    late.delayCardinalityProposalMs = 120;

    await correctFact(
      {
        ctx: admin(),
        vocabulary: identityVocabulary,
        factId: "old",
        verb: "supersede",
        replacement: { object: "Bo" },
      },
      {
        withTransaction: late.runner,
        now: () => NOW,
        newCorrectionId: () => "test-uuid",
        auditWriteTimeoutMs: 30,
      },
    );
    await waitFor(() =>
      expect(warns().filter((c) => c.message.includes("COMPLETED after its deadline"))).toHaveLength(
        1,
      ),
    );

    // …and the prohibition: a supersede that beats its deadline logs NOTHING
    // from the proposer.
    logCalls.length = 0;
    const prompt = new FakeCorrectionStore();
    prompt.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    prompt.seedFact({ id: "old", object: "Ana", status: "published" });
    await run(prompt, { factId: "old", verb: "supersede", replacement: { object: "Bo" } });
    expect(warns().filter((c) => c.message.includes("cardinality repeat gate"))).toEqual([]);
  }, 5_000);

  test("a supersede whose predicate NORMS AWAY leaves a trace, and no other verb does", async () => {
    // `logDegeneratePredicate`'s whole reason for existing, and it was
    // unobserved in both directions: deleting the call was green, and so was
    // removing its `verb === "supersede"` guard so it fired for all four.
    //
    // The predicate `---` normalizes to nothing, so `slotKey` answers `null` —
    // the same `null` the other three verbs send — and the proposer is skipped.
    // Without the line that is a supersede producing no proposal and no record
    // at all.
    const store = new FakeCorrectionStore();
    store.seedFact({ id: "old", predicate: "---", object: "Ana", status: "published" });

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });
    expect(outcome.kind).toBe("corrected");
    expect(
      logCalls.filter((c) => c.level === "debug" && c.message.includes("normalizes away")),
    ).toHaveLength(1);
    // …and the proposer was not reached, which is the behaviour the line
    // documents rather than merely accompanies.
    expect(store.executed).not.toContain(CORRECTION_REPEAT_COUNT_SQL);
  });

  test.each(["retract", "re-authority", "pin"] as const)(
    "%s never leaves that trace — only a supersede is evidence about cardinality",
    async (verb) => {
      // The prohibition half. Without it, removing the `verb === \"supersede\"`
      // guard is green: every verb would log "superseded a claim whose predicate
      // normalizes away", including the ones that superseded nothing.
      const store = new FakeCorrectionStore();
      store.seedFact({ id: "old", predicate: "---", object: "Ana", status: "published" });

      await run(store, { factId: "old", verb });

      expect(
        logCalls.filter((c) => c.message.includes("normalizes away")),
        `${verb} claimed it superseded a claim — that line is a supersede's alone`,
      ).toEqual([]);
    },
  );

  test("a failed proposal never reaches the caller — the correction is already committed", async () => {
    const store = new FakeCorrectionStore();
    store.priorCorrectedSubjects = CORRECTION_REPEAT_THRESHOLD - 1;
    store.seedFact({ id: "old", object: "Ana", status: "published" });
    store.failCardinalityProposal = true;

    const outcome = await run(store, {
      factId: "old",
      verb: "supersede",
      replacement: { object: "Bo" },
    });

    // The verb committed: the episode, the stamp and the edges are durable, and
    // reporting failure here would invite a retry that mints a SECOND correction
    // episode for one human decision — the same argument the audit row makes.
    expect(outcome.kind).toBe("corrected");
    expect(store.fact("old").validTo).toBe(NOW.toISOString());
    expect(store.cardinalityProposals).toEqual([]);
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
      expect(store.executed).not.toContain(SUPERSEDE_STAMP_EXPLICIT_SQL);
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
  // paraphrase — the same treatment `SUPERSEDE_STAMP_EXPLICIT_SQL` gets in this suite,
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
  //
  // The three identity keys (#5037) join the same table for a parallel reason,
  // stated because it is NOT the temporal one above. They do not fail open into
  // a permitted write; they fail open into a WRONG SLOT. An absent
  // `subject_key` defaulted to `null` hands `InheritedSlot` a `(NULL, NULL)`
  // slot for a row that has a real one, so the replacement lands un-collidable
  // while the id-based stamp retires the target regardless — #5037's exact
  // defect, reintroduced through the narrowing instead of through the
  // derivation. `null` itself stays legal: that is an unkeyed legacy row, and
  // only `undefined` (the column absent from the SELECT) is drift.
  for (const [column, fragment] of [
    ["window_closed", "window_closed"],
    ["valid_to", "valid_to absent"],
    ["subject_key", "subject_key absent"],
    ["predicate_key", "predicate_key absent"],
    ["object_key", "object_key absent"],
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
  // The same second arm for the three key columns (#5037). Dropping a column can
  // only ever produce `undefined`, so the loop above exercises the ABSENT arm and
  // leaves the TYPE arm untouched — the reason this file already carries a
  // wrong-type test for `valid_to` one test down. The mutant it catches is
  // `typeof value !== "string" ? null : value`, which compiles, keeps every
  // absent-column test green, and lands the replacement in the `(NULL, NULL)`
  // slot while the id-based stamp retires the target: #5037's exact defect,
  // reached through the narrowing instead of through the derivation.
  for (const column of ["subject_key", "predicate_key", "object_key"] as const) {
    test(`a target projection whose \`${column}\` decodes to the wrong type THROWS`, async () => {
      const store = new FakeCorrectionStore();
      store.overrideTargetColumns = { [column]: 12345 };
      store.seedFact({ id: "old", object: "Ana", status: "published" });

      await expect(
        run(store, { factId: "old", verb: "supersede", replacement: { object: "Bo" } }),
      ).rejects.toThrow(`unreadable ${column}`);
      expect(store.episodes).toHaveLength(0);
    });
  }

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

/**
 * The identity keys leave this module's SQL only through the target read
 * (#5037).
 *
 * ## Why this block exists
 *
 * `keys-not-on-the-wire.test.ts` bans projecting `subject_key` / `predicate_key`
 * / `object_key` from any file that speaks about `brain_facts`. #5037 puts
 * `correction.ts` in that guard's `ROW_COPY_SITES`, because inheriting the
 * target's slot requires reading it — and a whole-file exemption switches BOTH of
 * that guard's arms off for a module holding four statements over `brain_facts`
 * where the region bundle's exporter holds one.
 *
 * This is the compensating pin the exemption promises: per-STATEMENT where the
 * exemption is per-file, so a key added to `REPLACEMENT_ROW_SQL` or
 * `DEPENDENT_FACTS_SQL` for an unrelated read is caught here even though the
 * global guard no longer looks.
 *
 * ## It reads the STATEMENTS, not the source
 *
 * Every assertion below runs against the exported statement strings and against
 * `correctionTargetSql`'s actual return value — not against the text of
 * `correction.ts`. A source-text pin cannot falsify a change in what that text
 * MEANS, which is the defect #5077 recorded one loop over: a grep for
 * `subject_key` would pass just as happily if the column moved from the target
 * read into the replacement read, since both spellings are the same bytes.
 *
 * ## What it deliberately does NOT cover
 *
 * The wire. `packages/schemas/src/brain.ts` and `packages/types/src/brain.ts` are
 * still scanned by the global guard — neither is exempt — so a key reaching a
 * REST response or a fact-shaped wire type is still caught there, and pinning it
 * a second time here would claim a coverage this file cannot honestly provide.
 */
describe("the identity keys never leave the target read (#5037)", () => {
  /**
   * ALL FIVE gated columns, not the three this slice reads.
   *
   * ⚠️ The exemption this block compensates for switches off `subject_cmp` and
   * `object_cmp` too (`keys-not-on-the-wire.test.ts`'s `KEY_COLUMNS`), and a pin
   * that replaces a five-column guard with a three-column one has quietly
   * narrowed the prohibition while claiming to preserve it. `object_cmp` in
   * particular is the arm that proves DIFFERENCE at the publish gate, so a
   * `SELECT f.object_cmp` added to `REPLACEMENT_ROW_SQL` is exactly the leak
   * worth catching.
   */
  const KEY_COLUMNS = [
    "subject_key",
    "predicate_key",
    "object_key",
    "subject_cmp",
    "object_cmp",
  ] as const;

  /** The three THIS module legitimately reads. Everything else is a leak. */
  const INHERITED_COLUMNS = ["subject_key", "predicate_key", "object_key"] as const;

  /** The ACL clause shape `correctFact` passes in — any true predicate will do. */
  const TARGET_READ = correctionTargetSql("f.workspace_id = $1", 2);

  /**
   * Every statement this module can execute, by name.
   *
   * Enumerated from the module's own exports rather than listed by hand, so a
   * NEW statement is covered the day it is added — which is the failure mode a
   * hand-written list has and the whole reason the global guard discovers its
   * files instead of naming them.
   */
  const statements = async (): Promise<[string, string][]> => {
    // NOT named `module`: `next(no-assign-module-variable)` is a CI-blocking
    // error on that identifier, and the whole repo lints under one config.
    const exports: Record<string, unknown> = await import("@atlas/api/lib/brain/correction");
    const found: [string, string][] = [];
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== "string") continue;
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(value)) continue;
      found.push([name, value]);
    }
    found.push(["correctionTargetSql", TARGET_READ]);
    return found;
  };

  /** Projection spans — `SELECT … FROM` and `RETURNING …`, the guard's two shapes. */
  const projectionsOf = (sql: string): string[] => [
    ...[...sql.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)].map((m) => m[1]!),
    ...[...sql.matchAll(/\bRETURNING\b([^;]*)/gi)].map((m) => m[1]!),
  ];

  /**
   * WRITE spans — an `UPDATE … SET …` clause and an `INSERT INTO … (columns)`
   * list.
   *
   * ⚠️ Without this the block is blind to the failure THREE separate places name
   * it as the guard against. `correction.ts` is whole-file allowlisted in
   * `check-brain-fact-promotion.sh` (covering all five gated columns) AND
   * whole-file exempt in `keys-not-on-the-wire.test.ts`, and a projection scan
   * cannot see a `SET`. A future `UPDATE brain_facts SET subject_key = …` added
   * to this module — the plausible "re-key the target while we're here" edit —
   * was therefore caught by NOTHING, while three rationales asserted it was
   * caught here. A hole with a stop sign pointing the wrong way is worse than an
   * open one.
   */
  const writesOf = (sql: string): string[] => [
    ...[...sql.matchAll(/\bSET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|$)/gi)].map((m) => m[1]!),
    ...[...sql.matchAll(/\bINSERT\s+INTO\b[^(]*\(([^)]*)\)/gi)].map((m) => m[1]!),
  ];

  /** `*` or `f.*` in projection position — the arm the exemption also switched off. */
  const STAR_PROJECTION = /(^|[\s,(])(?:"?[\w$]+"?\.)?\*(?!\s*\))/;

  test("finds the module's statements at all", async () => {
    // Everything below is vacuous if the export scan breaks — a renamed constant
    // or a statement built at runtime would turn the two tests into green
    // no-ops, which is precisely the shape this block replaces.
    const found = await statements();
    expect(
      found.length,
      "the statement scan found nothing — every assertion in this block would pass vacuously",
    ).toBeGreaterThanOrEqual(6);
    expect(found.map(([name]) => name)).toContain("REPLACEMENT_ROW_SQL");
  });

  test("the scan's matchers detect planted violations", () => {
    // Every assertion in this block is of the `toEqual([])` shape, which passes
    // just as happily when a matcher matches nothing at all. So each matcher
    // proves itself on planted SQL first. `keys-not-on-the-wire.test.ts` carries
    // the same control and records that its star matcher's FIRST CUT read green
    // over a planted violation — the failure is real, not hypothetical.
    expect(projectionsOf("SELECT f.subject_key FROM brain_facts f").join(" ")).toContain(
      "subject_key",
    );
    expect(projectionsOf("UPDATE brain_facts SET x = 1 RETURNING object_cmp").join(" ")).toContain(
      "object_cmp",
    );
    expect(writesOf("UPDATE brain_facts SET subject_key = $1 WHERE id = $2").join(" ")).toContain(
      "subject_key",
    );
    expect(
      writesOf("INSERT INTO brain_facts (subject, predicate_key) VALUES ($1, $2)").join(" "),
    ).toContain("predicate_key");
    expect(STAR_PROJECTION.test(" f.* ")).toBe(true);
    // …and does NOT fire on an aggregate's star, which is what makes the arm
    // usable on real statements rather than a source of false alarms.
    expect(STAR_PROJECTION.test("COUNT(*)")).toBe(false);
  });

  test("every executed statement is one the scan can see", async () => {
    // The scan reads EXPORTED string constants. A module-private const, or a SQL
    // literal inlined at a `tx.query(…)` call site, is invisible to it — and the
    // whole-file exemption is precisely the incentive to add one. This turns the
    // docstring's claim ("a NEW statement is covered the day it is added") into
    // something enforced rather than asserted.
    const source = readFileSync(join(import.meta.dir, "..", "correction.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const known = new Set((await statements()).map(([name]) => name));
    // Statements IMPORTED from another module are fine and must not be flagged:
    // they are that module's to guard, and none of the modules this file imports
    // SQL from (`content-mode/adapters/brain-facts.ts`, `reconcile.ts`) carries
    // an exemption — the global scan still reads them. What this arm is for is a
    // statement declared HERE and not exported, which the whole-file exemption
    // makes invisible to everything.
    for (const [, names] of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
      for (const raw of names!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name) known.add(name);
      }
    }
    const args = [...source.matchAll(/\btx\.query\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
    expect(args.length, "found no tx.query call sites — the scan below is vacuous").toBeGreaterThan(
      5,
    );
    const unknown = args.filter((name) => !known.has(name) && name !== "correctionTargetSql");
    expect(
      unknown,
      "this module executes a statement declared here but not exported, so the key scan cannot see " +
        "it. Export it, so the projection and write arms above cover it — `correction.ts` is exempt " +
        "from keys-not-on-the-wire.test.ts whole-file, so a module-private statement is guarded by " +
        "nothing at all.",
    ).toEqual([]);
  });

  test("the target read projects all three keys", async () => {
    // The POSITIVE control. Without it the prohibition below is satisfied by a
    // module that reads no key at all — which is the pre-#5037 code, whose whole
    // defect was re-deriving what it should have read.
    const spans = projectionsOf(TARGET_READ).join(" ");
    for (const column of INHERITED_COLUMNS) {
      expect(spans, `the target read must project ${column} — the slot is INHERITED`).toContain(
        column,
      );
    }
  });

  test("the inherit channel is reachable from the row-copy path and nowhere else", () => {
    // ⚠️ The type stops a slot being FORGED; it does not stop one being MINTED.
    // `slotKey` is exported, so any producer can COMPUTE two keys and hand them
    // to `inheritSlotFromFactRow({ id, subject_key: computed, … })` — no
    // projection required, and invisible to both arms of
    // `keys-not-on-the-wire.test.ts` (its SQL arm reads only SELECT/RETURNING
    // spans; its identifier arm matches the camelCase spellings, not
    // `subject_key`). That call reintroduces exactly the defect #5037 removes,
    // in a file nobody is watching.
    //
    // So the doorway is pinned by CALL SITE, mirroring `ROW_COPY_SITES` itself:
    // ADR-0037 §8 grants the row-copy path an exception, and a row-copy path is
    // a specific, short list of files rather than a shape any producer can adopt.
    const ALLOWED = new Set([
      // Declares it.
      "packages/api/src/lib/brain/identity.ts",
      // The row-copy path — reads the keys off the target it is correcting.
      "packages/api/src/lib/brain/correction.ts",
    ]);
    const found = execFileSync(
      "grep",
      [
        "-rl",
        "inheritSlotFromFactRow",
        "packages",
        "ee",
        "plugins",
        "apps",
        "--include=*.ts",
        "--exclude=*.test.ts",
        "--exclude-dir=__tests__",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
      ],
      { cwd: join(import.meta.dir, "..", "..", "..", "..", "..", ".."), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    // Vacuity guard: a renamed export or a moved directory would empty this list
    // and the assertion below would pass having checked nothing.
    expect(found, "the inherit-channel grep found no files — this assertion is vacuous").toContain(
      "packages/api/src/lib/brain/identity.ts",
    );
    expect(
      found.filter((f) => !ALLOWED.has(f)),
      "a new caller is minting an inherited slot. ADR-0037 §1 forbids a producer COMPUTING identity; " +
        "the doorway exists only for a path that COPIES it off a row it already holds. If this really " +
        "is a row-copy path, add it here AND to ROW_COPY_SITES in keys-not-on-the-wire.test.ts, with " +
        "the rationale both places ask for.",
    ).toEqual([]);
  });

  test("the module never re-derives a key it could read off the target", () => {
    // ⚠️ THE RATCHET. The "re-derive what you could have read" defect appeared at
    // THREE sites in this one module — the reconcile candidate, the
    // `replacementIdentical` guard, and `supersededKey` — and two of the three
    // survived the falsifiers written for the first. A principle violated three
    // times in one file has outgrown prose, so this is the mechanical check that
    // makes a fourth impossible rather than a fourth comment asking for care.
    //
    // The rule is exact and needs no judgement: `slotKey(target.…)` re-derives
    // the TARGET's identity from a surface, and the target's identity is stored.
    // `slotKey(replacement.…)` is untouched and must stay — the replacement's
    // object is new text with no stored key to read, so deriving is the only
    // thing available there.
    //
    // This is a SOURCE-TEXT pin, which cannot falsify a change in what the text
    // MEANS — so it is a belt beside the four behavioural falsifiers (the two
    // inherit tests, the stored-object-key guard test, and the proposer's
    // stored-predicate test), never a replacement for them. What it adds is
    // coverage of the site that does not exist yet.
    // ⚠️ ONE SPELLING IS PERMITTED: `<stored> ?? slotKey(target.…)`. A stored NULL
    // means the row has no identity to inherit, and there the derivation is the
    // only honest answer — it is what `main` did for those rows, and removing it
    // is what switched the `replacementIdentical` guard off for an imported
    // corpus. The exemption is the `??` itself, so a BARE re-derivation is still
    // refused and the fallback cannot be spelled without admitting it is one.
    //
    // Written as a lookbehind on the operator rather than by hoisting the surface
    // into a local: hoisting would satisfy this matcher while changing nothing
    // about the code, and a guard a rename defeats is worse than no guard.
    const offendersIn = (text: string): string[] =>
      [...text.matchAll(/(\?\?\s*)?slotKey\(\s*target\.\w+/g)]
        .filter((m) => m[1] === undefined)
        .map((m) => m[0]);

    // ── The positive control ───────────────────────────────────────────────
    // `expect(offenders).toEqual([])` is the always-green shape: weaken the
    // regex to match nothing and this test passes forever with no signal. So the
    // matcher proves itself on planted source first — one violation it must
    // catch, and one permitted fallback it must not — before it is trusted on
    // the real file. `keys-not-on-the-wire.test.ts` carries the same control for
    // the same reason, and records that its star matcher's FIRST CUT read green
    // over a planted violation.
    expect(
      offendersIn("const k = slotKey(target.subject, vocabulary.subject);"),
      "the matcher does not detect a planted re-derivation — every assertion below is vacuous",
    ).toEqual(["slotKey(target.subject"]);
    expect(
      offendersIn("const k = target.objectKey ?? slotKey(target.object, vocabulary.object);"),
      "the matcher rejects the permitted `??` fallback — it would force the hoist it exists to prevent",
    ).toEqual([]);

    // BOTH comment forms are stripped. Stripping only `/* */` leaves a `//` line
    // mentioning `slotKey(target.subject, …)` — prose that already exists in this
    // repo — to false-fire the ratchet, and the repair anyone reaches for first
    // is weakening the regex, which disarms it silently.
    const source = readFileSync(join(import.meta.dir, "..", "correction.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(
      offendersIn(source),
      "the target's keys are STORED — read them off the row instead of re-deriving them from its surfaces. " +
        "A derived key equals the stored one only until the vocabulary moves (ADR-0037 §8), and every " +
        "divergence lands in the irreversible direction. The one permitted spelling is " +
        "`<stored> ?? slotKey(target.…)`, for a row that has no stored key to read.",
    ).toEqual([]);
  });

  test("no other statement projects a key, and none STARS brain_facts", async () => {
    for (const [name, sql] of await statements()) {
      const spans = projectionsOf(sql);
      // The star arm, for EVERY statement including the target read: `SELECT f.*`
      // projects all five keys without naming one, so the column loop below
      // cannot see it. This is the arm `keys-not-on-the-wire.test.ts` documents
      // as the reason a star check exists at all, and the exemption turned it off.
      for (const span of spans) {
        expect(
          STAR_PROJECTION.test(span),
          `${name} star-projects. A \`*\` over brain_facts carries all five identity columns ` +
            `without naming one, which every name-based arm here is blind to.`,
        ).toBe(false);
      }
      if (name === "correctionTargetSql") continue;
      const joined = spans.join(" ");
      for (const column of KEY_COLUMNS) {
        expect(
          joined.includes(column),
          `${name} projects \`${column}\`. Only the target read may, and only so the replacement can ` +
            `INHERIT the target's slot (ADR-0037 §8). \`correction.ts\` is exempt from ` +
            `keys-not-on-the-wire.test.ts whole-file, so this is the only thing looking.`,
        ).toBe(false);
      }
    }
  });

  test("NO statement writes a key — not even the target read's own module", async () => {
    // The arm the promotion guard's rationale names and the projection scan
    // could not provide. `correction.ts` copies keys; it must never author one.
    // The single sanctioned key writer is `vocabulary-decide.ts`'s re-key, and
    // `reconcile.ts` binds them on INSERT — neither is this module.
    for (const [name, sql] of await statements()) {
      const spans = writesOf(sql).join(" ");
      for (const column of KEY_COLUMNS) {
        expect(
          spans.includes(column),
          `${name} WRITES \`${column}\`. This module is a row-copy path: it inherits keys and never ` +
            `authors them. Whole-file allowlisted in check-brain-fact-promotion.sh, so its identity ` +
            `arm will not catch this — which is why the rationale there points here.`,
        ).toBe(false);
      }
    }
  });
});
