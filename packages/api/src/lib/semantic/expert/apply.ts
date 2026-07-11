/**
 * Apply a semantic expert amendment to the org's semantic layer.
 *
 * Reads the current document (an entity, or the group glossary for glossary
 * amendments — #4518), applies the amendment, writes the updated YAML,
 * invalidates caches, then records a version snapshot. Rollback-ability is part
 * of the apply (#4506): a snapshot failure fails the whole apply and best-effort
 * restores the pre-image, so the decide seam's compensation (row → pending)
 * stays truthful. The disk-mirror sync stays warn-only. Entity and glossary
 * paths share the write tail via {@link persistAmendedDocument}.
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
  parseGlossaryShapeOrError,
} from "./amendment-validation";
import {
  StaleBaselineError,
  computeDocDiff,
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
): Promise<{
  row: SemanticEntityRow;
  targetGroupId: string | null;
  parsed: Record<string, unknown>;
}> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  const { getEntity, AmbiguousEntityError } = await import("@atlas/api/lib/semantic/entities");

  const lookupScope = groupToLookupScope(group);
  let row = await getEntity(effectiveOrgId, "entity", entityName, lookupScope);
  if (!row && lookupScope !== undefined) {
    // The persisted group didn't resolve to a row — e.g. an interactive
    // `proposeAmendment` row (NULL group) whose flat-root entity was imported
    // under a datasource group, or a stale group label. Fall back to the
    // back-compat UNSCOPED lookup. Log the fallback so a wrong-scope diagnosis
    // isn't silent — the write-back below still targets the resolved row's OWN
    // group, so this only widens the read, never the write.
    log.debug(
      { entityName, requestedScope: lookupScope },
      "scoped amendment baseline lookup missed — falling back to unscoped resolve",
    );
    try {
      row = await getEntity(effectiveOrgId, "entity", entityName);
    } catch (fallbackErr) {
      // #4511 — cross-group ambiguity on a legacy row (the name lives in 2+
      // groups and no scope resolved it). If the admin picked a disambiguation
      // group, resolve at THAT explicit scope instead of re-raising the 409;
      // otherwise re-raise so the route surfaces the group picker.
      if (fallbackErr instanceof AmbiguousEntityError && disambiguationGroup !== undefined) {
        row = await getEntity(effectiveOrgId, "entity", entityName, disambiguationGroup);
      } else {
        throw fallbackErr;
      }
    }
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

// ── Glossary amendments (#4518) ──────────────────────────────────────────────
//
// A glossary term binds to a Connection group, and the glossary is amendable
// (CONTEXT.md § Semantic improvement). Glossary amendments do NOT touch an
// entity file — they write the group's glossary document, a `semantic_entities`
// row with `entity_type = "glossary"`, `name = "glossary"`, scoped by
// `connection_group_id`. They ride the SAME resolve → mutate → validate → upsert
// → snapshot write tail as entity amendments (`persistAmendedDocument`): the fix
// makes the live diff and version snapshot describe the GLOSSARY document
// instead of the old junk snapshot of an unchanged entity. The surrounding
// pipeline (rejection memory, pending dedup, auto-approve eligibility) is a
// property of the proposal envelope / decide seam and applies to a glossary
// amendment as it does to any amendment — see amendment-identity.ts for the
// host-agnostic glossary identity (#4518) that keeps dedup/rejection correct.

/** The fixed `semantic_entities.name` of the per-group glossary document. */
export const GLOSSARY_DOC_NAME = "glossary";

/** Whether an amendment type writes the group glossary rather than an entity. */
export function isGlossaryAmendmentType(amendmentType: AmendmentType): boolean {
  return amendmentType === "add_glossary_term" || amendmentType === "update_glossary_term";
}

/**
 * Resolve an {@link AnalysisResult.group} label to the `connection_group_id` a
 * glossary write/lookup targets. Unlike an entity, the glossary is ONE document
 * per group (`name = "glossary"`), so there is no unscoped ambiguity to resolve:
 * `"default"`/`undefined` → the flat root (`null`); any other label → that group.
 */
function glossaryTargetGroup(group: string | undefined): string | null {
  return group === undefined || group === "default" ? null : group;
}

/**
 * The on-disk path a glossary diff/preview is attributed to (ADR-0012 layout):
 * the flat-root `semantic/glossary.yml` for the default group, or the canonical
 * `semantic/groups/<group>/glossary.yml` for a named group.
 */
export function glossaryDiffPath(group: string | undefined): string {
  const g = glossaryTargetGroup(group);
  return g ? `semantic/groups/${g}/glossary.yml` : "semantic/glossary.yml";
}

/**
 * Resolve the current glossary ROW + parsed baseline for a group, the glossary
 * analog of {@link resolveAmendmentBaseline}. On the DB-backed path both the
 * diff preview (`proposeAmendment`) and the write (`applyGlossaryAmendmentToStore`)
 * go through it, so the document an admin reviews is the one approval mutates.
 * (The self-hosted no-DB propose branch previews the flat-root `glossary.yml`
 * directly, since the store/apply seam never runs there.)
 *
 * A group may not have a glossary yet — an absent (or empty) glossary is NOT an
 * error (contrast the entity resolver): it seeds an empty `{}` baseline so the
 * FIRST term creates the document. The returned `targetGroupId` is where every
 * write-back lands (`null` for the default flat scope).
 *
 * @throws only when a PRESENT glossary row's YAML is a non-empty non-mapping.
 */
export async function resolveGlossaryBaseline(
  orgId: string | null,
  group: string | undefined,
): Promise<{
  row: SemanticEntityRow | null;
  targetGroupId: string | null;
  parsed: Record<string, unknown>;
}> {
  const effectiveOrgId = orgId ?? "";
  const { getEntity } = await import("@atlas/api/lib/semantic/entities");
  const targetGroupId = glossaryTargetGroup(group);

  const row = await getEntity(effectiveOrgId, "glossary", GLOSSARY_DOC_NAME, targetGroupId);
  if (!row) {
    return { row: null, targetGroupId, parsed: {} };
  }

  // `loadYaml` returns undefined for an empty/whitespace document — a valid
  // "empty glossary", not a parse error.
  const parsed = loadYaml(row.yaml_content) as unknown;
  if (parsed === undefined || parsed === null) {
    return { row, targetGroupId, parsed: {} };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Failed to parse glossary for group "${group ?? "default"}": expected a mapping`,
    );
  }
  return { row, targetGroupId, parsed: parsed as Record<string, unknown> };
}

/**
 * Apply an amendment from an AnalysisResult to the org's semantic entity.
 *
 * 1. Read current YAML from DB — scoped to the finding's Connection group
 *    (`result.group`) so a group entity resolves without a 409 (#3284), via the
 *    shared {@link resolveAmendmentBaseline} the diff preview also uses (#4488)
 * 2. Apply amendment, serialize back
 * 3. Upsert entity + create version snapshot — written back to the row's OWN
 *    `connection_group_id`, so the amendment can never land in the wrong scope
 * 4. Invalidate caches and sync to disk (same group)
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
): Promise<void> {
  // Glossary amendments target the group's glossary document, not an entity —
  // route them to the glossary path (#4518). Same resolve → mutate → validate →
  // upsert → snapshot lifecycle + hash-carried stale-baseline check (#4511),
  // different target document. `disambiguationGroup` is entity-only (the
  // glossary resolves at a concrete group), so only the hash is threaded.
  if (isGlossaryAmendmentType(result.amendmentType)) {
    return applyGlossaryAmendmentToStore(orgId, result, requestId, {
      expectedBaselineHash: opts?.expectedBaselineHash,
    });
  }

  // Read the baseline through the shared resolver so the diff preview and this
  // write agree on the exact row + scope (#4488). Returns the row's OWN group.
  const { row: entity, targetGroupId, parsed } = await resolveAmendmentBaseline(
    orgId,
    result.entityName,
    result.group,
    opts?.disambiguationGroup,
  );

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

  // Upsert → invalidate → version snapshot (rollback-able) → disk sync, through
  // the shared persist seam both the entity and glossary paths ride (#4518).
  await persistAmendedDocument({
    orgId,
    docKind: "entity",
    docName: result.entityName,
    targetGroupId,
    preImageYaml: entity.yaml_content,
    updated,
    rationale: result.rationale,
    amendmentType: result.amendmentType,
    requestId,
  });
}

/**
 * Apply a glossary amendment to the org's group glossary document (#4518).
 *
 * The glossary sibling of the entity branch above: resolve the group's glossary
 * baseline (seeding an empty document when the group has none yet), apply the
 * term mutation, gate the result against {@link GlossaryShape}, then upsert +
 * snapshot + disk-sync through the shared {@link persistAmendedDocument} seam —
 * so the live diff, version snapshot, and rollback-ability are identical to an
 * entity amendment. `result.group` (not `result.entityName`, the host entity
 * the term was found under) selects the target glossary.
 */
async function applyGlossaryAmendmentToStore(
  orgId: string | null,
  result: AnalysisResult,
  requestId: string,
  opts?: { expectedBaselineHash?: string },
): Promise<void> {
  const { row, targetGroupId, parsed } = await resolveGlossaryBaseline(orgId, result.group);

  const updated = applyGlossaryAmendment(parsed, result);

  // #4511 — hash-carried claim, identical to the entity path: the admin approved
  // a live diff computed against a glossary baseline whose hash they carried in.
  // A mismatch means the glossary changed since render — raise a StaleBaselineError
  // with the FRESH glossary diff (inline update-and-confirm), never a silent apply
  // against a baseline the admin never saw. Run BEFORE the shape gate.
  if (opts?.expectedBaselineHash !== undefined) {
    const beforeNormalized = normalizeEntityYaml(parsed);
    const baselineHash = hashBaselineYaml(beforeNormalized);
    if (baselineHash !== opts.expectedBaselineHash) {
      throw new StaleBaselineError({
        entityName: `glossary (${result.group ?? "default"})`,
        diff: computeDocDiff(glossaryDiffPath(result.group), beforeNormalized, normalizeEntityYaml(updated)),
        baselineHash,
      });
    }
  }

  // Post-apply gate (#4513/#4518): the mutated document must still parse as a
  // glossary before it is written, so an amendment can never corrupt the
  // glossary into a shape the loaders would silently drop.
  const shapeError = parseGlossaryShapeOrError(updated);
  if (shapeError) {
    throw new Error(
      `Post-apply validation failed for the "${result.group ?? "default"}" glossary: ${shapeError}. The amendment was not applied.`,
    );
  }

  await persistAmendedDocument({
    orgId,
    docKind: "glossary",
    docName: GLOSSARY_DOC_NAME,
    targetGroupId,
    // A brand-new glossary has no pre-image — "" restores an empty document on a
    // snapshot-failure rollback (harmless; the next approve converges).
    preImageYaml: row?.yaml_content ?? "",
    updated,
    rationale: result.rationale,
    amendmentType: result.amendmentType,
    requestId,
  });
}

/**
 * The shared write tail every amendment apply rides (#4518): serialize → upsert
 * → invalidate caches → version snapshot (rollback-able) → disk sync. Extracted
 * so the entity and glossary paths share ONE copy of the load-bearing
 * rollback-ability contract (#4506) — a snapshot failure fails the whole apply
 * and best-effort restores the pre-image, keeping the decide seam's
 * compensation (row → pending) truthful. The disk-mirror sync stays warn-only.
 *
 * `docKind`/`docName` select the target row (`"entity"`/entityName or
 * `"glossary"`/`"glossary"`); the caller has already resolved `targetGroupId`
 * and validated `updated` against its document shape.
 */
async function persistAmendedDocument(params: {
  orgId: string | null;
  // Only the two document kinds that carry a post-apply shape gate reach this
  // seam — narrower than SemanticEntityType (which also admits metric/catalog).
  docKind: "entity" | "glossary";
  docName: string;
  targetGroupId: string | null;
  preImageYaml: string;
  updated: Record<string, unknown>;
  rationale: string;
  amendmentType: AmendmentType;
  requestId: string;
}): Promise<void> {
  const {
    orgId, docKind, docName, targetGroupId, preImageYaml, updated, rationale, amendmentType, requestId,
  } = params;
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  const {
    getEntity,
    upsertEntityForGroup,
    createVersion,
    generateChangeSummary,
    AmbiguousEntityError,
  } = await import("@atlas/api/lib/semantic/entities");

  // Serialize back to YAML (identical options on every path so a diff shows
  // only content changes, not formatting drift).
  const newYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });

  // Upsert the document into its own group scope.
  await upsertEntityForGroup(effectiveOrgId, docKind, docName, newYaml, targetGroupId);

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
    const refreshed = await getEntity(effectiveOrgId, docKind, docName, targetGroupId);
    if (!refreshed) {
      throw new Error(`${docKind} row not found after upsert`);
    }
    const changeSummary = await generateChangeSummary(preImageYaml, newYaml);
    const versionSummary = `Expert agent: ${rationale}${changeSummary ? ` (${changeSummary})` : ""}`;
    await createVersion(
      refreshed.id, effectiveOrgId, docKind, docName, newYaml, versionSummary,
      "expert-agent", "Semantic Expert Agent",
    );
  } catch (versionErr) {
    if (versionErr instanceof AmbiguousEntityError) throw versionErr;
    const msg = versionErr instanceof Error ? versionErr.message : String(versionErr);
    log.warn(
      { err: msg, requestId, orgId, doc: docName, docKind },
      "Version snapshot failed — failing the amendment apply (rollback-ability is part of the apply)",
    );
    // The upsert has already landed, so a compensated "pending" row would lie
    // about the layer's state. Best-effort restore of the pre-image keeps the
    // compensation truthful; if the restore itself fails, say so loudly in the
    // error (which becomes the row's visible `last_apply_error`) so an admin
    // never reads "pending" + a neutral reason and rejects a LIVE change.
    let restored = false;
    try {
      await upsertEntityForGroup(effectiveOrgId, docKind, docName, preImageYaml, targetGroupId);
      invalidateOrgWhitelist(effectiveOrgId);
      restored = true;
    } catch (restoreErr) {
      log.error(
        {
          err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          requestId,
          orgId,
          doc: docName,
          docKind,
        },
        "Failed to roll back YAML after snapshot failure — the change is LIVE while the amendment returns to pending",
      );
    }
    throw new Error(
      restored
        ? `Version snapshot failed for ${docKind} "${docName}": ${msg}. The YAML change was rolled back — retry the approval.`
        : `Version snapshot failed for ${docKind} "${docName}": ${msg}. WARNING: the YAML change is still applied (rollback also failed) — retry the approval to converge; do not reject.`,
      { cause: versionErr },
    );
  }

  // Sync to disk (non-fatal) — same group so the on-disk mirror lands in the
  // group namespace (`groups/<group>/…`) rather than the flat default dir.
  try {
    const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
    await syncEntityToDisk(effectiveOrgId, docName, docKind, newYaml, targetGroupId);
  } catch (syncErr) {
    log.warn(
      { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, doc: docName, docKind },
      "Amendment applied but disk sync failed",
    );
  }

  log.info(
    { requestId, orgId, doc: docName, docKind, amendmentType, group: targetGroupId },
    "Semantic amendment applied via expert agent",
  );
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
}): Promise<void> {
  const { orgId, sourceEntity, connectionGroupId, rawPayload, requestId } = params;

  const result = analysisResultFromStoredPayload({
    sourceEntity,
    connectionGroupId,
    rawPayload,
    label: params.label,
  });

  await applyAmendmentToEntity(orgId, result, requestId, {
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
    case "update_glossary_term":
      // Glossary amendments target the group glossary document, not an entity —
      // they must go through applyGlossaryAmendment (#4518). Reaching here means
      // a caller dispatched a glossary type down the entity mutation path.
      throw new Error(
        `Glossary amendment "${result.amendmentType}" must be applied via applyGlossaryAmendment, not applyAmendment`,
      );
    default:
      throw new Error(`Unsupported amendment type: ${result.amendmentType}`);
  }

  return updated;
}

/**
 * Read a glossary `terms` collection into a term→value map, honoring BOTH
 * on-disk shapes — the canonical object map (`terms: { <name>: {...} }`) and the
 * legacy array form (`terms: [{ term, ... }]`). The write always produces object
 * form (what the generator emits and every loader reads), so amending a legacy
 * array-form glossary migrates it to the canonical shape.
 *
 * Existing term values are preserved VERBATIM (values are `unknown`, not
 * narrowed to objects): amending one term must never rewrite an unrelated
 * sibling, including a malformed non-object one. Only the term the amendment
 * targets is (re)written as an object, by {@link applyGlossaryAmendment}.
 */
function termsToMap(terms: unknown): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (Array.isArray(terms)) {
    for (const entry of terms) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        const name = rec.term;
        if (typeof name === "string" && name.length > 0) {
          const { term: _term, ...rest } = rec;
          map[name] = rest;
        }
      }
    }
  } else if (terms && typeof terms === "object") {
    for (const [name, value] of Object.entries(terms as Record<string, unknown>)) {
      map[name] = value;
    }
  }
  return map;
}

/**
 * Apply a glossary amendment to a parsed glossary document (#4518). Returns a
 * new object; the input is never mutated.
 *
 * - `add_glossary_term` upserts the term value (create-or-replace by term name),
 *   idempotent like the entity `add_*` handlers — a re-approval converges rather
 *   than duplicating.
 * - `update_glossary_term` requires the term to already exist (throws otherwise,
 *   mirroring `update_dimension`) and copies ONLY its declared mutable fields
 *   (`definition`, `ambiguous`), preserving any other term attributes.
 */
export function applyGlossaryAmendment(
  glossary: Record<string, unknown>,
  result: AnalysisResult,
): Record<string, unknown> {
  const updated = structuredClone(glossary);
  const amendment = result.amendment;
  const term = amendment.term;
  if (typeof term !== "string" || term.trim() === "") {
    throw new Error(
      `Glossary amendment for entity "${result.entityName}" is missing a "term".`,
    );
  }

  const terms = termsToMap(updated.terms);
  const existing = terms[term];

  if (result.amendmentType === "update_glossary_term") {
    if (existing === undefined) {
      throw new Error(
        `Cannot update glossary term "${term}": not defined in the "${result.group ?? "default"}" glossary`,
      );
    }
    // Typed mutation (mirrors update_dimension): copy ONLY the fields
    // update_glossary_term declares it may touch; `term` is the selector. A
    // malformed non-object existing value is repaired into an object here (only
    // the targeted term is rewritten; siblings stay verbatim, see termsToMap).
    const base =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    const mutable = AMENDMENT_MUTABLE_FIELDS.update_glossary_term ?? [];
    const next = { ...base };
    for (const field of mutable) {
      if (Object.hasOwn(amendment, field)) next[field] = amendment[field];
    }
    terms[term] = next;
  } else {
    // add_glossary_term — upsert the term VALUE (everything but the `term` key,
    // which is the map key). Last-write-wins on re-approval, like add_dimension.
    const { term: _term, ...value } = amendment;
    terms[term] = value;
  }

  updated.terms = terms;
  return updated;
}

/**
 * Dispatch an amendment's pure YAML mutation to the right document mutator: the
 * group glossary for glossary types, else the entity mutation. The single entry
 * point the propose seam's diff preview goes through, so preview and apply agree
 * on the mutation for every amendment type (#4518). `doc` MUST be the matching
 * baseline (the glossary document for glossary types, the entity otherwise).
 */
export function applyAmendmentMutation(
  doc: Record<string, unknown>,
  result: AnalysisResult,
): Record<string, unknown> {
  return isGlossaryAmendmentType(result.amendmentType)
    ? applyGlossaryAmendment(doc, result)
    : applyAmendment(doc, result);
}
