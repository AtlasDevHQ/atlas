/**
 * The fact class's promotion refusals evaluated at the review gate (#4769):
 * "no-provenance-no-promotion" (T4, ADR-0036 §Temporal, conflict & provenance)
 * and "no-grant-no-promotion" (T5, ADR-0036 §Access control & residency).
 *
 * Pure classification only. The transactional half — the SELECT, the scoped
 * UPDATE, and the `PromotionReport` — lives in
 * `lib/content-mode/adapters/brain-facts.ts`, which is the ONLY promotion path
 * (`scripts/check-brain-fact-promotion.sh` proves it). Keeping the rules here,
 * dependency-free, is what lets #4772's review surface pre-flight a candidate
 * and show the same verdict the publish endpoint will reach, without importing
 * the publish machinery or a database handle.
 *
 * ## Why there is anything to refuse at all
 *
 * Migration 0180 already makes most of both rules UNREPRESENTABLE AT REST, and
 * that is the point of reading this comment before assuming these checks are
 * redundant:
 *
 *   - `source_episode_id uuid NOT NULL` + the composite FK onto
 *     `brain_episodes (workspace_id, id)` — a fact with no evidence, or with
 *     another tenant's evidence, cannot be stored.
 *   - `chk_brain_facts_provenance_nonempty` — `jsonb_typeof(provenance) =
 *     'object' AND provenance <> '{}'` refuses an empty claim wearing the shape
 *     of a real one.
 *   - `chk_brain_facts_grant_nonempty` — at least one non-NULL, non-`''`
 *     element in `visible_to`.
 *
 * So `PROVENANCE_MISSING` and `PROVENANCE_EMPTY` are DEFENSE IN DEPTH: no draft
 * row can reach them today, and the live-PG test asserts exactly that — the
 * SCHEMA is what refuses, at INSERT (`NOT NULL` + the FK for the missing
 * episode, the CHECK for the empty payload). They exist because the seam must
 * survive a future schema relaxation, and because a rule ADR-0036 states as an
 * absolute should be enforced where the promotion decision is made, not only
 * where the bytes land.
 *
 * `GRANT_UNUSABLE` is different — it is a LIVE gap, and the reason this module
 * is not ceremony. The 0180 CHECK deliberately admits any non-empty element,
 * including one outside the grant grammar: `visible_to = ['everyone']` is
 * legally storable, has cardinality 1, and grants NOBODY access, because
 * enforcement is array overlap against reader tokens and no reader token is
 * ever malformed (see `acl.ts`).
 *
 * ## Why the stricter rule belongs HERE and not in the CHECK
 *
 * Read `acl.ts`'s rule precisely, because a loose paraphrase of it would
 * condemn this whole module: what it forbids is a stricter REJECTION AT REST
 * OR AT IMPORT — nothing in `acl.ts` may refuse a grant the CHECK admits, and
 * its named counterpart is `grantProblem` in `admin-migrate.ts`. It says
 * outright that its own parser is "deliberately stricter than both". So the
 * rule is not that Atlas may never be stricter than Postgres; it is that
 * Atlas may never make a legally-stored row unstorable or unimportable —
 * because such a row is a workspace that cannot be migrated between regions,
 * and the failure would surface at cutover.
 *
 * A promotion refusal is neither a rejection at rest nor at import. The row
 * stays stored, exportable, importable, and fixable; it is simply not stamped
 * "reviewed and trusted" while it is invisible to every reader. That is
 * precisely why the stricter rule is legitimate at this seam and would not be
 * legitimate as a tightened CHECK.
 *
 * The corollary, worth stating because it is easy to miss: `GRANT_UNUSABLE` is
 * an invariant of the PROMOTION PATH, not of published facts. A region import
 * writes `status` verbatim (`admin-migrate.ts`, the guard's one allowlisted
 * writer), so a workspace can legitimately arrive carrying an already-published
 * fact whose grant this classifier would refuse. That asymmetry is deliberate —
 * an importer stricter than the CHECK is the exact failure the rule above
 * forbids — and `promotion-pg.test.ts` pins it so a future "fix" of one side
 * has to argue with a test.
 *
 * This NARROWS the residual gap `acl.ts` names and tracks on #4797; it does not
 * close it. Still open there: `brain_episodes` (gated by the same predicate but
 * never promoted, so it has no equivalent seam) and facts that arrive already
 * `published` through the import path above.
 */

import { parseGrant } from "@atlas/api/lib/brain/acl";
import type { PromotionRefusal } from "@atlas/api/lib/content-mode/port";

/**
 * The refusal codes, as a closed vocabulary rather than free strings.
 *
 * The compile-time benefit is real but scoped to `@atlas/api`: a typo here is a
 * type error, and an API-side consumer (#4772's review surface, insofar as it
 * lives in the API) can branch exhaustively via {@link FactRefusal}. `@atlas/web`
 * may never import `@atlas/api` (CLAUDE.md § Code Style), so the web surface
 * reads `reasons` as plain strings off the wire and has no compile-time link to
 * this list — which is exactly why every refusal also carries a prose `detail`
 * the UI can render without knowing any code. If a future surface needs to
 * branch on these in the browser, the vocabulary moves to `@useatlas/types`
 * first.
 */
export const FACT_REFUSAL_REASONS = {
  /** `source_episode_id` is absent — the evidence pointer is the provenance. */
  provenanceMissing: "PROVENANCE_MISSING",
  /** `provenance` is not a non-empty JSON object. */
  provenanceEmpty: "PROVENANCE_EMPTY",
  /** Every `visible_to` token is outside the grant grammar — grants nobody. */
  grantUnusable: "GRANT_UNUSABLE",
  /**
   * `visible_to` did not arrive as an array at all. `visible_to text[] NOT NULL`
   * (0180) makes that impossible from the database, so this is QUERY DRIFT — a
   * changed SELECT, a mapping mistake — not bad tenant data. Kept distinct from
   * `GRANT_UNUSABLE` because the two send an investigation to opposite places:
   * one says fix the fact, the other says fix the code.
   */
  grantNotAnArray: "GRANT_NOT_AN_ARRAY",
} as const;

export type FactRefusalReason =
  (typeof FACT_REFUSAL_REASONS)[keyof typeof FACT_REFUSAL_REASONS];

/**
 * The columns the classifier reads, straight off `pg`. Deliberately `unknown`
 * where the driver's shape is not guaranteed: `provenance` arrives as a parsed
 * JS value whose type depends on the stored jsonb, and `visible_to` arrives as
 * an array whose elements may be `null`. Typing them optimistically here would
 * move the narrowing into the caller, where it would be skipped.
 */
export interface DraftFactRow {
  readonly id: string;
  /**
   * The SPO claim, for the refusal message. A UUID alone is not actionable —
   * #4772's review surface has not shipped, and the publish PREVIEW (which does
   * render the claim) is a different response the admin cannot cross-reference
   * from a publish result.
   */
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly source_episode_id: string | null;
  readonly provenance: unknown;
  readonly visible_to: unknown;
}

/**
 * A refusal from THIS classifier, with `reasons` narrowed to the closed
 * vocabulary above.
 *
 * `PromotionRefusal` types `reasons` as `readonly string[]` because it is the
 * generic port shape shared by every adapter (and teaching `port.ts` this
 * table's vocabulary would deepen the `port → tables → adapters → port` cycle
 * for no gain). But returning the widened type from here would defeat the whole
 * point of `FACT_REFUSAL_REASONS` being closed: #4772's review surface imports
 * this function directly and must be able to branch exhaustively. Narrowing on
 * the way out costs nothing — it still assigns to `PromotionRefusal`.
 */
export interface FactRefusal extends PromotionRefusal {
  readonly reasons: readonly FactRefusalReason[];
}

/** A non-null, non-array object — what `jsonb_typeof(...) = 'object'` means. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether one draft fact may be promoted, and if not, say why in terms
 * an admin can act on.
 *
 * Collects EVERY broken rule rather than stopping at the first: a fact that is
 * both unprovenanced and ungranted needs both fixed, and reporting one at a
 * time turns a single repair into two publish cycles.
 *
 * Returns `null` when the fact is promotable — the common case, and the one
 * that must be cheap.
 */
export function classifyFactForPromotion(row: DraftFactRow): FactRefusal | null {
  const reasons: FactRefusalReason[] = [];
  const details: string[] = [];

  // Defense in depth — `source_episode_id uuid NOT NULL` plus the composite FK
  // make this unreachable from the database, and `uuid` cannot hold whitespace.
  // The `.trim()` is therefore about the OTHER caller: this classifier is pure
  // and #4772 may pre-flight a candidate that has not been inserted yet, where
  // a whitespace-only id is an ordinary form-input mistake.
  if (typeof row.source_episode_id !== "string" || row.source_episode_id.trim() === "") {
    reasons.push(FACT_REFUSAL_REASONS.provenanceMissing);
    details.push("it has no source episode, so the claim has no evidence behind it");
  }

  // Defense in depth — `chk_brain_facts_provenance_nonempty` makes this
  // unreachable today.
  if (!isJsonObject(row.provenance) || Object.keys(row.provenance).length === 0) {
    reasons.push(FACT_REFUSAL_REASONS.provenanceEmpty);
    details.push("its provenance payload is empty, so there is nothing recording where it came from");
  }

  // The live rule. `parseGrant` is the single grammar — duplicating it as a
  // SQL predicate would let the two drift, and the enforcing side (Postgres
  // `&&` against reader tokens) is downstream of THIS parser's notion of a
  // usable principal, not of any SQL restatement of it.
  //
  // A non-array `visible_to` is refused too (fail-closed either way), but under
  // its own code: coercing it to `[]` and reporting "carries no grant" would
  // tell an admin their data is wrong when in fact the query is.
  if (!Array.isArray(row.visible_to)) {
    reasons.push(FACT_REFUSAL_REASONS.grantNotAnArray);
    details.push(
      "its grant did not load as an array, which means the draft-facts query returned an unexpected shape — this is an Atlas bug, not a problem with the fact",
    );
  } else {
    const parsed = parseGrant(row.visible_to as readonly unknown[]);
    if (parsed.principals.length === 0) {
      reasons.push(FACT_REFUSAL_REASONS.grantUnusable);
      details.push(
        parsed.malformed.length > 0
          ? `its grant contains no usable principal — ${describeMalformed(parsed.malformed)} — so it would be invisible to every reader. ${GRANT_GRAMMAR_HINT}`
          : `it carries no grant, so it would be invisible to every reader. ${GRANT_GRAMMAR_HINT}`,
      );
    }
  }

  if (reasons.length === 0) return null;

  // Some details already end in a sentence (the grant arm appends the grammar
  // hint); normalize so the joined prose never reads "…behind it Fix it".
  const because = details.join("; and ");
  const reason = because.endsWith(".") ? because : `${because}.`;

  return {
    rowId: row.id,
    reasons,
    detail: `"${row.subject} ${row.predicate} ${row.object}" (${row.id}) was not published because ${reason} Fix it (or retract it) and publish again — it is still a draft.`,
  };
}

/**
 * Render malformed grant tokens for an admin.
 *
 * `parseGrant` reports every NON-STRING element (a NULL smuggled in by a
 * hand-authored import bundle) as `''`, which is also what a genuine
 * empty-string element reports as — so a raw `JSON.stringify` join renders
 * `[null, null]` as `"", ""` and sends the reader looking for empty strings
 * that aren't there. Name the empty class instead of quoting it.
 */
function describeMalformed(malformed: readonly string[]): string {
  const named = malformed.filter((t) => t.length > 0);
  const emptyCount = malformed.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) {
    parts.push(`${named.map((t) => JSON.stringify(t)).join(", ")} ${named.length === 1 ? "is not a principal" : "are not principals"}`);
  }
  if (emptyCount > 0) {
    parts.push(`${emptyCount} empty or null entr${emptyCount === 1 ? "y" : "ies"}`);
  }
  return parts.join("; ");
}

/**
 * Valid grant tokens, in prose, appended to every `GRANT_UNUSABLE` refusal.
 *
 * Stated here rather than in the UI so the grammar has ONE prose home next to
 * the parser it describes — and so every surface that renders a refusal
 * (`detail` is passed through verbatim by the web modal, the CLI, and the MCP
 * tool) tells the reader the same thing about how to fix it.
 */
export const GRANT_GRAMMAR_HINT =
  "A grant must contain at least one of: `org`, `role:owner`, `role:admin`, `role:member`, `user:<id>`, or `audience:<name>`.";
