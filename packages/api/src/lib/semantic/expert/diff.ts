/**
 * Live-diff + baseline-hash primitives for semantic Amendments (#4511).
 *
 * CONTEXT.md § "Live diff": the diff an admin reviews is ALWAYS computed against
 * the entity's *current* baseline at render time — the propose-time diff stored
 * on an Amendment is a record of intent, never the thing approved. A baseline
 * that changes mid-review means one more human look at an updated live diff — a
 * continuation of review, not an error.
 *
 * This module is the single home for the three operations that make that true:
 *
 *   - `normalizeEntityYaml` — canonical YAML dump so a diff shows only content
 *     changes, not formatting drift. The SAME normalization the review-render
 *     path (`GET /pending`), the propose tool, and the apply-time hash check all
 *     go through, so their diffs and hashes can never disagree.
 *   - `hashBaselineYaml` — the baseline hash a hash-carried claim compares. It
 *     is a hash of the NORMALIZED current baseline, so it is stable across
 *     re-dumps of the same content and changes exactly when the content does.
 *   - `computeEntityDiff` — the unified diff between two normalized documents.
 *
 * `computeAmendmentLiveDiff` composes them for a stored Amendment row: resolve
 * the current baseline, apply the amendment to a clone, and return the fresh
 * diff + its baseline hash. `StaleBaselineError` is the control-flow signal the
 * apply seam raises when a hash-carried claim no longer matches — the decide
 * seam turns it into a `stale` outcome (fresh diff for inline update-and-confirm),
 * never a failure.
 */

import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { createTwoFilesPatch } from "diff";

/**
 * Canonical dump options shared by every path that normalizes an entity for a
 * diff or a baseline hash (the propose tool, the live-diff render, the apply-time
 * hash check). They MUST stay identical across those paths — a divergence would
 * make a freshly-proposed Amendment render as "changed" the instant it is read,
 * or make every approve falsely stale.
 */
const DUMP_OPTS: yaml.DumpOptions = {
  lineWidth: 120,
  noRefs: true,
  quoteStyle: "double",
};

/**
 * Normalize a parsed entity object to canonical YAML. Both sides of a diff — and
 * the baseline the hash is taken over — go through this, so the diff reflects
 * real content changes rather than inline-vs-multiline / quoting drift.
 */
export function normalizeEntityYaml(entity: Record<string, unknown>): string {
  return yaml.dump(entity, DUMP_OPTS);
}

/**
 * Hash a NORMALIZED baseline YAML string — the token a hash-carried claim
 * carries and the decide seam compares. Because the input is already normalized
 * (via {@link normalizeEntityYaml}), the hash is stable across cosmetic re-dumps
 * and changes exactly when the entity's content changes.
 */
export function hashBaselineYaml(normalizedBaseline: string): string {
  return createHash("sha256").update(normalizedBaseline).digest("hex");
}

/**
 * Unified diff between two normalized YAML documents attributed to `filePath`.
 * Uses the `diff` package's LCS patch so multi-hunk changes render as a proper
 * unified diff. The document-kind-agnostic core: {@link computeEntityDiff}
 * attributes it to an entity file, glossary amendments to the group glossary.yml
 * (#4518).
 */
export function computeDocDiff(
  filePath: string,
  beforeNormalized: string,
  afterNormalized: string,
): string {
  return createTwoFilesPatch(filePath, filePath, beforeNormalized, afterNormalized, "", "", {
    context: 3,
  });
}

/**
 * Unified diff between two normalized YAML documents for `entityName`, attributed
 * to its `semantic/entities/<name>.yml` path.
 */
export function computeEntityDiff(
  entityName: string,
  beforeNormalized: string,
  afterNormalized: string,
): string {
  return computeDocDiff(`semantic/entities/${entityName}.yml`, beforeNormalized, afterNormalized);
}

/**
 * Control-flow signal raised by the apply seam when a hash-carried claim's
 * baseline hash no longer matches the entity's current baseline (#4511). It is
 * NOT a failure: the decide seam catches it, returns the claim to pending
 * cleanly (no `last_apply_error`), and hands the caller the freshly-computed
 * live diff + baseline hash for inline update-and-confirm.
 *
 * A plain Error subclass (not a `Data.TaggedError`): it never reaches the Hono
 * error mapping — the decide seam converts it to a `stale` outcome before it can
 * propagate — so it carries no `_tag` and needs no HTTP status mapping.
 */
export class StaleBaselineError extends Error {
  readonly entityName: string;
  /** The freshly-computed live diff against the CURRENT baseline. */
  readonly diff: string;
  /** The current baseline's hash — the value the caller must carry to confirm. */
  readonly baselineHash: string;

  constructor(params: { entityName: string; diff: string; baselineHash: string }) {
    super(
      `Entity "${params.entityName}" changed since the diff was rendered — review the updated change and confirm.`,
    );
    this.name = "StaleBaselineError";
    this.entityName = params.entityName;
    this.diff = params.diff;
    this.baselineHash = params.baselineHash;
  }
}

/** The live diff for a stored Amendment, computed against the current baseline. */
export interface AmendmentLiveDiff {
  /** Unified diff of the amendment applied to the CURRENT baseline. */
  readonly diff: string;
  /** Hash of the current normalized baseline — the token a claim carries. */
  readonly baselineHash: string;
}

/**
 * Compute the live diff + baseline hash for a stored Amendment row (#4511).
 *
 * Resolves the CURRENT baseline through the same shared resolver the apply seam
 * uses (`resolveAmendmentBaseline`), applies the amendment to a clone, and
 * returns the fresh diff + the current baseline's hash. This is what the review
 * panel renders — never the propose-time stored diff.
 *
 * @throws when the baseline cannot be resolved (entity absent, corrupt YAML, or
 *   an unscoped cross-group `AmbiguousEntityError`). Callers that render a list
 *   (`GET /pending`) catch per-row and fall back to the amendment preview; the
 *   cross-group case surfaces the group picker at approve time.
 */
export async function computeAmendmentLiveDiff(params: {
  orgId: string | null;
  sourceEntity: string;
  connectionGroupId: string | null;
  rawPayload: unknown;
  /** Surfaced in error messages (the amendment id). */
  label?: string;
}): Promise<AmendmentLiveDiff> {
  const {
    analysisResultFromStoredPayload,
    resolveAmendmentBaseline,
    applyAmendment,
    isGlossaryAmendmentType,
    resolveGlossaryBaseline,
    applyGlossaryAmendment,
    glossaryDiffPath,
  } = await import("./apply");

  const result = analysisResultFromStoredPayload({
    sourceEntity: params.sourceEntity,
    connectionGroupId: params.connectionGroupId,
    rawPayload: params.rawPayload,
    label: params.label,
  });

  // Glossary amendments diff the group's glossary DOCUMENT, not the host entity
  // the term was found under (#4518). Same live-diff contract — recompute
  // against the current baseline, hash the normalized baseline — but resolved,
  // mutated, and attributed against the glossary.
  if (isGlossaryAmendmentType(result.amendmentType)) {
    const { parsed } = await resolveGlossaryBaseline(params.orgId, result.group);
    const updated = applyGlossaryAmendment(parsed, result);
    const beforeNormalized = normalizeEntityYaml(parsed);
    const afterNormalized = normalizeEntityYaml(updated);
    return {
      diff: computeDocDiff(glossaryDiffPath(result.group), beforeNormalized, afterNormalized),
      baselineHash: hashBaselineYaml(beforeNormalized),
    };
  }

  const { parsed } = await resolveAmendmentBaseline(
    params.orgId,
    params.sourceEntity,
    result.group,
  );

  const updated = applyAmendment(parsed, result);
  const beforeNormalized = normalizeEntityYaml(parsed);
  const afterNormalized = normalizeEntityYaml(updated);

  return {
    diff: computeEntityDiff(params.sourceEntity, beforeNormalized, afterNormalized),
    baselineHash: hashBaselineYaml(beforeNormalized),
  };
}
