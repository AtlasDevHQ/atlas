/**
 * The fact class's promotion refusals — "no-provenance-no-promotion" (T4) and
 * "no-grant-no-promotion" (T5) evaluated at the review gate (#4769, ADR-0036
 * §Temporal, conflict & provenance).
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
 * row can reach them today, and the live-PG test asserts exactly that (the
 * CHECK is what refuses, and it refuses at INSERT). They exist because the seam
 * must survive a future CHECK relaxation, and because a rule ADR-0036 states as
 * an absolute should be enforced where the promotion decision is made, not only
 * where the bytes land.
 *
 * `GRANT_UNUSABLE` is different — it is a LIVE gap, and the reason this module
 * is not ceremony. The 0180 CHECK deliberately admits any non-empty element,
 * including one outside the grant grammar: `visible_to = ['everyone']` is
 * legally storable, has cardinality 1, and grants NOBODY access, because
 * enforcement is array overlap against reader tokens and no reader token is
 * ever malformed (see `acl.ts`). The CHECK cannot be tightened — `acl.ts`'s
 * header forbids any Atlas-side rule stricter than it, since a row Postgres
 * stores but Atlas refuses is a workspace that cannot be migrated between
 * regions. Promotion is the right place for the stricter rule instead: refusing
 * to PROMOTE is not refusing to STORE, so the row stays exportable, importable,
 * and fixable, while never being stamped "reviewed and trusted" when it is in
 * fact invisible to every reader. This closes at the promotion seam the
 * residual gap `acl.ts` names and tracks on #4797.
 */

import { parseGrant } from "@atlas/api/lib/brain/acl";
import type { PromotionRefusal } from "@atlas/api/lib/content-mode/port";

/**
 * The refusal codes, as a closed vocabulary rather than free strings so
 * #4772's review surface can branch on them and a typo is a compile error.
 */
export const FACT_REFUSAL_REASONS = {
  /** `source_episode_id` is absent — the evidence pointer is the provenance. */
  provenanceMissing: "PROVENANCE_MISSING",
  /** `provenance` is not a non-empty JSON object. */
  provenanceEmpty: "PROVENANCE_EMPTY",
  /** Every `visible_to` token is outside the grant grammar — grants nobody. */
  grantUnusable: "GRANT_UNUSABLE",
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
  readonly source_episode_id: string | null;
  readonly provenance: unknown;
  readonly visible_to: unknown;
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
export function classifyFactForPromotion(row: DraftFactRow): PromotionRefusal | null {
  const reasons: FactRefusalReason[] = [];
  const details: string[] = [];

  // Defense in depth — `source_episode_id uuid NOT NULL` makes this
  // unreachable today. `.trim()` guards a hand-authored import bundle that
  // smuggled whitespace through as a "present" id.
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
  const grant = Array.isArray(row.visible_to) ? (row.visible_to as readonly unknown[]) : [];
  const parsed = parseGrant(grant);
  if (parsed.principals.length === 0) {
    reasons.push(FACT_REFUSAL_REASONS.grantUnusable);
    details.push(
      parsed.malformed.length > 0
        ? `every token in its grant is outside the grammar (${parsed.malformed.map((t) => JSON.stringify(t)).join(", ")}), so it would be invisible to every reader`
        : "it carries no grant, so it would be invisible to every reader",
    );
  }

  if (reasons.length === 0) return null;

  return {
    rowId: row.id,
    reasons,
    detail: `Fact ${row.id} was not published because ${details.join("; and ")}. Fix it (or retract it) and publish again — it is still a draft.`,
  };
}

/**
 * Valid grant tokens, for the message an admin reads next to a refusal. Stated
 * here rather than rebuilt in the UI so the grammar has one prose home.
 */
export const GRANT_GRAMMAR_HINT =
  "A grant must contain at least one of: `org`, `role:owner`, `role:admin`, `role:member`, `user:<id>`, or `audience:<name>`.";
