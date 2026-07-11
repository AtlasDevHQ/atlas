/**
 * Apply a semantic expert amendment to the org's semantic layer.
 *
 * Reads the current entity YAML, applies the amendment, writes the updated
 * YAML, invalidates caches, then records a version snapshot. Rollback-ability
 * is part of the apply (#4506): a snapshot failure fails the whole apply and
 * best-effort restores the pre-image, so the decide seam's compensation
 * (row → pending) stays truthful. The disk-mirror sync stays warn-only.
 */

import * as yaml from "js-yaml";
import { loadYaml } from "../yaml";
import { ANALYSIS_CATEGORIES, type AnalysisResult, type AnalysisCategory } from "./types";
import { AMENDMENT_TYPES, type AmendmentType } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type { SemanticEntityRow } from "@atlas/api/lib/semantic/entities";
import {
  AMENDMENT_MUTABLE_FIELDS,
  parseEntityShapeOrError,
} from "./amendment-validation";
import {
  StaleBaselineError,
  computeEntityDiff,
  hashBaselineYaml,
  normalizeEntityYaml,
} from "./diff";

const log = createLogger("semantic-expert-apply");

/**
 * Resolve an {@link AnalysisResult.group} label to the `connection_group_id`
 * scope used for the entity LOOKUP (#3284):
 *
 * - `undefined` (interactive `proposeAmendment` path, group unknown) → `undefined`,
 *   preserving the back-compat unscoped lookup (`getEntity` runs its ambiguity
 *   check and 409s when the name exists in 2+ groups).
 * - `"default"` (the flat `entities/` group) → `null`, an EXPLICIT default-scope
 *   lookup that won't 409 even when the same name also lives in a group.
 * - `"<group>"` → the group name, scoping the lookup to that group's row.
 */
function groupToLookupScope(group: string | undefined): string | null | undefined {
  if (group === undefined) return undefined;
  return group === "default" ? null : group;
}

/**
 * Resolve the current entity ROW + parsed YAML baseline for an amendment,
 * scoped to its Connection group (ADR-0012, #3284). This is the SINGLE resolver
 * both the diff preview (`proposeAmendment`) and the write
 * (`applyAmendmentToEntity`) go through — identical org/group scoping on both,
 * so the document an admin reviews is the one approval mutates (each path does
 * its own DB read, so a concurrent write between them is not excluded — but the
 * scope can no longer diverge, which is the flat-root-vs-DB bug this closes:
 * the tool diffed a stale/absent file while apply mutated the org's DB row,
 * #4488).
 *
 * Lookup:
 * - scoped lookup via `groupToLookupScope(group)` — an explicit group avoids
 *   the unscoped ambiguity 409 for a name shared across groups; an undefined
 *   group keeps the legacy unscoped behavior for the interactive path;
 * - on a scoped miss (`group !== undefined`), fall back to the back-compat
 *   UNSCOPED lookup, which resolves a unique match (and only throws
 *   `AmbiguousEntityError` on genuine cross-group ambiguity).
 *
 * The returned `targetGroupId` is the resolved row's OWN `connection_group_id`
 * — authoritative for every write-back, and the group callers must thread to
 * the apply so it lands in the exact scope the baseline was read from.
 *
 * @throws when the entity is absent for this org, or its stored YAML is not a
 *   mapping. An `AmbiguousEntityError` from an unscoped multi-group lookup
 *   propagates too — the apply/approve route path maps it to 409; the
 *   `proposeAmendment` tool catches it and returns a generic error result.
 */
export async function resolveAmendmentBaseline(
  orgId: string | null,
  entityName: string,
  group: string | undefined,
  // #4511 — the disambiguation group an admin picked from a prior cross-group
  // 409. Consulted ONLY in the unscoped-fallback ambiguity branch below, so a
  // well-scoped amendment can never be redirected to a different group by a
  // caller-supplied value ("honored only when the server demanded disambiguation").
  // `undefined` = none provided; `null` = the legacy/default (flat) scope; a
  // string = that group. A candidate can legitimately be `null`, which is why
  // the "provided" test is `!== undefined`, not truthiness.
  disambiguationGroup?: string | null,
  // #4517 — the status overlay the baseline reads. The apply seam (approval is
  // the publish gate) and the live-diff render BOTH pass "published" so the diff
  // an admin reviews and the row an approval mutates are the PUBLISHED body —
  // never a draft overlay that would leak unpublished draft content into the
  // published row, or throw a spurious "target not found" when a draft removed
  // the amendment's target (that case is the dual-apply's visible skip, not an
  // apply failure). Defaults to "developer" for any other caller.
  mode: "developer" | "published" = "developer",
): Promise<{
  row: SemanticEntityRow;
  targetGroupId: string | null;
  parsed: Record<string, unknown>;
}> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  const { getEntity, AmbiguousEntityError } = await import("@atlas/api/lib/semantic/entities");

  const lookupScope = groupToLookupScope(group);

  // Resolve the entity ROW at a given status overlay: scoped read → unscoped
  // fallback on a scoped miss → admin-picked disambiguation on cross-group
  // ambiguity. Factored out so the published read and the draft-only fallback
  // below share the exact same scoping.
  async function resolveRow(readMode: "developer" | "published"): Promise<SemanticEntityRow | null> {
    let row = await getEntity(effectiveOrgId, "entity", entityName, lookupScope, readMode);
    if (!row && lookupScope !== undefined) {
      // The persisted group didn't resolve to a row — e.g. an interactive
      // `proposeAmendment` row (NULL group) whose flat-root entity was imported
      // under a datasource group, or a stale group label. Fall back to the
      // back-compat UNSCOPED lookup. Log the fallback so a wrong-scope diagnosis
      // isn't silent — the write-back below still targets the resolved row's OWN
      // group, so this only widens the read, never the write.
      log.debug(
        { entityName, requestedScope: lookupScope, readMode },
        "scoped amendment baseline lookup missed — falling back to unscoped resolve",
      );
      try {
        row = await getEntity(effectiveOrgId, "entity", entityName, undefined, readMode);
      } catch (fallbackErr) {
        // #4511 — cross-group ambiguity on a legacy row (the name lives in 2+
        // groups and no scope resolved it). If the admin picked a disambiguation
        // group, resolve at THAT explicit scope instead of re-raising the 409;
        // otherwise re-raise so the route surfaces the group picker.
        if (fallbackErr instanceof AmbiguousEntityError && disambiguationGroup !== undefined) {
          row = await getEntity(effectiveOrgId, "entity", entityName, disambiguationGroup, readMode);
        } else {
          throw fallbackErr;
        }
      }
    }
    return row;
  }

  let row = await resolveRow(mode);
  // #4517 — a published-anchored read must not hard-fail an entity that exists
  // ONLY as a draft (created in developer mode, never published). Fall back to
  // the developer overlay so a never-published draft still resolves; the write
  // then creates the published row and the dual-apply keeps the draft
  // convergent. The common case (a published row exists) never reaches here.
  if (!row && mode === "published") {
    row = await resolveRow("developer");
  }
  if (!row) {
    throw new Error(
      `Entity "${entityName}" not found for org ${orgId ?? "self-hosted (global)"}`,
    );
  }

  // The row's OWN group is authoritative for every write-back — whether we
  // resolved it by explicit scope or via the unscoped fallback, this is the
  // exact row we read, so the amendment can never be written into a different
  // (e.g. default) scope than the one it was analyzed against (#3284).
  const targetGroupId = row.connection_group_id ?? null;

  // Parse current YAML.
  // `loadYaml` returns undefined for a document-less row (v5 would throw),
  // routing it into the "expected a mapping" guard below.
  const parsed = loadYaml(row.yaml_content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Failed to parse YAML for entity "${entityName}": expected a mapping`);
  }

  return { row, targetGroupId, parsed };
}

/**
 * The result of applying an amendment — surfaces the content-mode dual-apply
 * carve-out's outcome (#4517) so callers and tests can see whether a draft
 * sibling converged. Approval is the publish gate: the write always lands on
 * the PUBLISHED row; `draftDualApply` reports what happened to any `draft` row.
 */
export interface AmendmentApplyResult {
  /**
   * #4517 — outcome of the content-mode dual-apply to a `draft` sibling:
   * - `no-draft`: the entity has no draft row (the common case) — nothing to do.
   * - `applied`: the approved change was also written to the draft, so a later
   *   publish (`draft → published`) carries it forward and can't clobber it.
   * - `skipped`: the draft couldn't take the change (it removed the amendment's
   *   target, tombstoned the entity, its stored YAML was unreadable, or the write
   *   itself failed). A VISIBLE skip — logged and (where a draft row was read)
   *   recorded on the draft's version history — never silence, and never a reason
   *   to un-approve the (already published) change.
   */
  readonly draftDualApply:
    | { kind: "no-draft" }
    | { kind: "applied" }
    | { kind: "skipped"; reason: string };
}

/**
 * Apply an amendment from an AnalysisResult to the org's semantic entity.
 *
 * 1. Read the current PUBLISHED YAML from DB — scoped to the finding's
 *    Connection group (`result.group`) so a group entity resolves without a 409
 *    (#3284), via the shared {@link resolveAmendmentBaseline} the diff preview
 *    also uses (#4488). Approval is the publish gate, so the baseline is the
 *    PUBLISHED body (#4517), never a draft overlay.
 * 2. Apply amendment, serialize back
 * 3. Upsert entity + create version snapshot — written back to the row's OWN
 *    `connection_group_id`, so the amendment can never land in the wrong scope
 * 4. Invalidate caches and sync to disk (same group)
 * 5. Content-mode dual-apply carve-out (#4517): when a `draft` sibling exists,
 *    apply the SAME amendment to it so a later publish can't clobber the
 *    approved change; a draft that can't take it records a visible skip.
 */
export async function applyAmendmentToEntity(
  orgId: string | null,
  result: AnalysisResult,
  requestId: string,
  // #4511 — review-integrity options: `disambiguationGroup` resolves a legacy
  // cross-group-ambiguous row at an admin-picked scope; `expectedBaselineHash`
  // is the hash-carried claim — a mismatch against the current baseline raises
  // a StaleBaselineError (fresh diff, inline update-and-confirm) instead of
  // silently applying against a baseline the admin never saw.
  opts?: { disambiguationGroup?: string | null; expectedBaselineHash?: string },
): Promise<AmendmentApplyResult> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  // Read the baseline through the shared resolver so the diff preview and this
  // write agree on the exact row + scope (#4488). Approval is the publish gate,
  // so read the PUBLISHED overlay (#4517): the row an approval mutates is the
  // published body, not a draft that shadows it. Returns the row's OWN group.
  const { row: entity, targetGroupId, parsed } = await resolveAmendmentBaseline(
    orgId,
    result.entityName,
    result.group,
    opts?.disambiguationGroup,
    "published",
  );

  const {
    getEntity,
    upsertEntityForGroup,
    createVersion,
    generateChangeSummary,
    AmbiguousEntityError,
  } = await import("@atlas/api/lib/semantic/entities");

  // Apply amendment (same logic as CLI's apply-amendment)
  const updated = applyAmendment(parsed, result);

  // #4511 — hash-carried claim: the admin reviewed a live diff computed against
  // a baseline whose hash they carried into this approve. Recompute the hash
  // against the baseline we just resolved; a mismatch means the entity changed
  // since render. That is not a failure — raise a StaleBaselineError carrying
  // the FRESHLY-computed live diff so the decide seam returns the claim to
  // pending cleanly and the card presents inline update-and-confirm. Run this
  // BEFORE the post-apply shape gate: a changed baseline should surface the
  // fresh-diff confirm, never a shape error against a baseline the admin never
  // saw. The hash is taken over the normalized baseline, exactly as the
  // review-render path computed it, so the two can only disagree on real change.
  if (opts?.expectedBaselineHash !== undefined) {
    const beforeNormalized = normalizeEntityYaml(parsed);
    const baselineHash = hashBaselineYaml(beforeNormalized);
    if (baselineHash !== opts.expectedBaselineHash) {
      throw new StaleBaselineError({
        entityName: result.entityName,
        diff: computeEntityDiff(result.entityName, beforeNormalized, normalizeEntityYaml(updated)),
        baselineHash,
      });
    }
  }

  // Post-apply gate (#4513): the mutated document must still parse as an entity
  // BEFORE it is written. A failure fails the whole apply (nothing is upserted),
  // so the decide seam compensates the claimed row back to `pending` with this
  // reason in `last_apply_error` — an amendment can never corrupt the
  // authoritative entity into a shape the whitelist/loader would silently drop.
  const shapeError = parseEntityShapeOrError(updated);
  if (shapeError) {
    throw new Error(
      `Post-apply validation failed for entity "${result.entityName}": ${shapeError}. The amendment was not applied.`,
    );
  }

  // Serialize back to YAML
  const newYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });

  // Upsert entity into its own group scope.
  await upsertEntityForGroup(effectiveOrgId, "entity", result.entityName, newYaml, targetGroupId);

  // Invalidate caches immediately — the mutation has landed, so a stale
  // whitelist must not outlive it even if the version snapshot below fails.
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  invalidateOrgWhitelist(effectiveOrgId);

  // Create version snapshot. Rollback-ability is part of the apply (#4506):
  // a snapshot failure FAILS the whole apply, so the decide seam compensates
  // the row back to pending instead of stamping `approved` on a change that
  // can't be rolled back. Tagged errors (AmbiguousEntityError) re-throw
  // untouched so the route layer maps them to 409 with `groups`.
  try {
    // Refetch the PUBLISHED row we just wrote (#4517) — approval is the publish
    // gate, so the version snapshot must attach to the published entity, not a
    // draft the developer overlay would otherwise prefer when one exists.
    const refreshed = await getEntity(
      effectiveOrgId, "entity", result.entityName, targetGroupId, "published",
    );
    if (!refreshed) {
      throw new Error("entity row not found after upsert");
    }
    const changeSummary = await generateChangeSummary(entity.yaml_content, newYaml);
    const versionSummary = `Expert agent: ${result.rationale}${changeSummary ? ` (${changeSummary})` : ""}`;
    await createVersion(
      refreshed.id, effectiveOrgId, "entity", result.entityName, newYaml, versionSummary,
      "expert-agent", "Semantic Expert Agent",
    );
  } catch (versionErr) {
    if (versionErr instanceof AmbiguousEntityError) throw versionErr;
    const msg = versionErr instanceof Error ? versionErr.message : String(versionErr);
    log.warn(
      { err: msg, requestId, orgId, entity: result.entityName },
      "Version snapshot failed — failing the amendment apply (rollback-ability is part of the apply)",
    );
    // The upsert has already landed, so a compensated "pending" row would lie
    // about the layer's state. Best-effort restore of the pre-image keeps the
    // compensation truthful; if the restore itself fails, say so loudly in the
    // error (which becomes the row's visible `last_apply_error`) so an admin
    // never reads "pending" + a neutral reason and rejects a LIVE change.
    let restored = false;
    try {
      await upsertEntityForGroup(
        effectiveOrgId, "entity", result.entityName, entity.yaml_content, targetGroupId,
      );
      invalidateOrgWhitelist(effectiveOrgId);
      restored = true;
    } catch (restoreErr) {
      log.error(
        {
          err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          requestId,
          orgId,
          entity: result.entityName,
        },
        "Failed to roll back entity YAML after snapshot failure — the change is LIVE while the amendment returns to pending",
      );
    }
    throw new Error(
      restored
        ? `Version snapshot failed for entity "${result.entityName}": ${msg}. The YAML change was rolled back — retry the approval.`
        : `Version snapshot failed for entity "${result.entityName}": ${msg}. WARNING: the YAML change is still applied (rollback also failed) — retry the approval to converge; do not reject.`,
      { cause: versionErr },
    );
  }

  // Sync to disk (non-fatal) — same group so the on-disk mirror lands in
  // `groups/<group>/entities/` rather than the flat default dir.
  try {
    const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
    await syncEntityToDisk(effectiveOrgId, result.entityName, "entity", newYaml, targetGroupId);
  } catch (syncErr) {
    log.warn(
      { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, entity: result.entityName },
      "Amendment applied but disk sync failed",
    );
  }

  // === Content-mode dual-apply carve-out (#4517) ===
  // The write above landed on the PUBLISHED row — approval is the publish gate.
  // When a `draft` sibling of this entity exists, a later publish
  // (`promoteDraftEntities`: delete published, flip draft → published) would
  // CLOBBER the approved change with the older draft body. Converge the draft by
  // applying the SAME amendment to it (upsert-by-identity), so publish carries
  // the approved change forward. A draft that removed the amendment's target — or
  // tombstoned the entity — can't take the change: a VISIBLE skip recorded on the
  // draft's version history, never a silent drop and never a reason to un-approve
  // the (already published) change. Runs AFTER the version snapshot so a snapshot
  // failure (which throws, attempting to roll the published write back) skips the
  // draft too — control never reaches here.
  // Rationale: docs/development/content-mode.md § "Amendment approval dual-applies
  // to a draft of the same entity".
  const draftDualApply = await dualApplyToDraftSibling({
    effectiveOrgId,
    result,
    targetGroupId,
    requestId,
  });

  log.info(
    {
      requestId, orgId, entity: result.entityName, amendmentType: result.amendmentType,
      group: targetGroupId, draftDualApply: draftDualApply.kind,
    },
    "Semantic amendment applied via expert agent",
  );

  return { draftDualApply };
}

/**
 * Content-mode dual-apply carve-out (#4517): mirror an approved amendment onto a
 * `draft` sibling of the entity so a later publish can't clobber the approved
 * change. Called after the published write has landed.
 *
 * - No draft row → `no-draft` (nothing to converge).
 * - A `draft_delete` tombstone (the draft removed the whole entity) → `skipped`:
 *   there is nothing to apply to, and publishing that tombstone would remove the
 *   entity and the approved change with it — surfaced as a visible skip.
 * - A live `draft` row → apply the SAME amendment to its OWN baseline and write
 *   it back. If the draft removed the amendment's target (`applyAmendment`
 *   throws) or the write fails, `skipped` with a reason — the published apply has
 *   already succeeded, so a draft-side problem must NOT fail it.
 *
 * Every skip is logged (never silence) and recorded on the draft's version
 * history (visible to an admin editing the draft).
 */
async function dualApplyToDraftSibling(params: {
  effectiveOrgId: string;
  result: AnalysisResult;
  targetGroupId: string | null;
  requestId: string;
}): Promise<AmendmentApplyResult["draftDualApply"]> {
  const { effectiveOrgId, result, targetGroupId, requestId } = params;

  // Outer guard (#4517): the published write has already landed durably by the
  // time we get here, so NO draft-side fault may throw out of this function —
  // that would reach the decide seam's generic compensation and bounce an
  // already-published amendment back to `pending`, the exact outcome the design
  // forbids. The two known-miss paths (target removed / tombstone) return a
  // recorded `skipped` below; this catch is the safety net for the UNEXPECTED
  // throws — a transient draft read error, or a malformed draft YAML that throws
  // in the parser (`loadYaml` throws on a non-empty malformed document). Any such
  // fault is surfaced loudly and skipped, never a reason to un-approve.
  try {
    const { getDraftEntityForGroup, upsertDraftEntityForGroup } = await import(
      "@atlas/api/lib/semantic/entities"
    );

    const draftRow = await getDraftEntityForGroup(
      effectiveOrgId, "entity", result.entityName, targetGroupId,
    );
    if (!draftRow) return { kind: "no-draft" };

    if (draftRow.status === "draft_delete") {
      const reason =
        `a draft deletion of "${result.entityName}" is pending; publishing it would remove the ` +
        `entity and the approved change with it`;
      await recordDraftSkip({ draftRow, result, reason, requestId });
      return { kind: "skipped", reason };
    }

    const draftParsed = loadYaml(draftRow.yaml_content) as Record<string, unknown>;
    if (!draftParsed || typeof draftParsed !== "object" || Array.isArray(draftParsed)) {
      const reason =
        `the draft of "${result.entityName}" is not a valid YAML mapping — the approved change was ` +
        `not mirrored to it`;
      await recordDraftSkip({ draftRow, result, reason, requestId });
      return { kind: "skipped", reason };
    }

    let draftUpdated: Record<string, unknown>;
    try {
      draftUpdated = applyAmendment(draftParsed, result);
    } catch (applyErr) {
      // Draft-side miss: the amendment can't apply to the draft — typically its
      // target (a dimension / measure the update selects) was removed in the
      // draft. The published apply already succeeded — DON'T fail it. Record a
      // visible skip so an admin editing the draft sees why it diverged.
      const detail = applyErr instanceof Error ? applyErr.message : String(applyErr);
      const reason = `the approved change could not apply to the draft of "${result.entityName}": ${detail}`;
      await recordDraftSkip({ draftRow, result, reason, requestId });
      return { kind: "skipped", reason };
    }

    const draftYaml = yaml.dump(draftUpdated, { lineWidth: 120, noRefs: true });
    try {
      await upsertDraftEntityForGroup(
        effectiveOrgId, "entity", result.entityName, draftYaml, targetGroupId,
      );
    } catch (writeErr) {
      // A transient draft-write failure must not un-approve the PUBLISHED change.
      // Surface it loudly (never silence) and report a skip; the draft stays
      // un-converged until re-approved or reconciled at publish.
      const detail = writeErr instanceof Error ? writeErr.message : String(writeErr);
      log.error(
        { requestId, entity: result.entityName, group: targetGroupId, err: detail },
        "Dual-apply to draft sibling failed to write — the approved change is PUBLISHED but the draft did not converge; publishing the draft may clobber it",
      );
      return { kind: "skipped", reason: `failed to write the draft of "${result.entityName}": ${detail}` };
    }

    log.info(
      { requestId, entity: result.entityName, group: targetGroupId },
      "Amendment dual-applied to the draft sibling — a later publish can't clobber the approved change",
    );
    return { kind: "applied" };
  } catch (unexpectedErr) {
    const detail = unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
    log.error(
      { requestId, entity: result.entityName, group: targetGroupId, err: detail },
      "Dual-apply to draft sibling failed unexpectedly — the approved change is PUBLISHED but the draft did not converge; the amendment stays approved (never un-approved by a draft-side fault)",
    );
    return {
      kind: "skipped",
      reason: `could not mirror the approved change to the draft of "${result.entityName}": ${detail}`,
    };
  }
}

/**
 * Surface a dual-apply skip VISIBLY on the draft (#4517): a version snapshot on
 * the draft row carrying the skip reason, so an admin editing the draft sees why
 * it diverges from the freshly-published change. Best-effort — a version-write
 * failure is logged, never thrown: a recording failure must not un-approve the
 * (already published) change. Always logs at warn so the skip is never silent.
 */
async function recordDraftSkip(params: {
  draftRow: SemanticEntityRow;
  result: AnalysisResult;
  reason: string;
  requestId: string;
}): Promise<void> {
  const { draftRow, result, reason, requestId } = params;
  log.warn(
    { requestId, entity: result.entityName, group: draftRow.connection_group_id ?? null, reason },
    "Content-mode dual-apply skipped for the draft sibling",
  );
  try {
    const { createVersion } = await import("@atlas/api/lib/semantic/entities");
    await createVersion(
      draftRow.id,
      draftRow.org_id,
      "entity",
      result.entityName,
      draftRow.yaml_content,
      `Skipped applying the approved amendment to this draft: ${reason}. Publish or discard this draft to reconcile.`,
      "expert-agent",
      "Semantic Expert Agent",
    );
  } catch (versionErr) {
    log.warn(
      {
        requestId,
        entity: result.entityName,
        err: versionErr instanceof Error ? versionErr.message : String(versionErr),
      },
      "Failed to record the dual-apply skip on the draft's version history (skip still logged)",
    );
  }
}

/**
 * Reconstruct an {@link AnalysisResult} from a stored `amendment_payload`
 * envelope and apply it to the org's semantic entity. Shared by every admin
 * approve path — the learned-patterns single-PATCH + bulk handlers and the
 * dedicated amendment-review endpoint — so the envelope→`AnalysisResult`
 * mapping lives once, beside {@link applyAmendmentToEntity} that consumes it.
 *
 * The stored payload is the full envelope
 * (`{ entityName, amendmentType, amendment, rationale, category, … }`); the YAML
 * mutation in {@link applyAmendment} reads the INNER `amendment` object, so the
 * reconstructed result carries `payload.amendment`, never the envelope itself.
 *
 * @throws when the payload is missing/malformed, or the YAML apply fails. An
 *   `AmbiguousEntityError` (a name shared across Connection groups) propagates
 *   to the caller (the route layer maps it to 409).
 */
export async function applyAmendmentFromPayload(params: {
  orgId: string | null;
  /** Entity the amendment targets — the row's authoritative `source_entity`. */
  sourceEntity: string;
  /** The amendment's Connection group; NULL = the default (flat) scope. */
  connectionGroupId: string | null;
  /** Raw `amendment_payload` column value — a JSON string or a parsed object. */
  rawPayload: unknown;
  requestId: string;
  /** Identifier surfaced in error messages (pattern / amendment id). */
  label?: string;
  /**
   * #4511 — an admin-picked group for a legacy cross-group-ambiguous row. Passed
   * through to {@link resolveAmendmentBaseline}, where it is honored ONLY when
   * default resolution is ambiguous (see that function). `undefined` = none.
   */
  disambiguationGroup?: string | null;
  /**
   * #4511 — the baseline hash the admin rendered. A mismatch against the current
   * baseline raises a StaleBaselineError (inline update-and-confirm) instead of
   * applying against an unseen baseline. `undefined` = no hash-carried claim.
   */
  expectedBaselineHash?: string;
}): Promise<AmendmentApplyResult> {
  const { orgId, sourceEntity, connectionGroupId, rawPayload, requestId } = params;

  const result = analysisResultFromStoredPayload({
    sourceEntity,
    connectionGroupId,
    rawPayload,
    label: params.label,
  });

  return await applyAmendmentToEntity(orgId, result, requestId, {
    disambiguationGroup: params.disambiguationGroup,
    expectedBaselineHash: params.expectedBaselineHash,
  });
}

/**
 * Reconstruct an {@link AnalysisResult} from a stored `amendment_payload`
 * envelope. Shared by the apply seam ({@link applyAmendmentFromPayload}) and the
 * live-diff render ({@link computeAmendmentLiveDiff}) so the document those two
 * paths mutate/diff is derived from the payload identically — there is one
 * envelope→result mapping, not two that could drift.
 *
 * The stored payload is the full envelope
 * (`{ entityName, amendmentType, amendment, rationale, category, … }`); the YAML
 * mutation in {@link applyAmendment} reads the INNER `amendment` object, so the
 * reconstructed result carries `payload.amendment`, never the envelope itself.
 *
 * @throws when the payload is missing/malformed (a null/corrupt payload or a
 *   missing inner `amendment` object) — never a silent skip (#4506).
 */
export function analysisResultFromStoredPayload(params: {
  sourceEntity: string;
  connectionGroupId: string | null;
  rawPayload: unknown;
  label?: string;
}): AnalysisResult {
  const { sourceEntity, connectionGroupId, rawPayload } = params;
  const label = params.label ?? sourceEntity;

  let payload: Record<string, unknown> | null = null;
  if (typeof rawPayload === "string") {
    try {
      const parsed: unknown = JSON.parse(rawPayload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new Error(
        `Corrupt amendment_payload JSON for amendment ${label}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  } else if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    payload = rawPayload as Record<string, unknown>;
  }

  if (!payload) {
    throw new Error(
      `Amendment ${label} has no amendment_payload — cannot apply its YAML change.`,
    );
  }

  const innerAmendment = payload.amendment;
  if (!innerAmendment || typeof innerAmendment !== "object" || Array.isArray(innerAmendment)) {
    throw new Error(
      `Amendment ${label} payload is missing a valid \`amendment\` object — cannot apply its YAML change.`,
    );
  }

  const rawCategory = String((payload.category ?? "coverage_gaps") as string);
  const rawAmendmentType = String((payload.amendmentType ?? "update_description") as string);

  return {
    entityName: sourceEntity,
    // Recover the Connection group the amendment was analyzed against so the
    // apply targets that group's row, not the default scope or a 409 (#3284).
    // A NULL group means the default (flat) group — map it to the explicit
    // `"default"` label so the lookup is scoped to NULL rather than running
    // the unscoped ambiguity check.
    group: connectionGroupId ?? "default",
    category: (ANALYSIS_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as AnalysisCategory)
      : "coverage_gaps",
    amendmentType: (AMENDMENT_TYPES as readonly string[]).includes(rawAmendmentType)
      ? (rawAmendmentType as AmendmentType)
      : "update_description",
    amendment: innerAmendment as Record<string, unknown>,
    rationale: typeof payload.rationale === "string" ? payload.rationale : "",
    confidence: 0,
    impact: 0,
    score: 0,
    staleness: 0,
  };
}

/** Maps simple "add_*" amendment types to their target array key. */
const ADD_AMENDMENT_KEYS: Record<string, string> = {
  add_dimension: "dimensions",
  add_measure: "measures",
  add_join: "joins",
  add_query_pattern: "query_patterns",
};

/**
 * Identity field per entity-array key, used to make re-applying an amendment
 * idempotent. Dimensions/measures/query-patterns are keyed by `name`; joins by
 * their `target_entity`.
 */
const ADD_AMENDMENT_IDENTITY: Record<string, string> = {
  dimensions: "name",
  measures: "name",
  joins: "target_entity",
  query_patterns: "name",
};

/**
 * Append `entry` to the `arrayKey` array, or REPLACE an existing element with
 * the same identity (last-write-wins) so re-approving the same amendment — or
 * approving an updated version of it — converges instead of pushing a duplicate
 * dimension/measure/join. The `add_*` handlers previously used a blind push, so
 * a second approval of the same name silently produced two identical entries.
 * When the entry carries no identity value we can't dedup it, so we append.
 */
function upsertByIdentity(
  arr: Record<string, unknown>[],
  arrayKey: string,
  entry: Record<string, unknown>,
): void {
  const idField = ADD_AMENDMENT_IDENTITY[arrayKey];
  const idVal = idField ? entry[idField] : undefined;
  if (idVal !== undefined && idVal !== null) {
    const idx = arr.findIndex((e) => e[idField] === idVal);
    if (idx >= 0) {
      arr[idx] = entry;
      return;
    }
  }
  arr.push(entry);
}

/** Apply an amendment to a parsed entity object. Returns a new object. */
export function applyAmendment(
  entity: Record<string, unknown>,
  result: AnalysisResult,
): Record<string, unknown> {
  const updated = structuredClone(entity);
  const amendment = result.amendment;

  // Handle the four simple "push to array" amendment types. Idempotent: a
  // re-approval of the same name replaces rather than duplicates.
  const arrayKey = ADD_AMENDMENT_KEYS[result.amendmentType];
  if (arrayKey) {
    const arr = (updated[arrayKey] ?? []) as Record<string, unknown>[];
    upsertByIdentity(arr, arrayKey, amendment);
    updated[arrayKey] = arr;
    return updated;
  }

  switch (result.amendmentType) {
    case "update_description": {
      if (amendment.field === "table") {
        updated.description = amendment.description;
      } else if (amendment.dimension) {
        const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
        const target = dims.find((d) => d.name === amendment.dimension);
        if (!target) {
          throw new Error(
            `Cannot update description: dimension "${String(amendment.dimension as string)}" not found in entity "${result.entityName}"`,
          );
        }
        target.description = amendment.description;
      } else {
        throw new Error(
          `Invalid update_description amendment: field="${String(amendment.field)}", dimension="${String(amendment.dimension)}"`,
        );
      }
      break;
    }
    case "update_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      const target = dims.find((d) => d.name === amendment.name);
      if (!target) {
        throw new Error(
          `Cannot update dimension: "${String(amendment.name)}" not found in entity "${result.entityName}"`,
        );
      }
      // Typed mutation, not a blind `Object.assign` (#4513): copy ONLY the
      // fields update_dimension declares it may touch. `name` is the selector
      // (never renamed) and `sql` is protected — an update can never repoint a
      // dimension's expression or smuggle a change bigger than its type
      // (ADR-0032 containment). Defense in depth with the propose-time strict
      // schema: even a legacy stored payload carrying `sql` cannot repoint here.
      const mutable = AMENDMENT_MUTABLE_FIELDS.update_dimension ?? [];
      for (const field of mutable) {
        if (Object.hasOwn(amendment, field)) {
          target[field] = amendment[field];
        }
      }
      break;
    }
    case "add_virtual_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      upsertByIdentity(dims, "dimensions", { ...amendment, virtual: true });
      updated.dimensions = dims;
      break;
    }
    case "add_glossary_term":
      // Glossary amendments don't modify entity files
      break;
    default:
      throw new Error(`Unsupported amendment type: ${result.amendmentType}`);
  }

  return updated;
}
