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
import { SLACK_SOURCE, WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
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
    const roots = ["packages", "apps", "ee", "examples", "create-atlas", "create-atlas-plugin", "plugins"]
      .map((r) => join(repoRoot, r))
      .filter((r) => {
        try {
          return statSync(r).isDirectory();
        } catch {
          // intentionally ignored: an absent optional root is not scannable
          return false;
        }
      });

    // The guard's own vocabulary, mirrored: an optional schema qualifier with
    // either identifier independently quoted, so `public.brain_facts`,
    // `"public"."brain_facts"` and `"brain_facts"` all match — and the same for
    // a namespace-qualified Drizzle reference.
    const QUALIFIED = String.raw`("?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?brain_facts"?`;
    const ORM_TABLE = String.raw`([a-zA-Z_$][a-zA-Z0-9_$]*\.)?brainFacts`;
    const UPDATE_TABLE = new RegExp(String.raw`UPDATE\s+${QUALIFIED}\b`, "i");
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
    ]) {
      expect([evasion, writesTombstone(evasion)]).toEqual([evasion, true]);
    }
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
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue;
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx|js)$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        const hits = statementsOf(readFileSync(path, "utf8")).filter(writesTombstone);
        if (hits.length > 0) matched.set(path.substring(repoRoot.length + 1), hits);
      }
    };
    for (const root of roots) walk(root);

    // The scaffold templates carry generated copies of the same modules, so the
    // allowance is a shape rather than a list — the guard's ALLOWLIST draws the
    // identical line, and for the same reason names the FILE rather than a
    // `src/…` suffix any package could adopt.
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
    // Asserted FIRST, and it is not redundant: a scan that walked nothing — a
    // root list that drifted, a skip rule that swallowed `lib/` — would satisfy
    // the sole-writer assertion below vacuously.
    expect(relative).toContain("packages/api/src/lib/brain/correction.ts");
    expect(relative.filter((p) => !ALLOWED.some((allowed) => allowed.test(p)))).toEqual([]);

    // The publish adapter READS the tombstone, never writes it: nothing before
    // the first `WHERE` may name it. Best-effort by construction (a SET list
    // holding a subquery would truncate the slice), which is why it narrows an
    // already-bounded set rather than standing alone — and the SET list of the
    // statement that actually matters, `SUPERSEDE_STAMP_SQL`, is pinned
    // directly in `adapters/__tests__/brain-facts.test.ts`.
    for (const [path, statements] of matched) {
      if (/brain\/correction\.ts$/.test(path)) continue;
      for (const stmt of statements) {
        const where = stmt.search(/\bWHERE\b/i);
        expect([path, RAW_COLUMN.test(where < 0 ? stmt : stmt.slice(0, where))]).toEqual([path, false]);
      }
    }
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
  }
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
