/**
 * Admin migration import route.
 *
 * Mounted under /api/v1/admin/migrate. Receives an export bundle produced by
 * `atlas export` (via the `atlas migrate-import` CLI) and imports workspace
 * data into the active org. Idempotent — re-importing skips data that already
 * exists in the target workspace.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { EPISODE_SOURCES, isEpisodeSource } from "@atlas/api/lib/brain/sources";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";
import { computeNextRun } from "@atlas/api/lib/scheduled-tasks";
import { BRAIN_EDGE_TYPES, type BrainEdgeType } from "@atlas/api/lib/brain/types";
import { SLOT_POSITIONS, isSlotPosition, lexicalNorm, type SlotPosition } from "@atlas/api/lib/brain/identity";
import {
  VOCABULARY_LOCK_NAMESPACE,
  VOCABULARY_LOCK_SQL,
  recomputeEffectiveTargets,
} from "@atlas/api/lib/brain/vocabulary";
import type { ExportBundle, ImportResult, SupportedBundleVersion } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-migrate");

/**
 * Why a grant is unacceptable, or `null` if it is fine (#4767).
 *
 * Deliberately mirrors `chk_brain_{facts,episodes}_grant_nonempty` EXACTLY —
 * at least one non-NULL, non-empty principal. Not looser (an empty grant
 * would abort the whole import transaction on the CHECK), and critically not
 * stricter either: anything Postgres stores must remain migratable, so an
 * importer that rejected a grant the source region legally holds would leave
 * that workspace permanently stuck in its current region.
 *
 * The matched pair is THIS function ↔ 0180's `chk_*_grant_nonempty`; they must
 * stay exactly as permissive as each other.
 *
 * Grammar validity (`org` vs `everyone`) is NOT checked here, and must never
 * be added. That belongs to `lib/brain/acl.ts`'s parser (#4768), which is
 * deliberately STRICTER than both and whose failure mode is deny+log at READ
 * time: a malformed token matches no reader principal, so it grants nobody
 * anything without ever making the row unimportable. Hoisting that parser to
 * import time would reject a legally-stored `['everyone']` bundle and leave
 * that workspace permanently stuck in its current region — a failure that
 * surfaces at cutover, not here.
 */
function grantProblem(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "must be an array of principals (no-grant-no-promotion).";
  }
  const usable = value.filter((p) => typeof p === "string" && p.length > 0);
  if (usable.length === 0) {
    return "must contain at least one non-empty principal (no-grant-no-promotion).";
  }
  return null;
}

/**
 * The first missing NOT NULL timestamp among `keys`, as an error fragment, or
 * `null` (#4767).
 *
 * node-pg binds `undefined` as NULL, and an explicit NULL OVERRIDES a column
 * default — so a producer that omitted `ingestedAt` doesn't get `now()`, it
 * gets a 23502 that rolls back the whole import. An unparseable string is the
 * same class of late failure (pg 22007), so it is caught here too.
 */
function missingTimestamps(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) {
      return `${key}: is required (a NOT NULL timestamp; an absent value binds as NULL and aborts the import).`;
    }
    if (Number.isNaN(Date.parse(value))) {
      return `${key}: '${value}' is not a parseable timestamp (it would abort the import at INSERT time).`;
    }
  }
  return null;
}

/**
 * The pre-#4460 bundle version — four sections only (conversations, semantic
 * entities, learned patterns, settings). Still accepted so bundles produced by
 * older exporters import cleanly; the v2 sections simply come back 0/0.
 */
const LEGACY_BUNDLE_VERSION = 1 satisfies SupportedBundleVersion;

/**
 * The current bundle version (#4460 — dashboards, knowledge, scheduled tasks,
 * session memory are required sections).
 *
 * Deliberately a LOCAL constant rather than `EXPORT_BUNDLE_VERSION` from
 * `@useatlas/types`: packages/api is scaffold-bound, and a scaffold build
 * pinned to an older published package (where the constant's *value* is still
 * 1) would otherwise silently shrink the importer's accept set to `{1}` and
 * reject every v2 bundle. A new value export can't fix that either — it would
 * trip scripts/check-published-symbols.ts. The `satisfies` tether keeps both
 * constants pinned to the type-level `SupportedBundleVersion` union so they
 * can't drift from the wire contract at compile time.
 */
const CURRENT_BUNDLE_VERSION = 2 satisfies SupportedBundleVersion;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates top-level bundle structure and required fields on each element. */
export function validateBundle(body: unknown): { ok: true; bundle: ExportBundle } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.manifest || typeof obj.manifest !== "object") {
    return { ok: false, error: "Missing or invalid 'manifest' field." };
  }

  const manifest = obj.manifest as Record<string, unknown>;
  if (manifest.version !== CURRENT_BUNDLE_VERSION && manifest.version !== LEGACY_BUNDLE_VERSION) {
    return { ok: false, error: `Unsupported bundle version: ${String(manifest.version)}. Expected ${LEGACY_BUNDLE_VERSION} or ${CURRENT_BUNDLE_VERSION}.` };
  }

  // v2 bundles MUST carry the #4460 sections. A producer that claims v2 but
  // drops a section indicates exporter drift — fail loudly instead of
  // silently stranding a pillar in the source region.
  if (manifest.version === CURRENT_BUNDLE_VERSION) {
    for (const section of ["dashboards", "knowledgeDocuments", "scheduledTasks", "agentSessionMemory"] as const) {
      if (!Array.isArray(obj[section])) {
        return { ok: false, error: `Missing or invalid '${section}' field. Expected an array (required for a version-${CURRENT_BUNDLE_VERSION} bundle).` };
      }
    }
  }

  if (!Array.isArray(obj.conversations)) {
    return { ok: false, error: "Missing or invalid 'conversations' field. Expected an array." };
  }
  if (!Array.isArray(obj.semanticEntities)) {
    return { ok: false, error: "Missing or invalid 'semanticEntities' field. Expected an array." };
  }
  if (!Array.isArray(obj.learnedPatterns)) {
    return { ok: false, error: "Missing or invalid 'learnedPatterns' field. Expected an array." };
  }
  if (!Array.isArray(obj.settings)) {
    return { ok: false, error: "Missing or invalid 'settings' field. Expected an array." };
  }

  // Validate required fields on each conversation element
  for (let i = 0; i < obj.conversations.length; i++) {
    const c = obj.conversations[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !Array.isArray(c.messages)) {
      return { ok: false, error: `conversations[${i}]: must have 'id' (string) and 'messages' (array).` };
    }
  }

  // Validate required fields on each semantic entity
  for (let i = 0; i < obj.semanticEntities.length; i++) {
    const e = obj.semanticEntities[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string" || typeof e.entityType !== "string" || typeof e.yamlContent !== "string") {
      return { ok: false, error: `semanticEntities[${i}]: must have 'name', 'entityType', and 'yamlContent' (strings).` };
    }
    // `connectionGroupId` is optional (#2423). When present it must be either
    // null or a non-empty string — anything else (numbers, objects, "") would
    // pass the `?? null` coalesce and reach pg as junk.
    if ("connectionGroupId" in e && e.connectionGroupId !== null && e.connectionGroupId !== undefined) {
      if (typeof e.connectionGroupId !== "string" || e.connectionGroupId.length === 0) {
        return { ok: false, error: `semanticEntities[${i}].connectionGroupId: must be a non-empty string, null, or omitted.` };
      }
    }
  }

  // Validate required fields on each learned pattern
  for (let i = 0; i < obj.learnedPatterns.length; i++) {
    const p = obj.learnedPatterns[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.patternSql !== "string") {
      return { ok: false, error: `learnedPatterns[${i}]: must have 'patternSql' (string).` };
    }
  }

  // Validate required fields on each setting
  for (let i = 0; i < obj.settings.length; i++) {
    const s = obj.settings[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || typeof s.key !== "string" || typeof s.value !== "string") {
      return { ok: false, error: `settings[${i}]: must have 'key' and 'value' (strings).` };
    }
  }

  // v2 sections (#4460) — validated whenever PRESENT, regardless of the
  // claimed version, so a mislabeled producer can never smuggle junk past
  // the shape checks (and never silently loses a present section either).
  if ("dashboards" in obj && obj.dashboards !== undefined) {
    if (!Array.isArray(obj.dashboards)) {
      return { ok: false, error: "Invalid 'dashboards' field. Expected an array." };
    }
    for (let i = 0; i < obj.dashboards.length; i++) {
      const d = obj.dashboards[i] as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || typeof d.id !== "string" || typeof d.ownerId !== "string" || typeof d.title !== "string" || !Array.isArray(d.cards) || !Array.isArray(d.drafts)) {
        return { ok: false, error: `dashboards[${i}]: must have 'id', 'ownerId', 'title' (strings), 'cards' and 'drafts' (arrays).` };
      }
      // Guard the sharing posture at the seam: `chk_dashboard_share_mode`
      // would abort the whole transaction on anything else, and coalescing an
      // absent value to "public" would silently WIDEN sharing — a security
      // posture must be stated by the producer, never defaulted permissively.
      if (d.shareMode !== "public" && d.shareMode !== "org") {
        return { ok: false, error: `dashboards[${i}].shareMode: must be 'public' or 'org'.` };
      }
      for (let j = 0; j < d.cards.length; j++) {
        const card = d.cards[j] as Record<string, unknown> | null;
        if (!card || typeof card !== "object" || typeof card.id !== "string" || typeof card.title !== "string" || typeof card.sql !== "string") {
          return { ok: false, error: `dashboards[${i}].cards[${j}]: must have 'id', 'title', and 'sql' (strings).` };
        }
      }
      for (let j = 0; j < d.drafts.length; j++) {
        const draft = d.drafts[j] as Record<string, unknown> | null;
        // `draft`/`baseline` presence mirrors the memory section's `"value" in m`
        // guard — both back NOT NULL jsonb columns, and JSON.stringify(undefined)
        // would bind NULL and abort the transaction with a raw pg 500.
        if (!draft || typeof draft !== "object" || typeof draft.userId !== "string" || typeof draft.publishedBaselineAt !== "string" || !("draft" in draft) || !("baseline" in draft)) {
          return { ok: false, error: `dashboards[${i}].drafts[${j}]: must have 'userId', 'publishedBaselineAt' (strings), 'draft', and 'baseline'.` };
        }
      }
    }
  }

  if ("knowledgeDocuments" in obj && obj.knowledgeDocuments !== undefined) {
    if (!Array.isArray(obj.knowledgeDocuments)) {
      return { ok: false, error: "Invalid 'knowledgeDocuments' field. Expected an array." };
    }
    for (let i = 0; i < obj.knowledgeDocuments.length; i++) {
      const k = obj.knowledgeDocuments[i] as Record<string, unknown> | null;
      if (!k || typeof k !== "object" || typeof k.id !== "string" || typeof k.collectionId !== "string" || typeof k.path !== "string" || typeof k.body !== "string" || !Array.isArray(k.links)) {
        return { ok: false, error: `knowledgeDocuments[${i}]: must have 'id', 'collectionId', 'path', 'body' (strings) and 'links' (array).` };
      }
      // Guard the content-mode CHECK constraint at the seam — a bad status
      // would otherwise abort the whole transaction with a pg error.
      if (k.status !== "draft" && k.status !== "published" && k.status !== "archived") {
        return { ok: false, error: `knowledgeDocuments[${i}].status: must be 'draft', 'published', or 'archived'.` };
      }
    }
  }

  if ("scheduledTasks" in obj && obj.scheduledTasks !== undefined) {
    if (!Array.isArray(obj.scheduledTasks)) {
      return { ok: false, error: "Invalid 'scheduledTasks' field. Expected an array." };
    }
    for (let i = 0; i < obj.scheduledTasks.length; i++) {
      const t = obj.scheduledTasks[i] as Record<string, unknown> | null;
      if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.ownerId !== "string" || typeof t.name !== "string" || typeof t.question !== "string" || typeof t.cronExpression !== "string") {
        return { ok: false, error: `scheduledTasks[${i}]: must have 'id', 'ownerId', 'name', 'question', and 'cronExpression' (strings).` };
      }
      // Approval posture + enabled are execution-safety fields: defaulting an
      // absent approvalMode to "auto" or an absent enabled to true would let a
      // malformed bundle run an agent task with a more permissive posture than
      // its admin configured. Require the producer to state both.
      if (typeof t.approvalMode !== "string" || t.approvalMode.length === 0) {
        return { ok: false, error: `scheduledTasks[${i}].approvalMode: must be a non-empty string.` };
      }
      if (typeof t.enabled !== "boolean") {
        return { ok: false, error: `scheduledTasks[${i}].enabled: must be a boolean.` };
      }
    }
  }

  if ("agentSessionMemory" in obj && obj.agentSessionMemory !== undefined) {
    if (!Array.isArray(obj.agentSessionMemory)) {
      return { ok: false, error: "Invalid 'agentSessionMemory' field. Expected an array." };
    }
    for (let i = 0; i < obj.agentSessionMemory.length; i++) {
      const m = obj.agentSessionMemory[i] as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || typeof m.conversationId !== "string" || typeof m.namespace !== "string" || !("value" in m)) {
        return { ok: false, error: `agentSessionMemory[${i}]: must have 'conversationId', 'namespace' (strings) and 'value'.` };
      }
    }
  }

  // Company brain (#4767, ADR-0036). Deliberately NOT added to the v2
  // required-section list above: a source region still running pre-#4767 code
  // produces a valid v2 bundle with no brain sections, and requiring them
  // would turn every mid-rollout migration into a hard failure. Optional on
  // the wire, imported whenever present.
  //
  // The shape guards below exist because the brain tables enforce their
  // invariants with CHECK/NOT NULL constraints. A malformed bundle reaching
  // the INSERT aborts the WHOLE import transaction with a raw pg error, after
  // every earlier pillar has already been written; caught here it is an
  // actionable message naming the offending array position.
  //
  // Note what these guards do NOT claim: a non-empty but malformed grant
  // (`['everyone']`) is the #4768 parser's deny+log problem, not this
  // function's. What is checked here is exactly what the DB would refuse.
  const episodeIds = new Set<string>();
  const factIds = new Set<string>();

  if ("brainEpisodes" in obj && obj.brainEpisodes !== undefined) {
    if (!Array.isArray(obj.brainEpisodes)) {
      return { ok: false, error: "Invalid 'brainEpisodes' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainEpisodes.length; i++) {
      const e = obj.brainEpisodes[i] as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.id !== "string" || typeof e.source !== "string" || typeof e.sourceId !== "string" || !Array.isArray(e.facts)) {
        return { ok: false, error: `brainEpisodes[${i}]: must have 'id', 'source', 'sourceId' (strings) and 'facts' (array).` };
      }
      // Body XOR locator — guards chk_brain_episodes_body_xor_locator. Tests
      // presence, not `typeof === "string"`: a non-string body would read as
      // "absent" here and still be bound at the INSERT, so the guard has to
      // reject the wrong TYPE rather than route around it.
      const bodyPresent = e.body !== undefined && e.body !== null;
      const locatorPresent = e.locator !== undefined && e.locator !== null;
      if (bodyPresent === locatorPresent) {
        return { ok: false, error: `brainEpisodes[${i}]: must carry exactly one of 'body' or 'locator'.` };
      }
      if (bodyPresent && (typeof e.body !== "string" || e.body.length === 0)) {
        return { ok: false, error: `brainEpisodes[${i}].body: must be a non-empty string.` };
      }
      if (locatorPresent && (typeof e.locator !== "string" || e.locator.length === 0)) {
        return { ok: false, error: `brainEpisodes[${i}].locator: must be a non-empty string.` };
      }
      const grantError = grantProblem(e.visibleTo);
      if (grantError) {
        return { ok: false, error: `brainEpisodes[${i}].visibleTo: ${grantError}` };
      }
      const tsError = missingTimestamps(e, ["ingestedAt", "createdAt"]);
      if (tsError) return { ok: false, error: `brainEpisodes[${i}].${tsError}` };
      episodeIds.add(e.id);

      for (let j = 0; j < e.facts.length; j++) {
        const f = e.facts[j] as Record<string, unknown> | null;
        const at = `brainEpisodes[${i}].facts[${j}]`;
        if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.subject !== "string" || typeof f.predicate !== "string" || typeof f.object !== "string") {
          return { ok: false, error: `${at}: must have 'id', 'subject', 'predicate', and 'object' (strings).` };
        }
        if (f.status !== "draft" && f.status !== "published" && f.status !== "archived") {
          return { ok: false, error: `${at}.status: must be 'draft', 'published', or 'archived'.` };
        }
        if (f.predicateCardinality !== "single" && f.predicateCardinality !== "multi") {
          return { ok: false, error: `${at}.predicateCardinality: must be 'single' or 'multi'.` };
        }
        const factGrantError = grantProblem(f.visibleTo);
        if (factGrantError) return { ok: false, error: `${at}.visibleTo: ${factGrantError}` };
        // Deliberately NOT `grantProblem`, which is the wrong validator here:
        // it requires at least one usable principal, and absent-or-empty is
        // legitimate for this column (#4836 — `null` means the fact was never
        // widened, `[]` means the source region could not vouch for the grant
        // and wanted the target to withhold). What must be rejected is a shape
        // Postgres would either abort the whole cutover on (`"org"` →
        // `malformed array literal`, after every earlier pillar is written) or
        // silently coerce into a real ACL value (`{}` stringifies to `{}`,
        // which parses as a legal empty `text[]`).
        if (
          f.preWideningVisibleTo !== undefined &&
          f.preWideningVisibleTo !== null &&
          (!Array.isArray(f.preWideningVisibleTo) ||
            f.preWideningVisibleTo.some((t) => t !== null && typeof t !== "string"))
        ) {
          return {
            ok: false,
            // NULL ELEMENTS are accepted on purpose, and the message says so:
            // `text[]` admits them, 0180's CHECK only requires one USABLE
            // principal, and `isVisibleTo` treats a null token as inert. A
            // maintainer who "tightened" this to reject them would refuse rows
            // Postgres legally holds and strand that workspace in its region.
            error: `${at}.preWideningVisibleTo: must be absent, null, or an array of strings (null elements allowed).`,
          };
        }
        // No-provenance-no-promotion. `{}` is rejected at rest by the table,
        // so reject it here rather than aborting the transaction on it.
        if (!f.provenance || typeof f.provenance !== "object" || Array.isArray(f.provenance) || Object.keys(f.provenance).length === 0) {
          return { ok: false, error: `${at}.provenance: must be a non-empty object (no-provenance-no-promotion).` };
        }
        const factTsError = missingTimestamps(f, ["ingestedAt", "createdAt", "updatedAt"]);
        if (factTsError) return { ok: false, error: `${at}.${factTsError}` };
        // chk_brain_facts_valid_interval — a closed interval running backwards.
        if (typeof f.validFrom === "string" && typeof f.validTo === "string" && f.validTo < f.validFrom) {
          return { ok: false, error: `${at}: 'validTo' (${f.validTo}) precedes 'validFrom' (${f.validFrom}).` };
        }
        factIds.add(f.id);
      }
    }
  }

  if ("brainEdges" in obj && obj.brainEdges !== undefined) {
    if (!Array.isArray(obj.brainEdges)) {
      return { ok: false, error: "Invalid 'brainEdges' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainEdges.length; i++) {
      const e = obj.brainEdges[i] as Record<string, unknown> | null;
      if (!e || typeof e !== "object") {
        return { ok: false, error: `brainEdges[${i}]: must be an object.` };
      }
      if (!(BRAIN_EDGE_TYPES as readonly string[]).includes(e.edgeType as string)) {
        return { ok: false, error: `brainEdges[${i}].edgeType: must be one of ${BRAIN_EDGE_TYPES.join(", ")}.` };
      }
      // A wrong-TYPED endpoint must be rejected, not counted as absent: the
      // XOR below would score `{fromFactId: "…", fromEpisodeId: 5}` as valid,
      // and the 5 would still be bound into a uuid column at the INSERT — a
      // 22P02 aborting the whole transaction at the last import step. Same
      // class as the episode body guard above.
      for (const key of ["fromFactId", "fromEpisodeId", "toFactId", "toEpisodeId"] as const) {
        const endpoint = e[key];
        if (endpoint !== undefined && endpoint !== null && typeof endpoint !== "string") {
          return { ok: false, error: `brainEdges[${i}].${key}: must be a string id or absent (a non-string endpoint aborts the import at INSERT time).` };
        }
      }
      // Exactly one endpoint per side — guards chk_brain_edges_{from,to}_endpoint.
      const fromCount = Number(typeof e.fromFactId === "string") + Number(typeof e.fromEpisodeId === "string");
      const toCount = Number(typeof e.toFactId === "string") + Number(typeof e.toEpisodeId === "string");
      if (fromCount !== 1 || toCount !== 1) {
        return { ok: false, error: `brainEdges[${i}]: each side must have exactly one endpoint ('fromFactId' XOR 'fromEpisodeId', 'toFactId' XOR 'toEpisodeId').` };
      }
      // Per-type endpoint kinds — guards chk_brain_edges_endpoint_kinds.
      if (typeof e.fromFactId !== "string") {
        return { ok: false, error: `brainEdges[${i}]: every committed edge type originates at a fact, so 'fromFactId' is required.` };
      }
      // Exhaustive on purpose: adding a fifth type to BRAIN_EDGE_TYPES and the
      // CHECK without deciding its endpoint kind here would let the importer
      // accept a shape Postgres refuses — a raw 23514 aborting the whole
      // transaction, which is the failure this whole block exists to move
      // earlier. `satisfies never` makes that a compile error instead.
      const edgeType: BrainEdgeType = e.edgeType as BrainEdgeType;
      switch (edgeType) {
        case "provenance":
          if (typeof e.toEpisodeId !== "string") {
            return { ok: false, error: `brainEdges[${i}]: a 'provenance' edge is the evidence pointer and must point at an episode ('toEpisodeId').` };
          }
          break;
        case "supersedes":
        case "in-tension-with":
          if (typeof e.toFactId !== "string") {
            return { ok: false, error: `brainEdges[${i}]: a '${edgeType}' edge compares claims and must point at a fact ('toFactId').` };
          }
          break;
        case "derives-from":
          // Fork lineage — legitimately reaches either kind.
          break;
        default:
          edgeType satisfies never;
          break;
      }
      const edgeTsError = missingTimestamps(e, ["createdAt"]);
      if (edgeTsError) return { ok: false, error: `brainEdges[${i}].${edgeTsError}` };
      // Referential pre-flight. Edges import LAST, so a dangling endpoint
      // would otherwise abort the transaction after every other pillar has
      // been written — the most expensive possible moment to discover it.
      //
      // A bundle must be self-contained: the exporter always emits the whole
      // workspace, so an endpoint the bundle doesn't carry is a malformed
      // bundle, not a reference to target-resident state. (Gating this on
      // "only check when we have some ids" would make rejection depend on
      // whether an UNRELATED section happened to be non-empty.)
      const missing = ([
        ["fromFactId", e.fromFactId, factIds],
        ["toFactId", e.toFactId, factIds],
        ["toEpisodeId", e.toEpisodeId, episodeIds],
      ] as const).find(([, id, known]) => typeof id === "string" && !known.has(id));
      if (missing) {
        return { ok: false, error: `brainEdges[${i}].${missing[0]}: '${String(missing[1])}' is not carried by this bundle.` };
      }
    }
  }

  if ("factAudienceMembers" in obj && obj.factAudienceMembers !== undefined) {
    if (!Array.isArray(obj.factAudienceMembers)) {
      return { ok: false, error: "Invalid 'factAudienceMembers' field. Expected an array." };
    }
    for (let i = 0; i < obj.factAudienceMembers.length; i++) {
      const m = obj.factAudienceMembers[i] as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || typeof m.audienceId !== "string" || typeof m.userId !== "string" || typeof m.source !== "string") {
        return { ok: false, error: `factAudienceMembers[${i}]: must have 'audienceId', 'userId', and 'source' (strings).` };
      }
      const tsError = missingTimestamps(m, ["createdAt"]);
      if (tsError) return { ok: false, error: `factAudienceMembers[${i}].${tsError}` };
    }
  }

  // The curated identity vocabulary (#5022, ADR-0037 §6/§8). `slotPosition` is
  // checked against the enum rather than merely typed: it is part of the primary
  // key, and an unrecognized value would fail the table's CHECK mid-transaction
  // and roll the WHOLE import back — a validation error naming the row is the
  // difference between "fix this edge" and "the migration failed".
  if ("brainVocabularyEdges" in obj && obj.brainVocabularyEdges !== undefined) {
    if (!Array.isArray(obj.brainVocabularyEdges)) {
      return { ok: false, error: "Invalid 'brainVocabularyEdges' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainVocabularyEdges.length; i++) {
      const e = obj.brainVocabularyEdges[i] as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.fromNorm !== "string" || typeof e.toNorm !== "string") {
        return { ok: false, error: `brainVocabularyEdges[${i}]: must have 'fromNorm' and 'toNorm' (strings).` };
      }
      if (!isSlotPosition(e.slotPosition)) {
        return { ok: false, error: `brainVocabularyEdges[${i}].slotPosition: must be one of ${SLOT_POSITIONS.join(", ")}.` };
      }
      if (e.fromNorm === "" || e.toNorm === "") {
        return { ok: false, error: `brainVocabularyEdges[${i}]: neither norm may be empty — an empty key joins every other degenerate row.` };
      }
      if (e.fromNorm === e.toNorm) {
        return { ok: false, error: `brainVocabularyEdges[${i}]: 'fromNorm' and 'toNorm' are both "${e.fromNorm}", which is a 1-cycle rather than an alias.` };
      }
      // BOTH endpoints must already be lexical norms, which also SUBSUMES the
      // post-normalization 1-cycle (`Price` → `price`): once both sides are
      // known to be norms, `lexicalNorm(a) === lexicalNorm(b)` is exactly
      // `a === b`, which the byte check above already caught. An explicit second
      // arm for it was written and then removed — mutation-testing showed no
      // input could reach it, and a rule with no failure mode is worse than
      // none, because it reads as protection.
      //
      // This is the only other
      // write path into `brain_vocabulary_edge`, and unlike `approveAliasEdge`
      // it cannot re-norm: ADR-0037 §8 has a row-copy path carry values
      // verbatim, and silently rewriting a foreign region's decision would make
      // the destination's vocabulary disagree with the keys that arrived with
      // it. So it REFUSES instead, naming the row.
      //
      // Nothing in the schema catches this — the table's CHECKs test the
      // position enum, non-empty and not-self, and a faithful SQL `lexicalNorm`
      // would be a third implementation of it. Without this arm,
      // `{fromNorm: "Priced At"}` imports "successfully" and is an alias that can
      // never fire (the `from` side is looked up by norm and would never match),
      // while `{fromNorm: "Price", toNorm: "price"}` lands a post-norm 1-cycle
      // that the not-self CHECK cannot see.
      for (const [side, raw] of [
        ["fromNorm", e.fromNorm],
        ["toNorm", e.toNorm],
      ] as const) {
        const normed = lexicalNorm(raw);
        if (normed !== raw) {
          return { ok: false, error: `brainVocabularyEdges[${i}].${side}: "${raw}" is not a lexical norm (it normalizes to "${normed}"). Alias edges store norms, not surfaces — a stored non-norm is an alias that can never match anything, and this path carries values verbatim rather than rewriting another region's decision. Re-export from a region running #5022 or later.` };
        }
      }
      // OMITTED is refused, not read as `null`. `ExportedBrainVocabularyEdge`
      // declares `approvedBy: string | null` non-optional, and this same commit
      // made `AliasEdgeInput.approvedBy` required-and-nullable for the reason
      // that applies with more force at an untrusted boundary: optional AND
      // nullable is three input states for two meanings, and the omitted one
      // would silently record an AUTO-APPROVAL on the column an audit of a
      // workspace-wide re-key reads first.
      if (!("approvedBy" in e) || (e.approvedBy !== null && typeof e.approvedBy !== "string")) {
        return { ok: false, error: `brainVocabularyEdges[${i}].approvedBy: must be present, and a string or null (null is an auto-approved edge — omitting it would silently claim one).` };
      }
      const tsError = missingTimestamps(e, ["approvedAt"]);
      if (tsError) return { ok: false, error: `brainVocabularyEdges[${i}].${tsError}` };
    }
  }

  return { ok: true, bundle: obj as unknown as ExportBundle };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ImportResultSchema = z.object({
  conversations: z.object({ imported: z.number(), skipped: z.number() }),
  semanticEntities: z.object({ imported: z.number(), skipped: z.number() }),
  learnedPatterns: z.object({ imported: z.number(), skipped: z.number() }),
  settings: z.object({ imported: z.number(), skipped: z.number() }),
  dashboards: z.object({ imported: z.number(), skipped: z.number() }),
  knowledgeDocuments: z.object({ imported: z.number(), skipped: z.number() }),
  scheduledTasks: z.object({ imported: z.number(), skipped: z.number() }),
  agentSessionMemory: z.object({ imported: z.number(), skipped: z.number() }),
  brainEpisodes: z.object({ imported: z.number(), skipped: z.number() }),
  brainFacts: z.object({ imported: z.number(), skipped: z.number() }),
  brainEdges: z.object({ imported: z.number(), skipped: z.number() }),
  factAudienceMembers: z.object({ imported: z.number(), skipped: z.number() }),
  brainVocabularyEdges: z.object({ imported: z.number(), skipped: z.number() }),
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Admin — Migration"],
  summary: "Import a migration bundle",
  description:
    "Receives an export bundle from `atlas-operator export` and imports workspace data " +
    "(conversations, semantic entities, learned patterns, settings, dashboards, " +
    "knowledge documents, scheduled tasks, agent session memory) into the " +
    "active organization. Idempotent — re-importing skips data that already exists.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            manifest: z.object({
              version: z.number(),
              exportedAt: z.string(),
              source: z.object({
                label: z.string(),
                apiUrl: z.string().optional(),
              }),
              counts: z.object({
                conversations: z.number(),
                messages: z.number(),
                semanticEntities: z.number(),
                learnedPatterns: z.number(),
                settings: z.number(),
                // v2 sections (#4460) — absent on a v1 bundle.
                dashboards: z.number().optional(),
                dashboardCards: z.number().optional(),
                dashboardUserDrafts: z.number().optional(),
                knowledgeDocuments: z.number().optional(),
                knowledgeLinks: z.number().optional(),
                scheduledTasks: z.number().optional(),
                agentSessionMemory: z.number().optional(),
                brainEpisodes: z.number().optional(),
                brainFacts: z.number().optional(),
                brainEdges: z.number().optional(),
                factAudienceMembers: z.number().optional(),
                brainVocabularyEdges: z.number().optional(),
              }),
            }),
            conversations: z.array(z.unknown()),
            semanticEntities: z.array(z.unknown()),
            learnedPatterns: z.array(z.unknown()),
            settings: z.array(z.unknown()),
            // v2 sections (#4460). Declared here so zod's strip-unknown-keys
            // behavior can't drop them before validateBundle/importBundle run.
            dashboards: z.array(z.unknown()).optional(),
            knowledgeDocuments: z.array(z.unknown()).optional(),
            scheduledTasks: z.array(z.unknown()).optional(),
            agentSessionMemory: z.array(z.unknown()).optional(),
            // Company brain (#4767). Same reason as above — an undeclared
            // section is stripped by zod before the importer ever sees it,
            // which would strand the whole brain silently.
            brainEpisodes: z.array(z.unknown()).optional(),
            brainEdges: z.array(z.unknown()).optional(),
            factAudienceMembers: z.array(z.unknown()).optional(),
            // The curated identity vocabulary (#5022). Declared for the same
            // strip-unknown-keys reason: undeclared, the whole vocabulary is
            // dropped before the importer runs and the target region keeps the
            // imported facts' keys with nothing that explains them.
            brainVocabularyEdges: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Import summary with imported/skipped counts",
      content: { "application/json": { schema: ImportResultSchema } },
    },
    400: {
      description: "Invalid bundle format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Import logic (runs inside a transaction)
// ---------------------------------------------------------------------------

export async function importBundle(
  client: InternalPoolClient,
  bundle: ExportBundle,
  orgId: string,
): Promise<ImportResult> {
  const result: ImportResult = {
    conversations: { imported: 0, skipped: 0 },
    semanticEntities: { imported: 0, skipped: 0 },
    learnedPatterns: { imported: 0, skipped: 0 },
    settings: { imported: 0, skipped: 0 },
    dashboards: { imported: 0, skipped: 0 },
    knowledgeDocuments: { imported: 0, skipped: 0 },
    scheduledTasks: { imported: 0, skipped: 0 },
    agentSessionMemory: { imported: 0, skipped: 0 },
    brainEpisodes: { imported: 0, skipped: 0 },
    brainFacts: { imported: 0, skipped: 0 },
    brainEdges: { imported: 0, skipped: 0 },
    factAudienceMembers: { imported: 0, skipped: 0 },
    brainVocabularyEdges: { imported: 0, skipped: 0 },
  };

  // --- 1. Conversations + Messages ---
  for (const conv of bundle.conversations) {
    const existing = await client.query(
      "SELECT id FROM conversations WHERE id = $1 AND org_id = $2",
      [conv.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.conversations.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO conversations (id, user_id, title, surface, connection_id, starred, created_at, updated_at, org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        conv.id,
        conv.userId,
        conv.title,
        conv.surface ?? "web",
        conv.connectionId,
        conv.starred ?? false,
        conv.createdAt,
        conv.updatedAt,
        orgId,
      ],
    );

    for (const msg of conv.messages) {
      await client.query(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [msg.id, conv.id, msg.role, JSON.stringify(msg.content), msg.createdAt],
      );
    }

    result.conversations.imported++;
  }

  // --- 2. Semantic Entities ---
  for (const entity of bundle.semanticEntities) {
    const existing = await client.query(
      "SELECT id FROM semantic_entities WHERE org_id = $1 AND entity_type = $2 AND name = $3",
      [orgId, entity.entityType, entity.name],
    );

    if (existing.rows.length > 0) {
      result.semanticEntities.skipped++;
      continue;
    }

    // `connectionGroupId` is optional on the wire — bundles from producers
    // that have no concept of the column omit the key entirely. Coalesce to
    // null so omitted and explicit-null land in the same column shape.
    await client.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, entity.entityType, entity.name, entity.yamlContent, entity.connectionGroupId ?? null],
    );
    result.semanticEntities.imported++;
  }

  // --- 3. Learned Patterns ---
  for (const pattern of bundle.learnedPatterns) {
    const existing = await client.query(
      "SELECT id FROM learned_patterns WHERE org_id = $1 AND pattern_sql = $2",
      [orgId, pattern.patternSql],
    );

    if (existing.rows.length > 0) {
      result.learnedPatterns.skipped++;
      continue;
    }

    // Preserve amendment identity across the migration (#4569, audit M9):
    // `type`/`amendment_payload`/`connection_group_id` (plus reviewer + review
    // time + seen count) round-trip so a `semantic_amendment` row lands as an
    // amendment, not an orphaned query pattern. Fields are optional on the
    // bundle (pre-#4569 exports omit them) — default to a query pattern.
    // `amendment_payload` is jsonb, so serialize the object; null stays null.
    //
    // This INSERT restoring a historical `approved` amendment is NOT a
    // violation of #4506's "the seam is the only writer of `approved`": that
    // invariant scopes *live* review decisions. Bulk migration replays an
    // already-decided row (its applied YAML travels in this same bundle's
    // `semantic_entities`), the same way a DB restore would.
    await client.query(
      `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, confidence, status, type, amendment_payload, connection_group_id, reviewed_by, reviewed_at, repetition_count, auto_promoted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        orgId,
        pattern.patternSql,
        pattern.description,
        pattern.sourceEntity,
        pattern.confidence,
        pattern.status,
        pattern.type ?? "query_pattern",
        pattern.amendmentPayload == null ? null : JSON.stringify(pattern.amendmentPayload),
        pattern.connectionGroupId ?? null,
        pattern.reviewedBy ?? null,
        pattern.reviewedAt ?? null,
        pattern.repetitionCount ?? 1,
        // Human vs machine approval road (#4571): carried so the injection
        // eligibility bypass survives migration. A human-approved pattern
        // (`false`) stays injectable regardless of confidence; a machine one
        // (`true`) stays confidence-gated. Fail closed on absence — a pre-#4571
        // bundle can't prove provenance, so default to machine/gated (`true`)
        // rather than granting an unearned bypass.
        pattern.autoPromoted ?? true,
      ],
    );
    result.learnedPatterns.imported++;
  }

  // --- 4. Settings ---
  for (const setting of bundle.settings) {
    // Skip if key already exists (don't override target workspace settings)
    const existing = await client.query(
      "SELECT key FROM settings WHERE key = $1 AND org_id = $2",
      [setting.key, orgId],
    );

    if (existing.rows.length > 0) {
      result.settings.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO settings (key, value, org_id)
       VALUES ($1, $2, $3)`,
      [setting.key, setting.value, orgId],
    );
    result.settings.imported++;
  }

  // --- 5. Dashboards (v2, #4460) — cards + per-user drafts ride inline ---
  // Original UUIDs preserved so card/draft FKs survive. Share token + expiry
  // are NOT restored (share URLs are region-bound — the owner re-mints links
  // in the target); card `cached_*` snapshots start empty and regenerate on
  // first render. `next_refresh_at` is recomputed from the schedule below —
  // the due-refresh scan requires `next_refresh_at <= now()`, so leaving it
  // NULL would silently kill auto-refresh in the target region.
  for (const dash of bundle.dashboards ?? []) {
    const existing = await client.query(
      "SELECT id FROM dashboards WHERE id = $1 AND org_id = $2",
      [dash.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.dashboards.skipped++;
      continue;
    }

    const refreshSchedule = dash.refreshSchedule ?? null;
    let nextRefreshAt: string | null = null;
    if (refreshSchedule) {
      const nextRefresh = computeNextRun(refreshSchedule);
      if (nextRefresh) {
        nextRefreshAt = nextRefresh.toISOString();
      } else {
        log.warn(
          { orgId, dashboardId: dash.id, refreshSchedule },
          "Imported dashboard has an unparseable refresh schedule — auto-refresh will not fire until the schedule is re-saved",
        );
      }
    }

    await client.query(
      `INSERT INTO dashboards (id, org_id, owner_id, title, description, share_mode, refresh_schedule, next_refresh_at, parameters, first_published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        dash.id,
        orgId,
        dash.ownerId,
        dash.title,
        dash.description ?? null,
        // Validated as 'public' | 'org' — never defaulted (a coalesce here
        // would silently widen sharing on a malformed bundle).
        dash.shareMode,
        refreshSchedule,
        nextRefreshAt,
        // JSONB columns take explicit serialization — a bare JS array would be
        // bound as a Postgres array, not jsonb.
        JSON.stringify(dash.parameters ?? []),
        dash.firstPublishedAt ?? null,
        dash.createdAt,
        dash.updatedAt,
      ],
    );

    for (const card of dash.cards) {
      await client.query(
        `INSERT INTO dashboard_cards (id, dashboard_id, position, title, sql, chart_config, content, annotations, connection_group_id, layout, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          card.id,
          dash.id,
          card.position ?? 0,
          card.title,
          card.sql ?? "",
          card.chartConfig == null ? null : JSON.stringify(card.chartConfig),
          card.content ?? null,
          JSON.stringify(card.annotations ?? []),
          card.connectionGroupId ?? null,
          card.layout == null ? null : JSON.stringify(card.layout),
          card.createdAt,
          card.updatedAt,
        ],
      );
    }

    for (const draft of dash.drafts) {
      await client.query(
        `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          draft.userId,
          dash.id,
          JSON.stringify(draft.draft),
          JSON.stringify(draft.baseline),
          draft.publishedBaselineAt,
          draft.createdAt,
          draft.updatedAt,
        ],
      );
    }

    result.dashboards.imported++;
  }

  // --- 6. Knowledge documents (v2, #4460) — link graph rides inline ---
  // Review `status` and original UUIDs preserved. The FTS vector is a
  // generated column and rebuilds on insert; sync credentials/state are
  // carve-outs (per-region ciphertext — the customer re-syncs in the target).
  for (const doc of bundle.knowledgeDocuments ?? []) {
    const existing = await client.query(
      "SELECT id FROM knowledge_documents WHERE id = $1 AND workspace_id = $2",
      [doc.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.knowledgeDocuments.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO knowledge_documents (id, workspace_id, collection_id, path, type, title, description, tags, "timestamp", resource, body, atlas_source, atlas_ingested_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        doc.id,
        orgId,
        doc.collectionId,
        doc.path,
        doc.type ?? null,
        doc.title ?? null,
        doc.description ?? null,
        JSON.stringify(doc.tags ?? []),
        doc.docTimestamp ?? null,
        doc.resource ?? null,
        doc.body,
        doc.atlasSource ?? null,
        doc.atlasIngestedAt ?? null,
        doc.status,
        doc.createdAt,
        doc.updatedAt,
      ],
    );

    for (const link of doc.links) {
      await client.query(
        `INSERT INTO knowledge_links (source_document_id, target_path, anchor_text)
         VALUES ($1, $2, $3)`,
        [doc.id, link.targetPath, link.anchorText ?? null],
      );
    }

    result.knowledgeDocuments.imported++;
  }

  // --- 7. Scheduled-task definitions (v2, #4460) ---
  // `next_run_at` is recomputed from the cron expression so the target
  // region's scheduler re-plans on its own clock (a NULL next_run_at would
  // never fire — the due-task scan requires next_run_at <= now()). Run
  // history stays behind; `connection_group_id`/`plugin_id` refs dangle
  // until the datasource/plugin is re-installed in the target.
  for (const task of bundle.scheduledTasks ?? []) {
    const existing = await client.query(
      "SELECT id FROM scheduled_tasks WHERE id = $1 AND org_id = $2",
      [task.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.scheduledTasks.skipped++;
      continue;
    }

    // null on an unparseable cron — matches create-task semantics (the task
    // exists but is not scheduled until the admin fixes the expression).
    // Logged with import context so a task that arrives dead is findable —
    // an "imported" count alone would mask exactly the stranded-pillar class
    // #4460 exists to kill.
    const nextRun = computeNextRun(task.cronExpression);
    if (!nextRun) {
      log.warn(
        { orgId, taskId: task.id, cronExpression: task.cronExpression },
        "Imported scheduled task has an unparseable cron expression — it will not fire until the expression is fixed in Admin → Scheduled Tasks",
      );
    }

    await client.query(
      `INSERT INTO scheduled_tasks (id, owner_id, org_id, name, question, cron_expression, delivery_channel, recipients, connection_group_id, approval_mode, enabled, plugin_id, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        task.id,
        task.ownerId,
        orgId,
        task.name,
        task.question,
        task.cronExpression,
        task.deliveryChannel ?? "webhook",
        JSON.stringify(task.recipients ?? []),
        task.connectionGroupId ?? null,
        // Validated non-empty / boolean — never defaulted (a permissive
        // fallback on the approval posture would bypass the admin's gate).
        task.approvalMode,
        task.enabled,
        task.pluginId ?? null,
        nextRun ? nextRun.toISOString() : null,
        task.createdAt,
        task.updatedAt,
      ],
    );

    result.scheduledTasks.imported++;
  }

  // --- 8. Durable agent session memory (v2, #4460, ADR-0020) ---
  // Runs after section 1 so the conversation FK resolves whether the
  // conversation was imported this pass or already existed (skip path).
  // `agent_runs` checkpoints are a carve-out (region-local resume leases).
  for (const memory of bundle.agentSessionMemory ?? []) {
    const existing = await client.query(
      "SELECT conversation_id FROM agent_session_memory WHERE conversation_id = $1 AND namespace = $2",
      [memory.conversationId, memory.namespace],
    );

    if (existing.rows.length > 0) {
      result.agentSessionMemory.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO agent_session_memory (conversation_id, org_id, namespace, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        memory.conversationId,
        orgId,
        memory.namespace,
        JSON.stringify(memory.value),
        memory.createdAt,
        memory.updatedAt,
      ],
    );

    result.agentSessionMemory.imported++;
  }

  // --- 9. Company brain (#4767, ADR-0036) — facts ride inside their episode ---
  // Ordering is load-bearing, and it is the reason facts are NESTED rather
  // than a sibling array: episode → its facts → (later) edges. A fact's
  // `source_episode_id` is NOT NULL, so writing facts before episodes would
  // fail the FK; writing edges before both would fail theirs.
  //
  // Everything that makes a fact trustworthy is carried verbatim — provenance,
  // grant, review status, all four temporal columns. Nothing is defaulted except the bundle-version fallback on `preWideningVisibleTo` (#4836, see below): a
  // permissive fallback here would manufacture the very rows the table's
  // CHECKs exist to refuse, and would do it while claiming a successful
  // migration.
  // bundle episode id → the id it actually resolved to in the target. Only
  // populated on the adoption path (same source record, different uuid);
  // empty in the ordinary case. Edges must be rewritten through this or they
  // reference a uuid that was never inserted, and fail their endpoint FK at
  // the very last import step.
  const adoptedEpisodes = new Map<string, string>();

  for (const episode of bundle.brainEpisodes ?? []) {
    // Two ways the target can already know this episode, and they need
    // different answers:
    //   * same UUID  — a re-import of the same bundle. Skip.
    //   * same (source, source_id) under a DIFFERENT UUID — the target's own
    //     connector ingested the same source record, which is routine after
    //     cutover. A bare INSERT would hit uq_brain_episodes_source_id and
    //     abort the ENTIRE import transaction, so adopt the existing row's id
    //     and hang this bundle's facts off it instead.
    const existing = await client.query(
      `SELECT id FROM brain_episodes
        WHERE workspace_id = $1 AND (id = $2 OR (source = $3 AND source_id = $4))
        ORDER BY (id = $2) DESC
        LIMIT 1`,
      [orgId, episode.id, episode.source, episode.sourceId],
    );
    const existingId = existing.rows[0]?.id;

    // The id facts must point at — the existing row's when one was found, so a
    // fact is never orphaned by an id the target resolved differently.
    let episodeId = episode.id;

    if (typeof existingId === "string") {
      episodeId = existingId;
      if (existingId !== episode.id) {
        // ADOPTION: the target holds this source record under a different
        // uuid. Every later reference to the bundle's id must be rewritten,
        // because that id is never inserted here — see `adoptedEpisodes`.
        adoptedEpisodes.set(episode.id, existingId);
        // Adoption keeps the TARGET's episode row, so the bundle's grant,
        // body, actor and extraction stamp are discarded. That can WIDEN
        // visibility of raw source content (tier-3 is gated precisely because
        // it is often more sensitive than the facts drawn from it), and the
        // `skipped` counter reports it identically to a benign re-import — so
        // it must not pass silently.
        log.warn(
          {
            orgId,
            bundleEpisodeId: episode.id,
            targetEpisodeId: existingId,
            source: episode.source,
            sourceId: episode.sourceId,
            bundleGrant: episode.visibleTo,
          },
          "Adopted an existing target episode under a different id — the bundle's episode row (body, grant, extractedAt) was discarded in favour of the target's",
        );
      }
      result.brainEpisodes.skipped++;
    } else {
      if (!isEpisodeSource(episode.source)) {
        // The one producer NOT gated by the episode-source vocabulary, and
        // deliberately so: a bundle written by a newer vocabulary must still
        // import, because an import is a RESTORE of evidence some other
        // region's registry already admitted, not a new class entering the
        // system (`lib/brain/sources.ts`). But the value is read downstream as
        // a discriminator — `isWarehouseDerived` refuses tier-1 correction on
        // the warehouse CLASS. An unrecognised value is refused by
        // `isEpisodeSource` first, so the predicate answers `false` without
        // ever resolving a class (asking `episodeSourceClass` directly would
        // THROW; `episodeSourceClassOf` is the total reader for stored rows).
        // So IF the unrecognised kind is warehouse-shaped, every fact derived
        // from this episode would keep a correction path ADR-0036 forbids; if
        // it is a newer chat vendor, keeping that path is correct. Nothing HERE
        // can tell which — which is why this still logs rather than refuses.
        //
        // #4964 closed that fail-open at the other end rather than this one.
        // Refusing the bundle was the alternative and it is worse: 0180 leaves
        // `source` plain `text` with no CHECK, so this route would be stricter
        // than the database is at rest — the rule `lib/brain/acl.ts`'s header
        // states for GRANTS, holding here for the same reason, and with all-or-nothing bundle validation one episode
        // from a newer region would strand the entire workspace, at cutover.
        // Instead the two gates that would ACT on an undecided tier are shut,
        // and only those: `correction.ts`'s `unrecognizedSourceKind` refuses to
        // CORRECT such a fact, and since #5033 the publish gate's tier guard
        // refuses to stamp `valid_to` on or with it
        // (`content-mode/adapters/brain-facts.ts`). The episode imports, reads
        // and searches normally. Both reopen when this region learns the kind —
        // unless it learns it as a WAREHOUSE-CLASS member, in which case the
        // refusals stay and change their reason, which is the right answer.
        //
        // Note the two columns are not the same one: that quarantine reads each
        // FACT's `provenance.source`, restored verbatim in the fact loop below
        // and never cross-checked against this episode row. They agree because
        // `reconcile.ts` copies `episode.source` into the payload — a producer
        // convention, not an invariant this route enforces — so a hand-built
        // bundle can quarantine facts this log never named, and vice versa.
        log.warn(
          { orgId, episodeId: episode.id, source: episode.source, vocabulary: EPISODE_SOURCES },
          "Imported a brain episode whose source kind is outside the vocabulary — restored verbatim by design; any fact whose OWN provenance.source carries this kind is BOTH correction-quarantined and held back from publish-time supersession until this deployment's vocabulary includes it. This route does not verify that the bundle's facts carry the same value",
        );
      }
      await client.query(
        `INSERT INTO brain_episodes (id, workspace_id, source, source_id, source_actor, body, locator, occurred_at, ingested_at, extracted_at, visible_to, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          episode.id,
          orgId,
          episode.source,
          episode.sourceId,
          episode.sourceActor ?? null,
          episode.body ?? null,
          episode.locator ?? null,
          episode.occurredAt ?? null,
          episode.ingestedAt,
          // Preserved: re-extracting in the target would re-queue episodes a
          // human has already reviewed.
          episode.extractedAt ?? null,
          episode.visibleTo,
          episode.createdAt,
        ],
      );
      result.brainEpisodes.imported++;
    }

    // Facts are deduped on their OWN key, not on their episode's. An episode
    // is immutable but its fact set GROWS — re-extraction and human
    // corrections add claims to an episode the target already has. Skipping
    // facts wholesale because their episode existed would strand every such
    // claim while reporting it as "skipped", i.e. as already present.
    for (const fact of episode.facts) {
      const existingFact = await client.query(
        "SELECT id FROM brain_facts WHERE id = $1 AND workspace_id = $2",
        [fact.id, orgId],
      );

      if (existingFact.rows.length > 0) {
        result.brainFacts.skipped++;
        continue;
      }

      await client.query(
        // `pre_widening_visible_to` travels or the target region re-opens the
        // #4836 disclosure: absent, every widened fact reads as never-widened
        // and hands its first episode's actor, channel and timestamp to the
        // whole org. It cannot be re-derived here — the import writes `status`
        // verbatim, so the fact never re-publishes and the widening UPDATE
        // that is its only writer never runs again.
        //
        // ⚠️ The three IDENTITY KEY columns (`subject_key`, `predicate_key`,
        // `object_key`) are absent from this list, and since #5020 that has a
        // consequence this INSERT is the sole producer of: an imported fact
        // lands UNKEYED, and all three slot consumers compare keys with `=` or
        // `<>`, both of which are UNKNOWN against NULL. So an imported claim
        // corroborates nothing (a re-observation forks a duplicate draft), earns
        // no `in-tension-with` edge, and can neither supersede nor be superseded
        // at the publish gate — where the will-supersede disclosure then reports
        // "nothing to supersede" without being able to say the check could not
        // run. Fail-closed, and invisible.
        //
        // #5035 is the fix and it is a CARRY, not a re-derive: ADR-0037 §8
        // settles that a row-copy path carries keys verbatim, because
        // re-deriving fails to OVER-match (irreversible) where carrying fails to
        // under-match (recoverable). That needs the v3 bundle to project them,
        // which `keys-not-on-the-wire.test.ts` forbids until §8's exception is
        // implemented — so adding the columns here ahead of #5035 is not
        // available, and migration 0188's backfill cannot cover it either (it
        // runs at boot; this runs whenever an admin triggers an import).
        `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from, valid_to, ingested_at, invalidated_at, extracted_at, source_episode_id, provenance, status, visible_to, pre_widening_visible_to, predicate_cardinality, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          fact.id,
          orgId,
          fact.subject,
          fact.predicate,
          fact.object,
          fact.validFrom ?? null,
          fact.validTo ?? null,
          fact.ingestedAt,
          fact.invalidatedAt ?? null,
          fact.extractedAt ?? null,
          episodeId,
          JSON.stringify(fact.provenance),
          fact.status,
          fact.visibleTo,
          // `?? null` is the BUNDLE-VERSION fallback, not a permissive one: a
          // pre-#4836 bundle carries no RECORDED pre-widening grants, because
          // the source region had no column to record them in. Facts widened
          // in the #4823-to-0183 window therefore land disclosing — migration
          // 0183's accepted residual, reappearing for cross-region moves.
          fact.preWideningVisibleTo ?? null,
          fact.predicateCardinality,
          fact.createdAt,
          fact.updatedAt,
        ],
      );
      result.brainFacts.imported++;
    }
  }

  // Edges LAST — an endpoint can be a fact or an episode on either side, so
  // this is the only point at which every endpoint exists. `validateBundle`
  // has already refused edges pointing at ids the bundle doesn't carry, and
  // any episode id the target resolved differently is rewritten below, so an
  // FK error here means the target lost a row mid-import: genuinely
  // exceptional, and it surfaces rather than being papered over.
  //
  // Episode endpoints go through the adoption map. Skipping this is not a
  // subtle bug: the adopted bundle id is never inserted, so a `provenance`
  // edge — the most common type, fact→episode — fails its endpoint FK and
  // rolls back the ENTIRE import, in exactly the scenario adoption exists to
  // rescue.
  const resolveEpisode = (id: string | null | undefined): string | null =>
    id == null ? null : (adoptedEpisodes.get(id) ?? id);

  for (const edge of bundle.brainEdges ?? []) {
    const endpoints = [
      edge.fromFactId ?? null,
      resolveEpisode(edge.fromEpisodeId),
      edge.toFactId ?? null,
      resolveEpisode(edge.toEpisodeId),
    ];

    const existing = await client.query(
      `SELECT id FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = $2
          AND from_fact_id IS NOT DISTINCT FROM $3
          AND from_episode_id IS NOT DISTINCT FROM $4
          AND to_fact_id IS NOT DISTINCT FROM $5
          AND to_episode_id IS NOT DISTINCT FROM $6`,
      [orgId, edge.edgeType, ...endpoints],
    );

    if (existing.rows.length > 0) {
      result.brainEdges.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, from_episode_id, to_fact_id, to_episode_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, edge.edgeType, ...endpoints, edge.createdAt],
    );

    result.brainEdges.imported++;
  }

  // Audience membership. Without it every `audience:` grant denies everyone in
  // the target region — a total loss of access that surfaces as "the brain
  // forgot everything" rather than as an error.
  for (const member of bundle.factAudienceMembers ?? []) {
    const inserted = await client.query(
      `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, audience_id, user_id) DO NOTHING`,
      [orgId, member.audienceId, member.userId, member.source, member.createdAt],
    );

    if (inserted.rowCount === 0) result.factAudienceMembers.skipped++;
    else result.factAudienceMembers.imported++;
  }

  // The curated identity vocabulary (#5022, ADR-0037 §6/§8). It travels because
  // the identity keys on every imported fact are `alias(lexicalNorm(surface))`
  // and ADR-0037 §8 carries those keys verbatim — a workspace that arrived
  // without its vocabulary would hold keys nothing in this region can explain or
  // undo.
  //
  // `ON CONFLICT DO NOTHING` on the at-most-one-parent key, which is the
  // deliberately CONSERVATIVE half of this block. An arriving edge whose
  // `fromNorm` is already approved onto something else in this region is
  // SKIPPED, never applied over the top: the destination's edge is a decision a
  // human here made, and silently retargeting it is exactly the rewrite
  // ADR-0037 §6 forbids at approval time. #5036 owns the real merge — union the
  // approved edges, refuse cycle-closing ones, log every refusal — and this
  // skip is what keeps the gap from being a corruption in the meantime.
  //
  // ⚠️ TWO residuals, recorded rather than papered over. Both need a
  // destination that ALREADY holds a vocabulary, which the ordinary migration
  // flow (a fresh region) does not produce — they are the re-import and
  // merge-into-occupied cases #5036 owns.
  //
  //   1. Skipping means an imported workspace can end up with FEWER aliases
  //      than the bundle carried, and nothing says which. Visible in the counts
  //      (`skipped > 0`) and no further; the surfacing is #5036's refusal log.
  //   2. `ON CONFLICT DO NOTHING` does not look for CYCLES, so an arriving edge
  //      can close one against a destination edge. That does not corrupt
  //      anything — the closure rebuild below refuses to commit a
  //      non-converging closure — but it aborts the ENTIRE import transaction
  //      rather than dropping the one offending edge. Loud and recoverable
  //      beats silent and not; refusing the edge instead is #5036's job, and
  //      doing it here would be implementing the merge this PR scopes out.
  //
  // ⚠️ THE LOCK IS TAKEN BEFORE THE INSERT LOOP, AND THE ORDER IS THE POINT.
  //
  // `approveAliasEdge` acquires the advisory lock FIRST and then touches rows.
  // An importer that inserts first and reaches the lock only inside
  // `recomputeEffectiveTargets` acquires the same two resources in the opposite
  // order, so two writers sharing a `from_norm` close a cycle: the approver
  // holds the advisory lock and blocks on the importer's uncommitted row, while
  // the importer blocks on the advisory lock. Postgres resolves it with `40P01
  // deadlock detected`, and the victim — sometimes the entire region import — is
  // whichever transaction it picks.
  //
  // This is recorded at length because the acquisition was REMOVED once, on the
  // reasoning that `recomputeEffectiveTargets` takes the same lock so an earlier
  // acquisition was redundant. That reasoning is wrong in the way lock-ordering
  // arguments usually are: the later lock does not block in the same PLACE, and
  // the displacement IS the bug. Measured — with the removal, an approver and an
  // import over the same norm deadlock; with it restored, they serialize and the
  // approver gets its typed `already-aliased` refusal.
  //
  // Re-taking it inside `recomputeEffectiveTargets` costs nothing:
  // `pg_advisory_xact_lock` is re-entrant within a transaction.
  const vocabularyEdges = bundle.brainVocabularyEdges ?? [];
  if (vocabularyEdges.length > 0) {
    await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, orgId]);
  }

  const vocabularyPositionsTouched = new Set<SlotPosition>();
  for (const edge of vocabularyEdges) {
    const inserted = await client.query(
      `INSERT INTO brain_vocabulary_edge
         (workspace_id, slot_position, from_norm, to_norm, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, slot_position, from_norm) DO NOTHING`,
      [orgId, edge.slotPosition, edge.fromNorm, edge.toNorm, edge.approvedBy ?? null, edge.approvedAt],
    );

    // `!== 0`, deliberately NOT `(rowCount ?? 0) !== 0`: an ABSENT `rowCount` is
    // UNKNOWN and must rebuild, while a reported `0` is a definite conflict that
    // needs none. Gating the rebuild on a `?? 0` would make it depend on the one
    // value whose absence means "did this land?" is unanswerable, and an
    // executor that omits it would then commit an edge with NO closure row —
    // precisely the half-rebuilt state `loadClaimVocabulary` refuses to load.
    //
    // The COUNTER below takes the opposite default on purpose: unknown counts as
    // skipped, because `skipped > 0` is the only signal that a curated decision
    // was dropped and a counter should under-claim rather than over-claim.
    // No `as SlotPosition` here: `validateBundle` narrowed it through
    // `isSlotPosition`, and a cast would suppress exactly the compile error that
    // drift between the wire union and `SlotPosition` should produce. That is
    // the call site `identity.ts`'s `_SlotPositionsCoverTheWire` pin names.
    if (inserted.rowCount !== 0) vocabularyPositionsTouched.add(edge.slotPosition);

    if ((inserted.rowCount ?? 0) === 0) {
      result.brainVocabularyEdges.skipped++;
      continue;
    }
    result.brainVocabularyEdges.imported++;
  }

  // The closure is RECOMPUTED, never carried — which is why the bundle has no
  // `brainVocabularyTargets` section and `brain_vocabulary_target` is classified
  // 'stays'. Restoring a source closure into a destination that already holds
  // its own vocabulary would produce a closure of neither: the source's rows
  // know nothing about the destination's edges, and the destination's know
  // nothing about the arrivals. Recomputing from the edges now present is the
  // only answer that is a closure of what this region actually approves.
  //
  // Deliberately NOT a re-derive of anything ADR-0037 §8 says must be carried.
  // §8's rule is about identity KEYS, where re-deriving fails to OVER-match (the
  // irreversible direction); this is a derived relation whose inputs are all
  // present in the same transaction, so recomputation is exact.
  for (const position of vocabularyPositionsTouched) {
    await recomputeEffectiveTargets(client, orgId, position);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminMigrate = createAdminRouter();
adminMigrate.use(requireOrgContext());

adminMigrate.openapi(importRoute, async (c) => {
  const { orgId } = c.get("orgContext");
  const requestId = c.get("requestId") as string;

  // Validate bundle structure
  const body = c.req.valid("json");
  const validation = validateBundle(body);
  if (!validation.ok) {
    return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
  }

  const { bundle } = validation;
  log.info(
    {
      requestId,
      orgId,
      source: bundle.manifest.source.label,
      counts: bundle.manifest.counts,
    },
    "Starting migration import",
  );

  // Run entire import inside a transaction for atomicity
  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Migration import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Migration import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Internal import endpoint — for cross-region migration (service-to-service)
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { createHash, timingSafeEqual } from "crypto";

/** Timing-safe string comparison — prevents timing attacks on secret values. */
function timingSafeCompare(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Internal import router — accepts ATLAS_INTERNAL_SECRET for auth instead of
 * admin session auth. Used by the migration executor to transfer workspace
 * data between regional API instances.
 *
 * POST /api/v1/internal/migrate/import
 *   Headers: X-Atlas-Internal-Token: <ATLAS_INTERNAL_SECRET>
 *   Body: { orgId: string, ...ExportBundle }
 */
export const internalMigrate = new Hono();

internalMigrate.post("/import", async (c) => {
  const requestId = crypto.randomUUID();
  const token = c.req.header("X-Atlas-Internal-Token");
  const secret = process.env.ATLAS_INTERNAL_SECRET;

  if (!secret) {
    log.error({ requestId }, "ATLAS_INTERNAL_SECRET not configured — internal import unavailable");
    return c.json({ error: "not_configured", message: "Internal import is not configured.", requestId }, 503);
  }

  if (!token || !timingSafeCompare(token, secret)) {
    log.warn({ requestId }, "Invalid internal token on cross-region import attempt");
    return c.json({ error: "unauthorized", message: "Invalid internal token.", requestId }, 401);
  }

  const body = await c.req.json() as Record<string, unknown>;
  const orgId = body.orgId;
  if (!orgId || typeof orgId !== "string") {
    return c.json({ error: "bad_request", message: "Missing 'orgId' in request body.", requestId }, 400);
  }

  // Validate the bundle (orgId is separate from bundle payload)
  const validation = validateBundle(body);
  if (!validation.ok) {
    return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
  }

  const { bundle } = validation;
  log.info(
    { requestId, orgId, source: bundle.manifest.source.label, counts: bundle.manifest.counts },
    "Starting internal cross-region import",
  );

  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Internal cross-region import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Internal import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});
