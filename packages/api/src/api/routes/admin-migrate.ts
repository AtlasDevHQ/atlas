/**
 * Admin migration import route.
 *
 * Mounted under /api/v1/admin/migrate. Receives an export bundle produced by
 * `atlas export` (via the `atlas migrate-import` CLI) and imports workspace
 * data into the active org. Idempotent — re-importing skips data that already
 * exists in the target workspace.
 */

import { createRoute, z } from "@hono/zod-openapi";
// The one spelling of the refusal item's eight fields (#5303), shared with the
// runtime screen in `lib/residency/migrate.ts`.
//
// ⚠️ A VALUE import, and NOT the hazard `VOCABULARY_REFUSAL_DETAIL_CAP` below is
// about. That one is about resolution against a PUBLISHED package — this file is
// copied into the `create-atlas` scaffold, which installs `@useatlas/types` from
// npm. `@useatlas/schemas` never publishes; `prepare-templates.sh` (step 5e)
// copies its SOURCE into every template behind a `tsconfig` path alias, so the
// scaffold gets this file and this schema from the same commit.
import { VocabularyRefusalDetailSchema } from "@useatlas/schemas";
import { createLogger } from "@atlas/api/lib/logger";
import { EPISODE_SOURCES, isEpisodeSource } from "@atlas/api/lib/brain/sources";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";
import { computeNextRun } from "@atlas/api/lib/scheduled-tasks";
import { BRAIN_EDGE_TYPES, type BrainEdgeType } from "@atlas/api/lib/brain/types";
import {
  SLOT_POSITIONS,
  UNKEYABLE_KEY_PREFIX,
  identityKey,
  isSlotPosition,
  lexicalNorm,
  slotKey,
  type ClaimVocabulary,
} from "@atlas/api/lib/brain/identity";
import { SLACK_CHANNEL_ID_PATTERN } from "@atlas/api/lib/brain/ingest/slack/config";
import {
  VOCABULARY_LOCK_NAMESPACE,
  VOCABULARY_LOCK_SQL,
  // ⚠️ The refusal-payload cap lives HERE, not in `@useatlas/types` beside the type
  // it bounds. A VALUE import from the published package resolves at runtime against
  // the version the scaffold template pins, and this file is copied into that
  // template — see the constant's own docstring for the CI failure that proved it.
  // Type imports from `@useatlas/types` are erased and therefore free.
  VOCABULARY_REFUSAL_DETAIL_CAP,
  loadClaimVocabulary,
  mergeApprovedEdges,
} from "@atlas/api/lib/brain/vocabulary";
import {
  regionPortableComparable,
  type RegionCarryOutcome,
  type RegionPortableComparable,
} from "@atlas/api/lib/brain/object-cmp";

import { normalizeEnrollmentPair } from "@atlas/api/lib/brain/enrollment";
import {
  BRAIN_ACTOR_IDENTITY_STATES,
  type BrainActorIdentityState,
} from "@atlas/api/lib/brain/actor-identity";
import { isWarehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";
import type { ExportBundle, ExportedBrainFact, ImportResult, SupportedBundleVersion } from "@useatlas/types";
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
 * The two #5113 sections' enum vocabularies, mirroring their tables' CHECKs
 * (`ck_brain_vocabulary_proposal_*`, `ck_brain_predicate_cardinality_*`) so a
 * bad value is refused at validation with a row index rather than as a 23514
 * that aborts the whole import naming no section.
 *
 * `applying` is deliberately absent from the proposal statuses: it is a
 * region-local claim token that never commits at the source (claim/apply/stamp
 * share one transaction) and must never land at a destination whose decide
 * path would believe it owns the claim.
 */
const VOCABULARY_PROPOSAL_WIRE_STATUSES = ["pending", "approved", "rejected"] as const;
const VOCABULARY_PROPOSAL_SOURCE_CLASSES = ["warehouse_key", "extractor", "seam", "human"] as const;
const PREDICATE_CARDINALITY_VALUES = ["single", "multi"] as const;
const PREDICATE_CARDINALITY_STATUSES = ["pending", "approved", "rejected"] as const;
const PREDICATE_CARDINALITY_SOURCE_CLASSES = ["warehouse_structural", "correction_event", "human"] as const;

/** A decided row — the half that outranks a `pending` in the #5113 merges. */
const isDecidedStatus = (status: string): boolean => status === "approved" || status === "rejected";

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
const CURRENT_BUNDLE_VERSION = 3 satisfies SupportedBundleVersion;

/**
 * The first version whose bundle carries the #4460 pillar sections.
 *
 * Named rather than spelled `2` at the two places that need it, because the two
 * questions "is this the version we PRODUCE?" and "is this new enough to require
 * dashboards?" stopped having the same answer the moment v3 landed. Reading the
 * required-sections gate as `=== CURRENT_BUNDLE_VERSION` would have made a v3
 * bundle exempt from the check v2 introduced — a silently stranded pillar, which
 * is the exact failure that check exists to make loud.
 */
const PILLAR_SECTIONS_FROM_VERSION = 2 satisfies SupportedBundleVersion;

/**
 * The first version whose brain facts carry their identity (#5035, ADR-0037 §8).
 *
 * THE discriminator for the importer's two key arms, and it is the manifest
 * rather than field presence on purpose. A v3 producer that dropped `subjectKey`
 * would be indistinguishable from a legacy bundle under a presence test, and the
 * legacy arm RE-DERIVES against the destination's vocabulary — the OVER-match
 * direction §8 exists to refuse, since a destination alias the source lacks
 * merges imported facts into a slot they never belonged to and publish then
 * stamps `valid_to` across the merge. Under a version test that producer fails
 * validation instead.
 */
const IDENTITY_FROM_VERSION = 3 satisfies SupportedBundleVersion;

/**
 * Every version this importer accepts, newest first for the error message.
 *
 * The set has to GROW rather than shift: older bundles stay importable, because
 * a region cutover can be triggered against a bundle exported months earlier and
 * refusing it strands that workspace where it is.
 */
const SUPPORTED_BUNDLE_VERSIONS = [
  CURRENT_BUNDLE_VERSION,
  PILLAR_SECTIONS_FROM_VERSION,
  LEGACY_BUNDLE_VERSION,
] as const satisfies readonly SupportedBundleVersion[];

/** Is this manifest version one this importer knows how to read? */
function isSupportedBundleVersion(value: unknown): value is SupportedBundleVersion {
  return (SUPPORTED_BUNDLE_VERSIONS as readonly unknown[]).includes(value);
}

/**
 * The identity a v3 fact carries — three slot keys and two comparable values.
 *
 * `satisfies readonly (keyof ExportedBrainFact)[]` is the tether, and it is
 * checked rather than derived: a field renamed in `@useatlas/types` fails to
 * compile HERE instead of quietly dropping out of the required-presence loop and
 * leaving v3 facts to import unkeyed. (Deriving the list FROM the type is what
 * would be the no-op — every member would satisfy it by construction.)
 */
const IDENTITY_FIELDS = [
  "subjectKey",
  "predicateKey",
  "objectKey",
  "subjectCmp",
  "objectCmp",
] as const satisfies readonly (keyof ExportedBrainFact)[];

/**
 * The three SLOT KEYS, which are join arms and therefore have one more rule than
 * the two comparable values: `""` is refused (see the validation loop).
 *
 * Derived from {@link IDENTITY_FIELDS} by suffix rather than re-listed, so the
 * two cannot disagree about which of the five is a key.
 */
const IDENTITY_KEY_FIELDS: readonly Extract<(typeof IDENTITY_FIELDS)[number], `${string}Key`>[] =
  Object.freeze(
    // ⚠️ A user-defined type guard's BODY is not checked by TypeScript: the
    // inverted spelling (`f.endsWith("Cmp")`) type-checks and yields an array
    // typed as the three keys while holding the two `_cmp` fields, which would
    // move the `""` gate off the three columns that need it and onto the two
    // that do not. `admin-migrate.test.ts`'s empty-key test is what pins the
    // body; the predicate only pins the type.
    IDENTITY_FIELDS.filter(
      (f): f is Extract<(typeof IDENTITY_FIELDS)[number], `${string}Key`> => f.endsWith("Key"),
    ),
  );

/**
 * …and the other direction, which the `satisfies` above cannot express.
 *
 * `satisfies` proves every member is a real field; it does not prove the list
 * COVERS the family. A sixth identity field added to `ExportedBrainFact` would
 * drop silently out of the required-presence loop and import as NULL — the
 * unkeyed state this slice exists to end, reached by adding a field.
 *
 * Keyed on the `Key`/`Cmp` naming convention the whole slice relies on, which is
 * the same rule `bundle-identity-v3.test.ts` applies to the SQL column names one
 * layer down. A type-level `never` check rather than a test, because the failure
 * belongs at the edit site: whoever adds the field sees it.
 *
 * ⚠️ **It can MISFIRE, and the obvious fix is the wrong one.** `ExportedBrainFact`
 * lives in a published package evolved by issues with nothing to do with this
 * one, so a future `dedupeKey` or `idempotencyKey` trips this pin. Adding it to
 * {@link IDENTITY_FIELDS} would make that field REQUIRED on every v3 fact and
 * REFUSED on every v1/v2 one, breaking imports from every already-deployed
 * exporter. If the new field is not identity, narrow the `Extract` — do not
 * extend the list.
 */
type _IdentityFieldsAreExhaustive =
  Exclude<
    Extract<keyof ExportedBrainFact, `${string}Key` | `${string}Cmp`>,
    (typeof IDENTITY_FIELDS)[number]
  > extends never
    ? true
    : ["identity field missing from IDENTITY_FIELDS"];
const _identityFieldsAreExhaustive: _IdentityFieldsAreExhaustive = true;
void _identityFieldsAreExhaustive;

/**
 * The accept set COVERS {@link SupportedBundleVersion}, not merely draws from it.
 *
 * `satisfies` on the array proves each member is a legal version. Without this,
 * a `4` added to the union and forgotten here makes `isSupportedBundleVersion(4)`
 * return false: fail-closed, so nothing corrupts, but a region that declares it
 * supports v4 refuses a v4 bundle and strands the workspace.
 *
 * Deliberately NOT mirrored in `packages/cli/src/commands/migrate-import.ts`.
 * That list is decoupled on purpose — a CLI built against a NEWER published
 * types package must not silently claim to read a version its own code does not
 * handle — and the asymmetry is recorded there.
 */
type _SupportedVersionsAreExhaustive =
  Exclude<SupportedBundleVersion, (typeof SUPPORTED_BUNDLE_VERSIONS)[number]> extends never
    ? true
    : ["bundle version missing from SUPPORTED_BUNDLE_VERSIONS"];
const _supportedVersionsAreExhaustive: _SupportedVersionsAreExhaustive = true;
void _supportedVersionsAreExhaustive;

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
  if (!isSupportedBundleVersion(manifest.version)) {
    return { ok: false, error: `Unsupported bundle version: ${String(manifest.version)}. Expected one of ${[...SUPPORTED_BUNDLE_VERSIONS].sort((a, b) => a - b).join(", ")}.` };
  }
  const version: SupportedBundleVersion = manifest.version;

  // v2 and later MUST carry the #4460 sections. A producer that claims one but
  // drops a section indicates exporter drift — fail loudly instead of
  // silently stranding a pillar in the source region.
  if (version >= PILLAR_SECTIONS_FROM_VERSION) {
    for (const section of ["dashboards", "knowledgeDocuments", "scheduledTasks", "agentSessionMemory"] as const) {
      if (!Array.isArray(obj[section])) {
        return { ok: false, error: `Missing or invalid '${section}' field. Expected an array (required for a version-${PILLAR_SECTIONS_FROM_VERSION}-or-later bundle).` };
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
        // `predicateCardinality` is deliberately NOT checked. v3 drops it from
        // the format (#5027 moved cardinality onto the canonical predicate and
        // the per-row values are LLM guesses), and a v1/v2 bundle that still
        // carries one is accepted and IGNORED rather than refused — refusing it
        // would strand every workspace whose bundle predates v3 in its current
        // region, for a field nothing reads. #5028 phase 2 has since DROPPED the
        // column (migration 0195), which makes accepting-and-ignoring the only
        // possible behaviour rather than a chosen one: there is nowhere left to
        // put the value even if this validator wanted it.
        //
        // The five IDENTITY fields, on the other hand, are REQUIRED from v3 and
        // must be ABSENT before it — the same loud-drift discipline the pillar
        // sections get above, at a position where silence is worse. A v3
        // producer that dropped `subjectKey` would land an unkeyed fact that
        // corroborates nothing and can neither supersede nor be superseded, and
        // the will-supersede disclosure would report "nothing to supersede"
        // without being able to say the check could not run. A v1/v2 bundle
        // carrying keys is refused because the LEGACY arm re-derives them: an
        // importer that silently preferred a carried key on a bundle whose
        // manifest says there are none has two answers for one row.
        //
        // `null` is legitimate at all five — a surface that norms away has no
        // key, permanently, and NULL is how `unknown` is spelled at a `_cmp` —
        // so this checks PRESENCE and TYPE, never truthiness.
        for (const field of IDENTITY_FIELDS) {
          // `!== undefined` rather than `field in f`, and the difference is not
          // academic: `in` reports true for an explicitly-`undefined` property,
          // so an in-process caller building a legacy bundle by spreading a
          // v3-shaped object (`{...v3fact, subjectKey: undefined}`) would be
          // refused with "a version-2 bundle carries no identity". Over the
          // wire the two coincide — `JSON.stringify` drops `undefined` — so this
          // only ever matters to a caller inside this process, which is exactly
          // the caller a confusing refusal costs the most.
          const present = f[field] !== undefined;
          // ⚠️ `""` is refused at the three SLOT KEYS, and this is not a
          // tidiness check. No honest writer produces it — `slotKey` returns
          // `null` for a surface that normalizes away and 0187's backfill maps
          // it through `NULLIF(…, '')` — and the column has no CHECK. An empty
          // key is not inert like a null one: `=` matches every OTHER empty key,
          // so a bundle carrying them puts every such fact in ONE slot, where
          // reconcile corroborates unrelated claims into a single row and the
          // publish gate stamps `valid_to` across the group. The round-1 fix
          // gated the two `_cmp` columns on exactly this argument and left the
          // three columns that feed the same join ungated.
          //
          // The `_cmp` positions are not checked here: they go through
          // `regionPortableComparable`, which refuses an empty payload and an
          // untagged value on the way in.
          // `as readonly string[]` on the ARRAY, not a downcast of `field` —
          // the house idiom two functions up (`isSupportedBundleVersion`) and in
          // `object-cmp.ts`. A downcast is accepted silently for a value that is
          // not in the set, which is the wrong direction for a habit.
          if (version >= IDENTITY_FROM_VERSION) {
            // Inside the version arm: a v1/v2 bundle carrying `""` is refused
            // one branch down for the accurate reason (it carries no identity at
            // all), and reporting the empty-key hazard there would send an
            // operator to a fix that hits the other refusal.
            if ((IDENTITY_KEY_FIELDS as readonly string[]).includes(field) && f[field] === "") {
              return { ok: false, error: `${at}.${field}: an empty string is not a key any writer can produce — a surface that normalizes away carries \`null\`, which joins nothing. An empty key joins every OTHER empty key, merging unrelated claims into one slot. Null the empty keys in the source region (\`UPDATE brain_facts SET ${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} = NULL WHERE ${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} = ''\`) and re-export.` };
            }
            if (!present || (f[field] !== null && typeof f[field] !== "string")) {
              return { ok: false, error: `${at}.${field}: must be present, and a string or null (required from bundle version ${IDENTITY_FROM_VERSION}; null is legitimate — a surface that normalizes away has no key, and a null comparable value is the 'unknown' verdict).` };
            }
          } else if (present) {
            return { ok: false, error: `${at}.${field}: a version-${String(version)} bundle carries no identity, and its facts are keyed once at import against this region's vocabulary. Re-export from a region running #5035 or later to carry keys verbatim.` };
          }
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

  // --- The company brain's Slack ingest-scope narrowings (#5203) ---
  if ("brainSlackChannelExclusions" in obj && obj.brainSlackChannelExclusions !== undefined) {
    if (!Array.isArray(obj.brainSlackChannelExclusions)) {
      return { ok: false, error: "Invalid 'brainSlackChannelExclusions' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainSlackChannelExclusions.length; i++) {
      const x = obj.brainSlackChannelExclusions[i] as Record<string, unknown> | null;
      if (!x || typeof x !== "object" || typeof x.channelId !== "string") {
        return { ok: false, error: `brainSlackChannelExclusions[${i}]: must have a 'channelId' (string).` };
      }
      // The destination's `ck_brain_slack_channel_id_shape` would refuse this
      // anyway — as a 23514 mid-transaction, aborting the whole region import
      // over one row. Refused here instead, naming the row and the rule.
      if (!SLACK_CHANNEL_ID_PATTERN.test(x.channelId)) {
        return { ok: false, error: `brainSlackChannelExclusions[${i}].channelId: "${x.channelId.slice(0, 40)}" is not a Slack channel ID — IDs start with C or G and are uppercase.` };
      }
      // OMITTED is refused, not read as "unattributed", on
      // `brainVocabularyEdges.approvedBy`'s reasoning and with more force: the
      // destination's CHECK makes an unattributed exclusion unstorable, so a
      // tolerated omission here would abort a cutover at the INSERT rather than
      // at validation. An exclusion is a confidentiality decision and its author
      // is the first thing an audit reads.
      if (typeof x.excludedBy !== "string" || x.excludedBy === "") {
        return { ok: false, error: `brainSlackChannelExclusions[${i}].excludedBy: must be a non-empty string — an exclusion records who made it.` };
      }
      if ("exclusionReason" in x && x.exclusionReason !== null && typeof x.exclusionReason !== "string") {
        return { ok: false, error: `brainSlackChannelExclusions[${i}].exclusionReason: must be a string or null.` };
      }
      const tsError = missingTimestamps(x, ["excludedAt"]);
      if (tsError) return { ok: false, error: `brainSlackChannelExclusions[${i}].${tsError}` };
    }
  }
  if ("brainSlackIngestScope" in obj && obj.brainSlackIngestScope !== undefined) {
    const scope = obj.brainSlackIngestScope as Record<string, unknown> | null;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      return { ok: false, error: "Invalid 'brainSlackIngestScope' field. Expected an object." };
    }
    if (!Array.isArray(scope.legacyChannels)) {
      // NOT defaulted to `[]`. The empty array is a REAL state ("had an install,
      // no usable scope" → ingest nothing) and an absent section is a DIFFERENT
      // real state ("never had one" → ingest everything the bot is in), so
      // coercing a malformed value into either one silently picks a scope for
      // the destination. Refuse and let the operator re-export.
      return { ok: false, error: "brainSlackIngestScope.legacyChannels: must be an array (it may be empty — that means the workspace had a slack-history install with no usable scope, which is not the same as having had none)." };
    }
    for (let i = 0; i < scope.legacyChannels.length; i++) {
      const channelId = scope.legacyChannels[i];
      if (typeof channelId !== "string" || !SLACK_CHANNEL_ID_PATTERN.test(channelId)) {
        return { ok: false, error: `brainSlackIngestScope.legacyChannels[${i}]: "${String(channelId).slice(0, 40)}" is not a Slack channel ID.` };
      }
    }
  }

  if ("brainEnrollments" in obj && obj.brainEnrollments !== undefined) {
    if (!Array.isArray(obj.brainEnrollments)) {
      return { ok: false, error: "Invalid 'brainEnrollments' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainEnrollments.length; i++) {
      const x = obj.brainEnrollments[i] as Record<string, unknown> | null;
      if (!x || typeof x !== "object") {
        return { ok: false, error: `brainEnrollments[${i}]: must be an object.` };
      }
      // ⚠️ This is the SECOND write door into `brain_enrollment`, and the
      // destination's CHECK is weaker than the application rule.
      //
      // An EMPTY half trips `ck_brain_enrollment_names_present` as a 23514
      // mid-transaction, aborting a whole cutover over one row. An UNTRIMMED one
      // is worse, because the CHECK is `entity <> ''` and `"   "` satisfies it
      // on a `text` column: the pair imports cleanly, then sits in the
      // destination's list looking live while the producer's `has()` can never
      // match it — the stored-but-unreachable row this whole surface exists to
      // prevent.
      //
      // The rules are taken FROM THE SEAM rather than restated here, and that is
      // the point rather than a shortcut. An earlier cut spelled trim and length
      // out inline; the very same commit then added a NUL check to the seam and
      // not to this arm, under a comment asserting the two doors carried one
      // rule set. Calling the seam makes that claim structural: a rule added
      // there is enforced here on the same commit, with no test to remember.
      for (const field of ["entity", "dimension"] as const) {
        const value = x[field];
        if (typeof value !== "string" || value === "") {
          return { ok: false, error: `brainEnrollments[${i}].${field}: must be a non-empty string.` };
        }
        // The ONE axis on which this door is deliberately STRICTER: it refuses
        // what the seam would repair. A bundle carrying an untrimmed pair is a
        // defect in the source region, and silently trimming it here would land
        // a pair the source does not have.
        if (value !== value.trim()) {
          return { ok: false, error: `brainEnrollments[${i}].${field}: must not have leading or trailing whitespace.` };
        }
      }
      // ⚠️ **BEFORE the seam call below, and the order is load-bearing.** That
      // call now hands this value to `normalizeEnrollmentPair`, which does
      // `.trim()` on it — so a non-string arriving here would throw a raw
      // TypeError out of the seam instead of returning the named 400 this
      // function exists to produce, and the whole cutover would abort on a
      // stack trace. The two halves above are type-checked before their own
      // seam call for the same reason.
      //
      // OPTIONAL on the wire, exactly as `naming` is and for its reason: a
      // bundle written before enrollments carried a group has none, and the flat
      // scope is that bundle's truth rather than a guess about it. A
      // present-but-wrong-typed value is refused rather than coerced, because
      // this half is part of the PRIMARY KEY — a truthiness-coerced group would
      // land the pair in a scope the source region does not have, which stores
      // cleanly and reaches nothing.
      if (
        "connectionGroupId" in x &&
        x.connectionGroupId !== undefined &&
        x.connectionGroupId !== null &&
        typeof x.connectionGroupId !== "string"
      ) {
        return { ok: false, error: `brainEnrollments[${i}].connectionGroupId: must be a string or null.` };
      }
      // The whitespace rule the two halves take, on the field that joined the
      // key beside them. Untrimmed, it is a scope the source does not have —
      // and it is refused rather than repaired, on the same axis the two halves
      // above are stricter than the seam.
      if (typeof x.connectionGroupId === "string" && x.connectionGroupId !== x.connectionGroupId.trim()) {
        return { ok: false, error: `brainEnrollments[${i}].connectionGroupId: must not have leading or trailing whitespace.` };
      }
      try {
        // ⚠️ **THE THIRD ARGUMENT IS THE POINT OF THIS CALL, and omitting it was
        // this comment's own recorded failure repeating one field later.** The
        // paragraph above says the rules are taken FROM THE SEAM so that "a rule
        // added there is enforced here on the same commit" — and #5286 added the
        // group to the seam's NUL and length checks while this call site still
        // passed two arguments. A bundle carrying `connectionGroupId: "g\u0000x"`
        // then passed validation, reached the INSERT, and Postgres raised 22021
        // MID-TRANSACTION: a whole region cutover aborted as a generic 500, for
        // input the API path answers with a named 400.
        //
        // `?? null` because the field is optional on the wire (a pre-#5286
        // bundle carries none), and `null` is that bundle's flat scope.
        normalizeEnrollmentPair(
          x.entity as string,
          x.dimension as string,
          (x.connectionGroupId ?? null) as string | null,
        );
      } catch (err) {
        // The seam's own sentence, verbatim — a second wording here would drift
        // from the rule it describes.
        return {
          ok: false,
          error: `brainEnrollments[${i}]: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // `brainSlackChannelExclusions.excludedBy`'s rule, for the same reason one
      // authority arm over: enrollment is the act that authorizes the Atlas to
      // hold claims about a pair, and an unattributed one is authority nobody
      // can be shown to have granted.
      // TRIMMED before the emptiness test, matching `enrollPair`'s
      // `params.actor.trim()`. Without it `"   "` passes here, passes
      // `ck_brain_enrollment_attributed` (`enrolled_by <> ''`), and lands stored
      // — an enrollment that looks attributed and names nobody, on the column an
      // audit of "who authorized this?" reads first. The universal the whitespace
      // rule above exists for, applied to the field one line below it.
      if (typeof x.enrolledBy !== "string" || x.enrolledBy.trim() === "") {
        return { ok: false, error: `brainEnrollments[${i}].enrolledBy: must be a non-empty string — an enrollment records who made it.` };
      }
      if ("note" in x && x.note !== null && typeof x.note !== "string") {
        return { ok: false, error: `brainEnrollments[${i}].note: must be a string or null.` };
      }
      // The ADJACENT TWIN of the line above, and it was missing (#5232's review).
      // `naming` is consumed as `(enrollment.naming ?? false) && …`, so a
      // non-boolean is truthiness-coerced into a `boolean` pg parameter — a
      // string `"false"` would name the dimension and re-key the destination's
      // corpus. Optional on the wire (a pre-#5043 v3 bundle carries none), so
      // `undefined` is admitted and `false` is that bundle's truth.
      if ("naming" in x && x.naming !== undefined && typeof x.naming !== "boolean") {
        return { ok: false, error: `brainEnrollments[${i}].naming: must be a boolean.` };
      }
      const tsError = missingTimestamps(x, ["enrolledAt"]);
      if (tsError) return { ok: false, error: `brainEnrollments[${i}].${tsError}` };
    }
  }

  if ("brainEntities" in obj && obj.brainEntities !== undefined) {
    if (!Array.isArray(obj.brainEntities)) {
      return { ok: false, error: "Invalid 'brainEntities' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainEntities.length; i++) {
      const x = obj.brainEntities[i] as Record<string, unknown> | null;
      if (!x || typeof x !== "object") {
        return { ok: false, error: `brainEntities[${i}]: must be an object.` };
      }
      for (const field of [
        "entityId",
        "entity",
        "keySurface",
        "keyNorm",
        "canonicalSurface",
        "canonicalNorm",
      ] as const) {
        const value = x[field];
        if (typeof value !== "string" || value === "") {
          return { ok: false, error: `brainEntities[${i}].${field}: must be a non-empty string.` };
        }
      }
      // ⚠️ **The id's SHAPE, and this is the field with the widest blast radius
      // in the section.** Non-empty-string was the whole check until #5232's
      // review: `entityId: "1"` validated, landed, and reached `subject_cmp`
      // through a cast — verbatim the value `WarehouseRowId`'s docstring says
      // the brand exists to forbid, arriving through the one writer the brand
      // cannot reach. A forged id there is a false `same` at the publish gate,
      // which merges two distinct entities with no inverse.
      //
      // The SHAPE and not a recomputation: the digest is taken over the
      // WORKSPACE id, and a bundle's destination org is not its source org, so
      // re-deriving would refuse every legitimate cross-region migration.
      if (!isWarehouseRowId(x.entityId)) {
        return {
          ok: false,
          error:
            `brainEntities[${i}].entityId: must be an id the warehouse producer minted ` +
            "(`wh_` followed by a sha256). This value reaches `subject_cmp`, where an id no " +
            "producer could have minted compares equal to nothing and unequal to everything.",
        };
      }
      // ⚠️ **The norms are RE-DERIVED here and COMPARED, never recomputed into
      // the row.** Recomputing would be a second application of `lexicalNorm` to
      // rows the first one already produced, and the two would agree until the
      // day the function changed — at which point the destination's store would
      // silently key differently from the facts arriving beside it on the same
      // bundle. Comparing turns that into a refused bundle, which is loud.
      //
      // It is also the one check that catches a hand-edited or downgraded
      // bundle: `entity_id` reaches `subject_cmp`, and a row whose norms do not
      // match its surfaces is a row whose id names something other than what it
      // says it names.
      for (const [surface, norm] of [
        ["keySurface", "keyNorm"],
        ["canonicalSurface", "canonicalNorm"],
      ] as const) {
        if (lexicalNorm(x[surface] as string) !== x[norm]) {
          return {
            ok: false,
            error:
              `brainEntities[${i}].${norm}: does not match lexicalNorm(${surface}). The store's ` +
              "norms are what its lookups and its vocabulary edges are made of, so a row that " +
              "disagrees with itself would resolve one surface and key another.",
          };
        }
      }
      const tsError = missingTimestamps(x, ["snapshotAt"]);
      if (tsError) return { ok: false, error: `brainEntities[${i}].${tsError}` };
    }
  }

  if ("brainActorIdentities" in obj && obj.brainActorIdentities !== undefined) {
    if (!Array.isArray(obj.brainActorIdentities)) {
      return { ok: false, error: "Invalid 'brainActorIdentities' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainActorIdentities.length; i++) {
      const x = obj.brainActorIdentities[i] as Record<string, unknown> | null;
      if (!x || typeof x !== "object") {
        return { ok: false, error: `brainActorIdentities[${i}]: must be an object.` };
      }
      for (const field of ["actor", "source", "vendorUserId", "state"] as const) {
        const value = x[field];
        if (typeof value !== "string" || value === "") {
          return {
            ok: false,
            error: `brainActorIdentities[${i}].${field}: must be a non-empty string.`,
          };
        }
      }
      // Guards `ck_brain_actor_identity_state`. Refused HERE rather than left to
      // the CHECK because a 23514 mid-import aborts the whole transaction with a
      // constraint name and no section, where this names the row and the field.
      if (!BRAIN_ACTOR_IDENTITY_STATES.includes(x.state as BrainActorIdentityState)) {
        return {
          ok: false,
          error:
            `brainActorIdentities[${i}].state: must be one of ` +
            `${BRAIN_ACTOR_IDENTITY_STATES.join(", ")}. An unrecognised state is a bundle from a ` +
            "region running a newer vocabulary; importing it would land a row every reader " +
            "degrades to `opaque` while the table reports it as resolved.",
        };
      }
      // The three-state shape, guarding the migration's four CHECKs.
      //
      // ⚠️ The ABSENCE half is checked as hard as the presence half, and that is
      // the reason this is spelled out rather than left to the database. Two
      // reasons, and the second is why it is worth the lines: a `directory` row
      // carrying a `userId` would render live-or-snapshot depending on which
      // field a reader reached for first, which is the collapse the
      // discriminated union exists to make impossible — and a row that fails
      // `ck_brain_actor_identity_*_shape` at INSERT aborts the WHOLE import
      // transaction with a 23514, a constraint name and no section, which is
      // exactly what the `state` whitelist above was added to prevent.
      const str = (v: unknown): string | null =>
        typeof v === "string" && v !== "" ? v : null;
      /** Fields that must be ABSENT for this state — the `NULL`-or-missing half. */
      const mustBeAbsent = (fields: readonly string[], why: string) => {
        for (const field of fields) {
          const value = x[field];
          if (value === null || value === undefined) continue;
          return {
            ok: false as const,
            error: `brainActorIdentities[${i}].${field}: a \`${String(x.state)}\` identity must not carry it — ${why}`,
          };
        }
        return null;
      };
      if (x.state === "atlas") {
        if (str(x.userId) === null) {
          return {
            ok: false,
            error: `brainActorIdentities[${i}].userId: an \`atlas\` identity must carry the Better Auth user id it resolves through — the name is joined live from it, so a row without one names nobody.`,
          };
        }
        const absent = mustBeAbsent(
          ["displayName", "realName", "email", "snapshotAt"],
          "its name is read LIVE from the account, and a snapshot beside a live join is one that goes stale with no re-derivation path.",
        );
        if (absent) return absent;
      } else if (x.state === "directory") {
        if (str(x.snapshotAt) === null) {
          return {
            ok: false,
            error: `brainActorIdentities[${i}].snapshotAt: a \`directory\` identity must carry the date its snapshot was taken. Undated, a stale name is asserted as current — which is the failure the date exists to prevent.`,
          };
        }
        if (
          str(x.displayName) === null &&
          str(x.realName) === null &&
          str(x.email) === null
        ) {
          return {
            ok: false,
            error: `brainActorIdentities[${i}]: a \`directory\` identity must name somebody (displayName, realName or email). A nameless one is an \`opaque\` row with extra steps, and it would render as a blank.`,
          };
        }
        const absent = mustBeAbsent(
          ["userId"],
          "a `directory` identity is one with no Atlas account, so a user id on it is a claim the state itself denies.",
        );
        if (absent) return absent;
      } else {
        const absent = mustBeAbsent(
          ["userId", "displayName", "realName", "email", "snapshotAt"],
          "`opaque` means Atlas cannot name this person, so any field that names one contradicts it.",
        );
        if (absent) return absent;
      }
      // An erasure MUST arrive as `opaque`, and MUST name who performed it.
      // A bundle carrying `erasedAt` beside a live snapshot would restore, at
      // the destination, exactly the name an operator removed at the source;
      // one carrying `erasedAt` without `erasedBy` trips
      // `ck_brain_actor_identity_erasure_shape` at INSERT and takes the whole
      // cutover with it.
      if (str(x.erasedAt) !== null) {
        if (x.state !== "opaque") {
          return {
            ok: false,
            error: `brainActorIdentities[${i}]: carries \`erasedAt\` but is not \`opaque\`. An erasure that arrives as a live identity would restore the name it removed.`,
          };
        }
        if (str(x.erasedBy) === null) {
          return {
            ok: false,
            error: `brainActorIdentities[${i}].erasedBy: an erasure must name who performed it — attribution on the erasure is what makes it answerable later.`,
          };
        }
      }
      // Both timestamps are NULLABLE here, so `missingTimestamps` (which
      // requires presence) is the wrong tool: what has to hold is that a
      // PRESENT one parses. An unparseable value would abort the import at
      // INSERT time with a Postgres message naming no section.
      for (const key of ["snapshotAt", "erasedAt"] as const) {
        const value = x[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
          return {
            ok: false,
            error: `brainActorIdentities[${i}].${key}: must be a parseable ISO-8601 timestamp or absent.`,
          };
        }
      }
    }
  }

  // --- The alias queue + its rejection memory (#5023, exported by #5113) ---
  // Every enum is checked HERE rather than left to the table's CHECKs, for the
  // section-wide reason: a 23514 mid-import aborts the whole transaction with a
  // constraint name and no section, where this names the row and the field.
  if ("brainVocabularyProposals" in obj && obj.brainVocabularyProposals !== undefined) {
    if (!Array.isArray(obj.brainVocabularyProposals)) {
      return { ok: false, error: "Invalid 'brainVocabularyProposals' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainVocabularyProposals.length; i++) {
      const p = obj.brainVocabularyProposals[i] as Record<string, unknown> | null;
      if (!p || typeof p !== "object" || typeof p.fromNorm !== "string" || typeof p.toNorm !== "string") {
        return { ok: false, error: `brainVocabularyProposals[${i}]: must have 'fromNorm' and 'toNorm' (strings).` };
      }
      if (!isSlotPosition(p.slotPosition)) {
        return { ok: false, error: `brainVocabularyProposals[${i}].slotPosition: must be one of ${SLOT_POSITIONS.join(", ")}.` };
      }
      if (p.fromNorm === "" || p.toNorm === "") {
        return { ok: false, error: `brainVocabularyProposals[${i}]: neither norm may be empty — an empty key joins every other degenerate row.` };
      }
      if (p.fromNorm === p.toNorm) {
        return { ok: false, error: `brainVocabularyProposals[${i}]: 'fromNorm' and 'toNorm' are both "${p.fromNorm}" — the table's not-self CHECK refuses it.` };
      }
      // Norm discipline, on `brainVocabularyEdges`' reasoning verbatim: the
      // proposal table stores lexical norms, this path carries values verbatim
      // rather than rewriting another region's row, and a stored non-norm is a
      // pair identity that can never match the producer's re-emission — which
      // would defeat the rejection memory the section exists to carry.
      for (const [side, raw] of [
        ["fromNorm", p.fromNorm],
        ["toNorm", p.toNorm],
      ] as const) {
        const normed = lexicalNorm(raw);
        if (normed !== raw) {
          return { ok: false, error: `brainVocabularyProposals[${i}].${side}: "${raw}" is not a lexical norm (it normalizes to "${normed}"). Re-export from a region running #5023 or later.` };
        }
      }
      if (typeof p.directed !== "boolean") {
        return { ok: false, error: `brainVocabularyProposals[${i}].directed: must be a boolean.` };
      }
      if (typeof p.sourceClass !== "string" || !VOCABULARY_PROPOSAL_SOURCE_CLASSES.includes(p.sourceClass as (typeof VOCABULARY_PROPOSAL_SOURCE_CLASSES)[number])) {
        return { ok: false, error: `brainVocabularyProposals[${i}].sourceClass: must be one of ${VOCABULARY_PROPOSAL_SOURCE_CLASSES.join(", ")}.` };
      }
      if (typeof p.confidence !== "number" || Number.isNaN(p.confidence) || p.confidence < 0 || p.confidence > 1) {
        return { ok: false, error: `brainVocabularyProposals[${i}].confidence: must be a number in [0, 1].` };
      }
      // `applying` is refused HERE even though the exporter filters it: it is a
      // claim token for a transaction in another region, and importing it would
      // land a row the destination's decide path believes it owns.
      if (typeof p.status !== "string" || !VOCABULARY_PROPOSAL_WIRE_STATUSES.includes(p.status as (typeof VOCABULARY_PROPOSAL_WIRE_STATUSES)[number])) {
        return { ok: false, error: `brainVocabularyProposals[${i}].status: must be one of ${VOCABULARY_PROPOSAL_WIRE_STATUSES.join(", ")} ('applying' is a region-local claim state and never travels).` };
      }
      if (typeof p.proposedBy !== "string" || p.proposedBy === "") {
        return { ok: false, error: `brainVocabularyProposals[${i}].proposedBy: must be a non-empty string — every proposal has an author.` };
      }
      // Present-and-nullable, on `brainVocabularyEdges.approvedBy`'s reasoning:
      // `null` MEANS "machine decision", so an omission tolerated as null would
      // silently claim one on the column an audit of a re-key reads first.
      if (!("reviewedBy" in p) || (p.reviewedBy !== null && typeof p.reviewedBy !== "string")) {
        return { ok: false, error: `brainVocabularyProposals[${i}].reviewedBy: must be present, and a string or null (null is a machine decision — omitting it would silently claim one).` };
      }
      const tsError = missingTimestamps(p, ["proposedAt"]);
      if (tsError) return { ok: false, error: `brainVocabularyProposals[${i}].${tsError}` };
      if (p.reviewedAt !== null && p.reviewedAt !== undefined) {
        if (typeof p.reviewedAt !== "string" || Number.isNaN(Date.parse(p.reviewedAt))) {
          return { ok: false, error: `brainVocabularyProposals[${i}].reviewedAt: must be a parseable ISO-8601 timestamp or null.` };
        }
      }
    }
  }

  // --- Canonical-predicate cardinality decisions (#5027, exported by #5113) ---
  if ("brainPredicateCardinalities" in obj && obj.brainPredicateCardinalities !== undefined) {
    if (!Array.isArray(obj.brainPredicateCardinalities)) {
      return { ok: false, error: "Invalid 'brainPredicateCardinalities' field. Expected an array." };
    }
    for (let i = 0; i < obj.brainPredicateCardinalities.length; i++) {
      const c = obj.brainPredicateCardinalities[i] as Record<string, unknown> | null;
      if (!c || typeof c !== "object" || typeof c.predicateKey !== "string" || c.predicateKey === "") {
        return { ok: false, error: `brainPredicateCardinalities[${i}].predicateKey: must be a non-empty string — a degenerate key would file every unkeyable predicate under one supersession license.` };
      }
      // A predicate key is `alias(lexicalNorm(surface))` and an alias target is
      // itself a norm, so a key that is not one can never match any fact's
      // `predicate_key` — a `single` entry that fires on nothing, or worse, a
      // rejected row that blocks nothing.
      {
        const normed = lexicalNorm(c.predicateKey);
        if (normed !== c.predicateKey) {
          return { ok: false, error: `brainPredicateCardinalities[${i}].predicateKey: "${c.predicateKey}" is not a lexical norm (it normalizes to "${normed}"). Cardinality entries key on canonical predicates, which are norms.` };
        }
      }
      if (typeof c.cardinality !== "string" || !PREDICATE_CARDINALITY_VALUES.includes(c.cardinality as (typeof PREDICATE_CARDINALITY_VALUES)[number])) {
        return { ok: false, error: `brainPredicateCardinalities[${i}].cardinality: must be one of ${PREDICATE_CARDINALITY_VALUES.join(", ")}.` };
      }
      if (typeof c.status !== "string" || !PREDICATE_CARDINALITY_STATUSES.includes(c.status as (typeof PREDICATE_CARDINALITY_STATUSES)[number])) {
        return { ok: false, error: `brainPredicateCardinalities[${i}].status: must be one of ${PREDICATE_CARDINALITY_STATUSES.join(", ")}.` };
      }
      if (typeof c.sourceClass !== "string" || !PREDICATE_CARDINALITY_SOURCE_CLASSES.includes(c.sourceClass as (typeof PREDICATE_CARDINALITY_SOURCE_CLASSES)[number])) {
        return { ok: false, error: `brainPredicateCardinalities[${i}].sourceClass: must be one of ${PREDICATE_CARDINALITY_SOURCE_CLASSES.join(", ")}.` };
      }
      if (typeof c.proposedBy !== "string" || c.proposedBy === "") {
        return { ok: false, error: `brainPredicateCardinalities[${i}].proposedBy: must be a non-empty string — the table's CHECK refuses an unattributed row.` };
      }
      if (!("reviewedBy" in c) || (c.reviewedBy !== null && typeof c.reviewedBy !== "string")) {
        return { ok: false, error: `brainPredicateCardinalities[${i}].reviewedBy: must be present, and a string or null (null is a machine decision — omitting it would silently claim one).` };
      }
      const tsError = missingTimestamps(c, ["proposedAt"]);
      if (tsError) return { ok: false, error: `brainPredicateCardinalities[${i}].${tsError}` };
      if (c.reviewedAt !== null && c.reviewedAt !== undefined) {
        if (typeof c.reviewedAt !== "string" || Number.isNaN(Date.parse(c.reviewedAt))) {
          return { ok: false, error: `brainPredicateCardinalities[${i}].reviewedAt: must be a parseable ISO-8601 timestamp or null.` };
        }
      }
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
  // Three counters, alone among the sections (#5036). `skipped` is the benign
  // half — an edge already approved here onto the SAME target; `refused` is a
  // source-region human decision this region dropped because it would have
  // closed a cycle or taken a second parent. `ImportResult` carries the argument
  // for why the two must not be one number.
  brainVocabularyEdges: z.object({
    imported: z.number(),
    skipped: z.number(),
    refused: z.number(),
    // The refused edges themselves (#5112). The ONE section that returns
    // payloads rather than counts, because it is the one section whose dropped
    // outcome is not re-derivable: the source region schedules the delete of its
    // own `brain_vocabulary_edge` rows, so once the grace period closes this
    // array is the last copy of N human review decisions.
    //
    // Capped by the producer at `VOCABULARY_REFUSAL_DETAIL_CAP`, so
    // `refusalDetails.length < refused` means truncated. No `truncated` flag: a
    // flag and a derivable comparison can disagree.
    //
    // ⚠️ EVERY ITEM FIELD REQUIRED, including the two nullable ones — and the reach
    // of the pin below is MEASURED, not assumed. Three experiments, run against
    // `tsgo --noEmit`:
    //
    //   - drop a required item field from this side only  → RED (pinned)
    //   - drop `.nullable()` from this side only          → RED (pinned)
    //   - add an OPTIONAL item field to this side only    → GREEN (NOT pinned)
    //
    // So the hole the pin's own comment names one level up — an optional NESTED
    // member — extends to the array ITEM's fields too, which is a second level of
    // nesting it does not mention. `.nullable()` keeps a field present-and-null and
    // is therefore pinned; `.optional()` on either spelling is pinned by nothing.
    // That is the whole reason all eight are required.
    //
    // ⚠️ REFERENCED, NOT RESTATED, since #5303. The eight fields used to be spelled
    // out here, which made this the SECOND of three copies — and the third
    // (`screenRefusalDetails` in `lib/residency/migrate.ts`, which decides what this
    // region actually persists) was coupled to neither by anything but hand. They
    // are now one definition in `@useatlas/schemas`.
    //
    // ⚠️ What closes the optional-member hole measured above is that definition's
    // KEY-SET pin, not its `satisfies` — re-measured at review, an optional ninth
    // field defeats the `satisfies` exactly as it defeats the pin below. Two
    // different pins, two different reaches; the numbers are recorded beside the
    // schema so this comment does not have to be trusted.
    refusalDetails: z
      .array(VocabularyRefusalDetailSchema)
      // ⚠️ DOCUMENTATION, NOT ENFORCEMENT, and worth having for exactly that. Nothing
      // validates a RESPONSE against this schema at runtime, so the two `.slice()`
      // calls (here and in `residency/migrate.ts`) remain the enforcement. What
      // `.max()` buys is the bound appearing in the published OpenAPI spec, where a
      // consumer can see it — otherwise the contract says `array` and the cap is
      // folklore. `z.infer` is unchanged, so the `_SchemaMatchesWireType` pin below
      // is unaffected.
      .max(VOCABULARY_REFUSAL_DETAIL_CAP),
  }),
  // Three counters for `brainVocabularyEdges`' reason, one arm over. `skipped`
  // is an exclusion this region already holds — an idempotent re-import.
  // `refused` is a source-region decision this region could not land.
  brainSlackChannelExclusions: z.object({
    imported: z.number(),
    skipped: z.number(),
    refused: z.number(),
  }),
  // TWO counters, back to the norm, and deliberately so beside the pair above
  // (#5196). An alias edge earns `refused` because two regions can hold
  // CONTRADICTORY approved decisions; an enrollment has no such conflict to have
  // — the pair is the whole key and both regions' rows are the same kind of
  // human act — so the merge is a union and `skipped` means what it means
  // everywhere else.
  // THREE counters since #5232. `namingDropped` is not a refusal in
  // `REFUSAL_ACCOUNTING`'s sense — the row landed and only its `naming` flag was
  // discarded — but it is a human decision this region declined to apply, and
  // `imported + skipped` cannot express it.
  brainEnrollments: z.object({
    imported: z.number(),
    skipped: z.number(),
    namingDropped: z.number(),
    namingApplied: z.number(),
  }),
  // TWO counters, on `brainEnrollments`' reasoning (#5043). `entity_id` is a
  // digest of `(workspace, entity, primary key)`, so two regions holding one id
  // hold one warehouse row — there is no contradictory decision to refuse.
  brainEntities: z.object({ imported: z.number(), skipped: z.number() }),
  brainActorIdentities: z.object({ imported: z.number(), skipped: z.number() }),
  // Three counters, on `brainVocabularyEdges`' reasoning (#5113): two regions
  // can hold CONTRADICTORY human decisions about one pair, so the import has an
  // outcome that is not "already here". `refused` = a decided arriving row that
  // contradicts a decided destination row — kept out, logged, never overwritten.
  brainVocabularyProposals: z.object({
    imported: z.number(),
    skipped: z.number(),
    refused: z.number(),
  }),
  // Three counters; `refused` additionally covers the re-canonicalization arm:
  // an entry whose predicate the destination's post-merge closure aliases onto
  // a different norm is refused outright rather than silently re-keyed (#5113).
  brainPredicateCardinalities: z.object({
    imported: z.number(),
    skipped: z.number(),
    refused: z.number(),
  }),
});

/**
 * Compile-time pin: the response SCHEMA and the published wire TYPE agree.
 *
 * All thirteen sections are spelled twice — once as Zod here, once as
 * `ImportResult` in `@useatlas/types` — with nothing tying them together, so the
 * OpenAPI contract this route publishes could silently stop describing what it
 * returns. #5036 had to update both by hand and nothing would have caught
 * missing one; a section added to the schema alone would document a field no
 * client receives, and one added to the type alone would return a field the
 * spec denies exists.
 *
 * Both directions, deliberately: assignability alone is satisfied by a schema
 * that dropped a field. `migrate.ts`'s `_everySectionReconciled` is the same
 * idiom two modules over, which is why this is a pin rather than a comment.
 */
/**
 * ⚠️ ITS REACH, STATED EXACTLY — because the first version of this comment
 * overclaimed in precisely the way this whole pin exists to prevent.
 *
 * The assignability pair catches a REQUIRED field added or dropped on either
 * side, nested counters included. The key-set arm adds one thing the pair cannot
 * see: an OPTIONAL top-level SECTION, since `{a} extends {a, b?}` holds in both
 * directions.
 *
 * NEITHER arm sees an optional NESTED counter — a `refused?: number` added to
 * one spelling and not the other still compiles, because the top-level key sets
 * are unchanged and assignability tolerates the optional. Declaring a counter
 * REQUIRED is what keeps it pinned, which is the reason `refused` is required on
 * `ImportResult`.
 */
// ⚠️ The two key-set directions are checked as SEPARATE nested conditions, not
// unioned. While the spellings agree both `Exclude`s are `never`, and a union of
// nevers trips `no-duplicate-type-constituents` + `no-redundant-type-constituents`
// in `lint:type-aware` — a CI-blocking gate. Nesting keeps the pin lint-clean and
// keeps each direction separately falsifiable.
type _SchemaMatchesWireType = z.infer<typeof ImportResultSchema> extends ImportResult
  ? ImportResult extends z.infer<typeof ImportResultSchema>
    ? [Exclude<keyof z.infer<typeof ImportResultSchema>, keyof ImportResult>] extends [never]
      ? [Exclude<keyof ImportResult, keyof z.infer<typeof ImportResultSchema>>] extends [never]
        ? true
        : never
      : never
    : never
  : never;
const _importResultSchemaMatchesWireType: _SchemaMatchesWireType = true;
void _importResultSchemaMatchesWireType;

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
                brainSlackChannelExclusions: z.number().optional(),
                brainEnrollments: z.number().optional(),
                brainEntities: z.number().optional(),
                brainActorIdentities: z.number().optional(),
                brainVocabularyProposals: z.number().optional(),
                brainPredicateCardinalities: z.number().optional(),
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
            brainSlackChannelExclusions: z.array(z.unknown()).optional(),
            brainSlackIngestScope: z.unknown().optional(),
            // The warehouse producer's enrolled reach (#5196, ADR-0039), and
            // the strip-unknown-keys reason bites hardest here: undeclared, the
            // whole section is dropped before the importer runs and the target
            // region's producer reaches NOTHING — silently, with a green
            // cutover, because an unenrolled workspace and a working one are
            // indistinguishable from inside the code.
            brainEnrollments: z.array(z.unknown()).optional(),
            // The entity store (#5043). Undeclared, `strip` drops the whole
            // section before the importer runs — and the destination's facts
            // land carrying `subject_cmp` values nothing can explain, with a
            // green cutover, because every lookup abstaining is the store's
            // designed behaviour.
            brainEntities: z.array(z.unknown()).optional(),
            brainActorIdentities: z.array(z.unknown()).optional(),
            // The alias queue's rejection memory + canonical-predicate
            // cardinality (#5113). Undeclared, `strip` drops both sections
            // before the importer runs — and the loss is the quiet kind these
            // sections exist to prevent: the destination's producer re-proposes
            // what a human removed, and for a warehouse-derived entity edge
            // AUTO-APPROVES it (#4507).
            brainVocabularyProposals: z.array(z.unknown()).optional(),
            brainPredicateCardinalities: z.array(z.unknown()).optional(),
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
    409: {
      description:
        "Bundle refused — a fact has no identity key at a position whose surface normalizes to a " +
        "real one, so landing it would either retire a healthy belief or re-derive its key under " +
        "this region's vocabulary, and neither is reversible (#5047). NOTHING WAS WRITTEN. Two " +
        "causes with two different remedies, and the `message` says which: on a v3 bundle the key " +
        "was supposed to travel and did not — re-export from the source region, checking it for " +
        "identity drift and that it has applied migration 0194 — while on a v1/v2 bundle the key " +
        "is computed at import, so a refusal means THIS region's vocabulary maps that norm away " +
        "and the fix is a local `brain_vocabulary_target` entry, which re-exporting cannot change. " +
        "NOTHING WAS WRITTEN is a claim about the ROLLBACK, so a refusal whose rollback ALSO " +
        "failed is reported as `import_rollback_uncertain` (500) instead of this status — this " +
        "409 is only returned when the rollback is known to have completed.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description:
        "Import failed. TWO codes, and they mean opposite things for a retry. `import_failed`: the " +
        "transaction rolled back, nothing was written, and re-sending the same bundle is safe once " +
        "the cause is resolved. `import_rollback_uncertain`: the ROLLBACK itself did not complete, " +
        "so whether any of it committed is UNKNOWN — do NOT re-send; inspect the destination " +
        "workspace first, because a retry over a partially-committed import can duplicate or " +
        "interleave rows (the connection is discarded rather than pooled). In both cases the " +
        "`message` is deliberately GENERIC and the `requestId` is the handle: the underlying " +
        "driver error is recorded server-side against that id and is not echoed here, because a " +
        "`pg` message routinely embeds row content, constraint and column names, and — on a " +
        "connection failure — the internal host and port (#5106).",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

/**
 * The 500 body's entire `message` — the driver's own text NEVER reaches it (#5106).
 *
 * A `pg` error message is not a description of what went wrong, it is a fragment
 * of the database: `duplicate key value violates unique constraint "…" Key
 * (id)=(…)` carries ROW CONTENT, every constraint violation names internal
 * constraint and column spellings, and a connection failure carries the internal
 * host and port. CLAUDE.md § Product invariants: *never expose connection
 * strings, API keys, or stack traces to the user or agent.*
 *
 * ⚠️ THE DETAIL IS NOT DROPPED, it is MOVED. The `log.error` at each call site
 * records the real error — as an `Error` instance, so pino's `err` serializer
 * keeps the message AND the stack — beside the same `requestId` this body
 * carries. That pairing is the whole design: the operator loses nothing and the
 * caller learns nothing they should not. A fix that scrubbed the response and
 * also stopped logging would close the leak by destroying the evidence, which is
 * the failure this note exists to prevent.
 *
 * ⚠️ NOT routed through `audit/error-scrub.ts`'s `errorMessage`. That helper is
 * for `admin_action_log.metadata` — a JSONB column compliance reviewers read —
 * and its own docstring carves out an `Error` instance handed to pino, whose
 * `err` serializer preserves the message and the stack. Scrubbing userinfo out of a
 * message that is not going to a caller at all would only cost the operator
 * detail.
 *
 * ONE constant, read by BOTH handlers. The admin route and the internal
 * service-to-service route are copies of each other, and #5106 exists because a
 * leak lived in both; a second string literal is how the next fix reaches one and
 * misses the other. EXPORTED for a third reader: the route test anchors
 * `expect(body.message).not.toBe(IMPORT_FAILED_MESSAGE)` on it, after a
 * hand-typed lowercase substring made that assertion silently inert.
 */
export const IMPORT_FAILED_MESSAGE =
  "Import failed — all changes rolled back, so nothing was written and the source region is " +
  "unchanged. The failure detail is recorded server-side against this response's `requestId`; " +
  "quote it when reporting this. Re-sending the same bundle is safe once the cause is resolved.";

/**
 * The 500 body when the ROLLBACK ITSELF failed AND a transaction was open — a
 * state the handler cannot describe with {@link IMPORT_FAILED_MESSAGE} (#5106
 * round 2). The `begun` half of that gate is load-bearing, not redundant: a
 * BEGIN that never resolved leaves nothing to be uncertain about.
 *
 * That message promises *"nothing was written … re-sending the same bundle is
 * safe"*. On this path the process has established neither. It issued a
 * `ROLLBACK` and the request failed, so whether the transaction aborted, is
 * still open, or committed is unknown to it. Returning the confident sentence
 * here would be a claim about a state nobody observed — the same defect #5106
 * fixed one layer up, where the 500 asserted things it had read off a driver
 * error rather than established.
 *
 * ⚠️ A DISTINCT `error` CODE, not just distinct prose — so that a caller CAN
 * branch, which is not the same as saying one does. Stated precisely because an
 * earlier cut of this line claimed `lib/residency/migrate.ts` branches on it and
 * that is false: `transferBundleToTarget` flattens the body to
 * `body.message ?? body.error` and returns one opaque string, so today the
 * warning reaches a human as PROSE and the code has no machine reader. A
 * comment asserting a consumer that does not exist is how the next maintainer
 * concludes the hazard is already handled.
 *
 * The gap is real and is left as a follow-up rather than widened here:
 * `resetMigrationForRetry` gates on `status`/`region_updated` alone, so the
 * retry affordance will happily re-send the identical bundle — which is what
 * this message forbids. Making it refuse an uncertain migration is new
 * machinery across a second module.
 *
 * Same 500 status, because the request was well-formed and the fault is ours.
 *
 * The remedy is deliberately concrete: the destination workspace has to be
 * inspected, because the honest answer to *did anything land?* is that nobody
 * knows. The connection is destroyed rather than pooled at the same time, which
 * is what stops the uncertainty spreading to the next borrower.
 */
const IMPORT_ROLLBACK_UNCERTAIN_MESSAGE =
  "Import failed AND the rollback did not complete — whether any of it committed is UNKNOWN. Do " +
  "NOT re-send this bundle: inspect the destination workspace first, because a retry over a " +
  "partially-committed import can duplicate or interleave rows. The connection has been " +
  "discarded rather than returned to the pool. Both failures are recorded server-side against " +
  "this response's `requestId`; quote it when reporting this.";

// ---------------------------------------------------------------------------
// Import logic (runs inside a transaction)
// ---------------------------------------------------------------------------

/**
 * Where an imported fact's identity comes from — carried, or computed here.
 *
 * The union makes ONE pairing structural: `carried: false` cannot exist without
 * the vocabulary the legacy arm keys against, so no load that silently produced
 * nothing can key a whole corpus against the identity function.
 *
 * ⚠️ Two things it does NOT enforce, stated because the first version of this
 * docstring claimed the first of them (#5035, panel round 1):
 *
 *   - **It does not stop an EXPLICIT fallback.** `ClaimVocabulary` is
 *     structural, and `identityVocabulary` satisfies the field — which is
 *     exactly the substitution `bundle-identity.mutations.ts` performs to
 *     measure the section reorder. Only the accident is closed, not the
 *     decision.
 *   - **It does not tie `carried: true` to a v3 manifest.** A LEGACY bundle
 *     carrying no facts takes that arm, deliberately: keying nothing needs no
 *     vocabulary, and loading one would fail the import over a destination
 *     vocabulary the bundle never touches. The arm is vacuous there — no fact
 *     reaches {@link importedIdentity} — rather than wrong.
 */
type IdentitySource =
  | { readonly carried: true }
  | { readonly carried: false; readonly vocabulary: ClaimVocabulary };

/**
 * Is this carry outcome a LOSS — something worth recomputing?
 *
 * `comparableDropped`'s classifier. The operator counters DO NOT call it — they
 * are their own four-arm `switch`, because they need to tell `store-local` from
 * `unreadable` where this only needs "is it a loss". Both have a `never`
 * default, which is what matters: a fifth {@link RegionCarryOutcome} reason
 * would otherwise fall out of BOTH silently — the row unmarked and the operator
 * untold, two fail-open drops from one added union member.
 *
 * `absent` is deliberately NOT a loss. Nothing arrived, so nothing was
 * discarded, and marking it would make `provisional` mean *"was imported"*
 * rather than *"is worth recomputing"* — the meaning #4772's review filter
 * reads.
 */
function isLoss(reason: RegionCarryOutcome["reason"]): boolean {
  switch (reason) {
    case "store-local":
    case "unreadable":
      return true;
    case "carried":
    case "absent":
      return false;
    default: {
      const exhaustive: never = reason;
      throw new Error(`isLoss: unhandled carry reason ${String(exhaustive)}`);
    }
  }
}

/** The identity columns an imported fact lands with (#5035). */
interface ImportedIdentity {
  /**
   * NON-NULL since #5047 — `brain_facts`' three key columns are `NOT NULL` as of
   * migration 0194, and this is the second key writer, so the type is what keeps
   * that true here rather than a `23502` on the first offending row of an
   * admin-triggered region import (ADR-0024, a production path).
   *
   * A null at any position is landed by {@link tombstonePlaceholder}, which is
   * 0194's own policy for the same state. The type narrows AFTER that call and
   * nowhere before it, so the two arms of {@link importedIdentity} cannot
   * accidentally skip it.
   */
  readonly subjectKey: string;
  readonly predicateKey: string;
  readonly objectKey: string;
  /**
   * A key was replaced by a placeholder, so the row lands TOMBSTONED (#5047).
   *
   * Read at the INSERT, where it is `OR`ed into `invalidated_at`. Separate from
   * {@link unkeyable} / {@link nullKeys} on purpose: those two are OPERATOR
   * counters that say WHY the key was absent (computed here vs. arrived null),
   * and this one says what the row DID about it. Collapsing them would make the
   * import's log line and its write disagree the first time a fourth cause
   * appears.
   */
  readonly tombstoned: boolean;
  /**
   * ⚠️ {@link RegionPortableComparable}, NOT `string | null` and not the wider
   * `ComparableValue`, and the narrowing is the whole guarantee this slice
   * produces (#5035, panel rounds 1 and 3).
   *
   * `regionPortableComparable` is the only function that may decide what lands
   * in `subject_cmp`/`object_cmp`. Under a `string | null` field the line
   * `subjectCmp: fact.subjectCmp ?? null` compiles — a one-token copy-paste
   * from the three key lines directly above it in the same object literal — and
   * reintroduces the verbatim `entity:` carry, which is the autonomous
   * `valid_to` stamp ADR-0037 §8 exists to prevent. Under this type it does
   * not: `string` is not assignable to `` `${ComparableTag}:${string}` ``.
   *
   * This is #5032's lesson at the destination rather than the parameter: a
   * branded input stops the wrong CALL, and only a narrowed output stops the
   * caller who skips the function altogether. ⚠️ And `ComparableValue` alone was
   * NOT enough — round 3 measured seven cast-free spellings that still satisfied
   * it (`entityComparable(x)`, `comparableValue({…})`, a bare `"entity:01J…"`
   * literal, …), all legitimate producers for other destinations. Shape is
   * forgeable; the brand is a provenance claim and is not.
   */
  readonly subjectCmp: RegionPortableComparable;
  readonly objectCmp: RegionPortableComparable;
  /** A non-null comparable value was discarded, so the row is `provisional`. */
  readonly comparableDropped: boolean;
  /**
   * Why each position's value was dropped, for the caller's aggregate warn.
   * `unreadable` is the one that is not the rule working — see
   * {@link RegionCarryOutcome}.
   */
  readonly carryReasons: readonly RegionCarryOutcome["reason"][];
  /** A key this import COMPUTED came out null — the surface norms away. */
  readonly unkeyable: boolean;
  /**
   * A key this import CARRIED arrived null AND that position's surface
   * normalizes away — the only carried null that still LANDS, since #5047 makes
   * the repairable kind refuse the bundle. The cause is the claim's own text,
   * not the source region's.
   */
  readonly nullKeys: boolean;
}

/**
 * ADR-0037 §8's import rule, in one place.
 *
 * ## The keys: carried on v3, computed once below it
 *
 * **v3 carries them verbatim.** The failure directions decide this, not a
 * preference between two reasonable options:
 *
 * | | Divergence | Failure | Recoverable? |
 * |---|---|---|---|
 * | carry | the source has an alias this region lacks | the imported row keys `priced at` while a local row keys `is priced at` → they never collide | **yes** — under-match, #5000 at a region boundary |
 * | re-derive | this region has an alias the source lacks, possibly a bad one | imported facts merge into a slot they never belonged to, and publish stamps `valid_to` across the merge | **no** |
 *
 * The importer also has no re-derive precedent to point at: every other
 * `brain_facts` column travels verbatim, `status` included — which is exactly
 * what makes a derived column un-re-derivable here, since the fact never
 * re-publishes in this region and the UPDATEs that derive things never run
 * again.
 *
 * **v1/v2 carry none, so they are keyed ONCE, here.** Not left NULL: an unkeyed
 * fact corroborates nothing, earns no `in-tension-with` edge, and can neither
 * supersede nor be superseded — fail-closed and invisible, which is the state
 * this slice exists to end, and the slot keys are heading for `NOT NULL`
 * besides. This is the SECOND key writer in the tree (`INSERT_FACT_SQL` is the
 * first), and #5019's *"`NOT NULL` is affordable because `alias` is identity on
 * day one"* does not hold at a path that runs years later — which is why the
 * vocabulary it reads is the destination's POST-MERGE one, and why the
 * vocabulary block now runs before the brain.
 *
 * ## The `_cmp` columns: entity-tagged values are DROPPED, at both positions
 *
 * `regionPortableComparable` owns the rule and argues it at length. The short
 * version: a store-local id is non-null and, by construction, unequal to every
 * id this region mints for the same real entity, so at `object_cmp` it is
 * counterfeit positive evidence of DIFFERENCE and buys an autonomous `valid_to`
 * stamp on the one write ADR-0036 reserves for a human. Value-typed tags
 * (money, number, date, time, bool) are region-invariant parses and travel.
 *
 * {@link ImportedIdentity.comparableDropped} is TRUE only when a NON-NULL value
 * was actually discarded. A fact that arrived NULL at both positions has nothing
 * to recompute and is not marked: marking it would make `provisional` mean *"was
 * imported"* rather than *"is worth recomputing"*, and #4772's review filter
 * reads it as the latter.
 */
/**
 * Raised when a bundle carries no identity for a fact whose SURFACE has one
 * (#5047). Refuses the import rather than landing the row.
 *
 * See {@link tombstonePlaceholder} for why this case and the degenerate-surface
 * case cannot take the same treatment.
 */
export class RegionImportUnkeyableError extends Error {
  constructor(
    readonly factId: string,
    readonly positions: readonly string[],
  ) {
    super(
      `Region import refused: fact ${factId} arrived with no identity key at ${positions.join(", ")}, ` +
        "but its surface at those positions normalizes to a real key — so the bundle is missing " +
        "identity the source region has. Landing it would either invalidate a healthy belief " +
        "(tombstone) or re-derive its key under THIS region's vocabulary, which can merge it into a " +
        "slot it never belonged to and stamp `valid_to` across the merge at publish. Neither is " +
        "reversible. Check the source region's export for identity drift — a projection that stopped " +
        "returning the key columns exports null for every fact — and that the source region has " +
        "applied migration 0194, whose backfill keys exactly these rows. Then re-export and re-run.",
    );
    this.name = "RegionImportUnkeyableError";
  }
}

/**
 * Raised when a LEGACY (v1/v2) bundle's fact keys to nothing because THIS
 * region's vocabulary maps its norm away (#5047).
 *
 * Split from {@link RegionImportUnkeyableError} because the two name different
 * subsystems, different regions and different remedies, and a shared message
 * sends the operator somewhere they can do nothing. A v1/v2 bundle carries no
 * key columns at all, so "re-export from the source" is unfollowable advice for
 * this cause — the defect is a local alias entry.
 *
 * Reachable only through a hand-written or imported `brain_vocabulary_target`
 * row: `vocabulary-decide.ts` refuses a `degenerate-norm` target at authoring
 * and `validateBundle` refuses a non-norm edge at import. Raised anyway rather
 * than assumed unreachable, for the reason `REKEY_DRIFTED_FACTS_SQL`'s own
 * `IS NOT NULL` arm gives: testing the composed expression is what keeps this
 * correct if that guard ever reopens, and the failure mode here is a permanent
 * 409 on a whole tenant migration.
 */
export class RegionImportVocabularyTargetError extends Error {
  constructor(
    readonly factId: string,
    readonly positions: readonly string[],
  ) {
    super(
      `Region import refused: fact ${factId} could not be keyed at ${positions.join(", ")} — its ` +
        "surface normalizes to a real key, but THIS region's vocabulary maps that norm to " +
        "something that normalizes away, so the fact would have no identity. This is a " +
        "destination-side configuration defect and re-exporting will not change it: inspect this " +
        "workspace's `brain_vocabulary_target` rows for the positions named above, remove or " +
        "correct the offending alias entry, then re-run the import.",
    );
    this.name = "RegionImportVocabularyTargetError";
  }
}

/**
 * The `NOT NULL` landing for a key this import could not supply (#5047).
 *
 * `brain_facts`' key columns are `NOT NULL` since migration 0194, so this writer
 * can no longer pass a null through. What it does instead depends on WHY the key
 * is absent, and the two causes are not the same event.
 *
 * ## The surface normalizes away → TOMBSTONE with a per-row placeholder
 *
 * The claim asserts nothing at that position and never could: no vocabulary, no
 * re-key, and no source region can produce a key for `-` or `___`. This is
 * exactly migration 0194's population, and this is 0194's treatment of it, so the
 * two key writers agree about one state.
 *
 * The tombstone is the load-bearing half. All three slot consumers require
 * `invalidated_at IS NULL`, so the row is outside every join by the tombstone
 * rather than by its key — which is where a NULL key left it before the
 * constraint. The placeholder is per-row ({@link UNKEYABLE_KEY_PREFIX}), which is
 * what separates it from the shared sentinel 0187's header rejects.
 *
 * ## The surface has a key but none arrived → REFUSE the import
 *
 * ⚠️ **This arm exists because the first one is WRONG for this case, and getting
 * that wrong is how a recoverable state becomes an unrecoverable one.**
 *
 * Such a row is repairable: its surface keys perfectly well, so
 * `REKEY_DRIFTED_FACTS_SQL` computes a real key for it at the next alias decision
 * and it rejoins every consumer. Before #5047 it landed live-but-unjoined, which
 * is ADR-0037 §8's accepted under-match. Tombstoning it instead retires a healthy
 * belief, and NOTHING in the product clears `invalidated_at` — the re-key would
 * repair the key while the row stayed invisible forever.
 *
 * Computing the key here is the other tempting repair and is worse. §8 settles
 * that a row-copy path never re-derives, because re-deriving under the
 * DESTINATION's vocabulary can merge imported facts into a slot they never
 * belonged to, and publish then stamps `valid_to` across the merge — the
 * irreversible direction.
 *
 * So neither landing is safe, and the honest move is not to land. WHICH
 * subsystem to blame depends on the arm, and the two are not interchangeable:
 *
 *   - CARRIED (v3): the key was supposed to travel and did not. Source-side —
 *     export drift that nulls the column for the whole corpus is the documented
 *     shape, or a source region that has not yet applied 0194. Fixed at the
 *     source and re-run. {@link RegionImportUnkeyableError}.
 *   - COMPUTED (v1/v2): the key was derived HERE, so a null means this region's
 *     own vocabulary maps a real norm to something that normalizes away.
 *     Destination-side, fixed in `brain_vocabulary_target`, and re-exporting
 *     cannot change it. {@link RegionImportVocabularyTargetError}.
 *
 * Refusing is the only outcome here that writes nothing.
 *
 * That a single such row refuses a whole region migration is deliberate: at this
 * position it is not "one odd claim" but evidence that the bundle's identity is
 * not trustworthy, and the alternative is committing an invalidation no verb can
 * undo. A genuinely degenerate row — the far commoner case — takes the first arm
 * and does not block anything.
 */
function tombstonePlaceholder(
  fact: ExportedBrainFact,
  source: IdentitySource,
  keys: {
    readonly subjectKey: string | null;
    readonly predicateKey: string | null;
    readonly objectKey: string | null;
  },
): Pick<ImportedIdentity, "subjectKey" | "predicateKey" | "objectKey" | "tombstoned"> {
  // Decided per POSITION off that position's own surface, never off the row: a
  // fact can be degenerate at the object and healthy at the subject, and the two
  // positions then want opposite answers.
  const absent = (
    [
      ["subject", keys.subjectKey, fact.subject],
      ["predicate", keys.predicateKey, fact.predicate],
      ["object", keys.objectKey, fact.object],
    ] as const
  ).filter(([, key]) => key === null);
  const repairable = absent.filter(([, , surface]) => identityKey(surface) !== null);
  if (repairable.length > 0) {
    // ⚠️ WHICH SUBSYSTEM IS AT FAULT DEPENDS ON WHICH ARM CALLED, and the first
    // cut raised the source-region error from both — so a v1/v2 bundle, which
    // carries no key columns on the wire AT ALL, told the operator to "re-export
    // from the source region and check it has applied 0194". Re-exporting cannot
    // change anything on that arm, and 0194 at the source is irrelevant: the
    // whole migration wedges behind an instruction nobody can follow.
    //
    // On the CARRIED arm a repairable null means the key was supposed to arrive
    // and did not — source-side. On the COMPUTED arm the key was derived right
    // here by `slotKey(surface, vocabulary[position])`, and `slotKey` reaches
    // null a second way: this region's own alias entry maps a real norm to
    // something that normalizes away. That is a destination-side configuration
    // defect and names a different table, a different region, and a different
    // remedy.
    const positions = repairable.map(([position]) => position);
    throw source.carried
      ? new RegionImportUnkeyableError(fact.id, positions)
      : new RegionImportVocabularyTargetError(fact.id, positions);
  }
  const placeholder = `${UNKEYABLE_KEY_PREFIX}${fact.id}`;
  return {
    subjectKey: keys.subjectKey ?? placeholder,
    predicateKey: keys.predicateKey ?? placeholder,
    objectKey: keys.objectKey ?? placeholder,
    tombstoned: absent.length > 0,
  };
}

/**
 * Whether a bundle fact's provenance NAMES A PERSON (#5424).
 *
 * ## Why this is the whole test, and why it is not stricter
 *
 * Finish condition 2 asks for three things — a person, a source, and a date.
 * Only the person needs checking here, because the other two cannot go missing:
 * `source_episode_id` is NOT NULL with a composite FK, so the evidence row is
 * always reachable, and that row's `ingested_at` is NOT NULL, so a date always
 * exists. `provenance.occurredAt` is legitimately null — `reconcile.ts` writes
 * null when the source exposed no event time — so requiring it would refuse
 * rows the product itself produces.
 *
 * `actor` is different: `classifyEpisodeForReconcile` REFUSES an episode whose
 * principal cannot be resolved (`SOURCE_PRINCIPAL_UNRESOLVED`), so no fact this
 * product wrote can carry a blank one. A bundle fact that does is either
 * hand-built or from a corpus that predates the gate.
 *
 * TRIMMED before the emptiness test, for `brainEnrollments[].enrolledBy`'s
 * reason one section over: `"   "` is a name nobody can be shown to have, and
 * it passes every bare truthiness check.
 */
function bundleFactNamesAPerson(fact: ExportedBrainFact): boolean {
  const provenance = fact.provenance;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    return false;
  }
  const actor = (provenance as Record<string, unknown>).actor;
  return typeof actor === "string" && actor.trim() !== "";
}

function importedIdentity(fact: ExportedBrainFact, source: IdentitySource): ImportedIdentity {
  if (!source.carried) {
    // A pre-#5035 bundle has no `_cmp` on the wire at all, so there is nothing
    // to drop and nothing to recompute: `provisional` stays off, and these rows
    // land in exactly the state a locally-ingested row with no entity store
    // lands in.
    const { vocabulary } = source;
    const keys = {
      subjectKey: slotKey(fact.subject, vocabulary.subject),
      predicateKey: slotKey(fact.predicate, vocabulary.predicate),
      objectKey: slotKey(fact.object, vocabulary.object),
    };
    return {
      ...tombstonePlaceholder(fact, source, keys),
      subjectCmp: null,
      objectCmp: null,
      comparableDropped: false,
      carryReasons: [],
      // Counted through `unkeyable` on this arm — the key was COMPUTED here, so
      // its null-ness is this import's own fact and its cause is the surface.
      nullKeys: false,
      // `slotKey` is null for a surface that normalizes away (`-`, `___`), which
      // is legal and permanent — and since #5047 the two key writers no longer do
      // the same thing with it. INGEST REFUSES the claim outright
      // (`reconcile.ts`'s `MALFORMED_CLAIM`); this path cannot, because the row
      // already exists in the source region, so it TOMBSTONES it exactly as
      // migration 0194 does. This counter is what makes that visible — see
      // `tombstonedFacts` in the aggregate warn below.
      unkeyable: Object.values(keys).some((k) => k === null),
    };
  }

  const subject = regionPortableComparable(fact.subjectCmp);
  const object = regionPortableComparable(fact.objectCmp);
  return {
    // `?? null` normalizes ABSENT to NULL and is not a permissive fallback:
    // validation refuses a v3 fact missing any of the five, so the only shape
    // that reaches here is the `string | null` the wire type declares. A null
    // that survives that is landed by {@link tombstonePlaceholder} — the keys
    // are `NOT NULL` since #5047, and this arm CARRIES rather than computes, so
    // it has nothing better to write.
    ...tombstonePlaceholder(fact, source, {
      subjectKey: fact.subjectKey ?? null,
      predicateKey: fact.predicateKey ?? null,
      objectKey: fact.objectKey ?? null,
    }),
    subjectCmp: subject.value,
    objectCmp: object.value,
    // Derived from the REASONS through {@link isLoss}, not from the null-ness of
    // the result. A row that arrived NULL is unchanged and has nothing to
    // recompute; a row whose value was dropped does. Same final value, different
    // fact about the row — and one exhaustive classifier rather than two string
    // tests, so a fifth reason cannot land unmarked AND uncounted.
    comparableDropped: [subject.reason, object.reason].some(isLoss),
    carryReasons: [subject.reason, object.reason],
    // A carried key is never recomputed here, so this import cannot make one
    // NULL — it can only LAND one, and since #5047 it lands only the kind whose
    // SURFACE also normalizes away. A null beside a KEYABLE surface refuses the
    // whole bundle (`RegionImportUnkeyableError`, 409), because that row is
    // repairable by the next drift re-key and both ways of landing it are not.
    //
    // So the exporter's drift path — a projection that stops returning
    // `f.subject_key`, exporting `null` for every fact — no longer lands quietly
    // with a green 200 at both ends; it IS the 409. What this counter is left
    // reporting is the residue: rows that arrived null legitimately.
    unkeyable: false,
    nullKeys: [fact.subjectKey, fact.predicateKey, fact.objectKey].some((k) => (k ?? null) === null),
  };
}

/**
 * Import one export bundle into `orgId`, inside the caller's transaction.
 *
 * `correlationId` is the caller's per-attempt token (`requestId` on both routes).
 * REQUIRED rather than optional: it is stamped on every vocabulary refusal line
 * so two attempts at the same bundle stop emitting byte-identical line sets
 * (#5112), and a parameter a caller can omit is one a caller will omit. It is
 * carried, never persisted — the durable half is the source region's
 * `region_migrations.vocabulary_refusals`.
 */
export async function importBundle(
  client: InternalPoolClient,
  bundle: ExportBundle,
  orgId: string,
  correlationId: string,
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
    brainVocabularyEdges: { imported: 0, skipped: 0, refused: 0, refusalDetails: [] },
    brainSlackChannelExclusions: { imported: 0, skipped: 0, refused: 0 },
    brainEnrollments: { imported: 0, skipped: 0, namingDropped: 0, namingApplied: 0 },
    brainEntities: { imported: 0, skipped: 0 },
    brainActorIdentities: { imported: 0, skipped: 0 },
    brainVocabularyProposals: { imported: 0, skipped: 0, refused: 0 },
    brainPredicateCardinalities: { imported: 0, skipped: 0, refused: 0 },
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

  // --- 9. The curated identity vocabulary (#5022, ADR-0037 §6/§8; merged by #5036) ---
  // It travels because the identity keys on every imported fact are
  // `alias(lexicalNorm(surface))` and ADR-0037 §8 carries those keys verbatim —
  // a workspace that arrived without its vocabulary would hold keys nothing in
  // this region can explain or undo.
  //
  // ⚠️ THIS RAN AFTER THE BRAIN UNTIL #5035, AND THE ORDER IS NOW LOAD-BEARING.
  // A v1/v2 bundle carries no keys, so its facts are keyed ONCE at import
  // against `alias_dest(lexicalNorm(surface))` — and `alias_dest` has to be the
  // vocabulary this region holds AFTER the merge, or the arriving edges are
  // invisible to exactly the rows that arrived with them. Keyed first, the
  // legacy arm would compose only the destination's own pre-existing decisions
  // and discard the source's, which is the half of §4's merge that exists to be
  // composed. Nothing else moved: this block touches only the two vocabulary
  // tables, and the closure rebuild inside the merge reads no fact.
  //
  // ⚠️ THE MERGE IS `mergeApprovedEdges`, NOT A STATEMENT SPELLED HERE, and that
  // is the whole shape of #5036. Until it landed this block was an
  // `ON CONFLICT DO NOTHING` — deliberately conservative, and wrong in a way
  // that only shows up against a destination that ALREADY holds a vocabulary:
  //
  //   1. `DO NOTHING` is destination-wins-SILENTLY. That is the right rule for
  //      every other section here, because a conversation in both regions is the
  //      same conversation — but a vocabulary edge is a HUMAN REVIEW DECISION,
  //      and two regions can hold contradictory ones legitimately. Skipping
  //      discarded the source's approved review work with no record it existed.
  //   2. It did not look for CYCLES at all, so an arriving edge could close one
  //      against a destination edge. Nothing corrupt committed — the closure
  //      rebuild refuses to commit a non-converging closure — but it aborted the
  //      ENTIRE import rather than dropping the one offending edge.
  //
  // Both are now the merge's job: it unions the approved edges, refuses the ones
  // that would close a cycle or take a second parent, LOGS every refusal with
  // enough of the source row to re-author it, and recomputes the closure once
  // per position that gained an edge. It lives in `lib/brain/vocabulary.ts`
  // beside `approveAliasEdge` so the two write paths share one copy of the four
  // refusal rules — and because `lib/` must not import from `api/routes/`.
  //
  // ⚠️ THE LOCK IS TAKEN INSIDE THE MERGE, BEFORE ITS FIRST INSERT, and the
  // order is the point: an importer that inserts first and reaches the lock only
  // at closure-rebuild time acquires the same two resources in the opposite
  // order to `approveAliasEdge`, and two writers sharing a `from_norm` deadlock
  // (`40P01`) with the whole region import as a possible victim. That
  // acquisition was removed once on a redundancy argument and had to be
  // restored; `mergeApprovedEdges` carries the long version of the story.
  const vocabularyMerge = await mergeApprovedEdges(
    client,
    orgId,
    (bundle.brainVocabularyEdges ?? []).map((edge) => ({
      // No cast: `validateBundle` narrowed this through `isSlotPosition`, and
      // `mergeApprovedEdges` asks for a `SlotPosition` — so assignability here
      // IS the check, and drift between the wire union and `SlotPosition`
      // surfaces as a compile error at this line. An `as SlotPosition` would
      // suppress exactly that error. This is the call site `identity.ts`'s
      // `_SlotPositionsCoverTheWire` pin names.
      position: edge.slotPosition,
      fromNorm: edge.fromNorm,
      toNorm: edge.toNorm,
      approvedBy: edge.approvedBy ?? null,
      approvedAt: edge.approvedAt,
    })),
    // The caller's per-attempt token, stamped on every refusal line so a retry's
    // line set is distinguishable from the first attempt's (#5112).
    correlationId,
  );

  // Three counters, and the split is the point of the slice. `skipped` is the
  // BENIGN half — an edge this region already holds with the same target, i.e.
  // what an idempotent re-import looks like from the inside. `refused` is a
  // source-region human decision this region dropped. Reporting them as one
  // number would restore the exact conflation the `DO NOTHING` had: an operator
  // reading `skipped: 2` cannot tell a clean re-import from two discarded
  // approvals, and only one of those needs them to go and re-author something.
  //
  // ⚠️ `migrate.ts` reconciles these against the manifest count and ABORTS the
  // migration before cutover if they do not add up, so `refused` had to be added
  // to that sum in the same change — otherwise the first genuinely conflicting
  // edge would fail a whole cutover instead of being logged and carried on past.
  result.brainVocabularyEdges.imported = vocabularyMerge.applied;
  result.brainVocabularyEdges.skipped = vocabularyMerge.duplicate;
  result.brainVocabularyEdges.refused = vocabularyMerge.refusals.length;

  // ⚠️ THE PAYLOADS, NOT JUST THE COUNT — this line is #5112 (#5036 read
  // `refusals.length` here and threw the array away).
  //
  // The refused edge is a human review decision the SOURCE region approved and
  // this region declined. The source is the party that cuts over and schedules
  // the cleanup that DELETEs its own `brain_vocabulary_edge` rows after the grace
  // period, so without this the party owning the irreversible act got a number
  // while the record that would let anyone undo it lived only in THIS region's
  // log retention. `residency/migrate.ts` reads these off the response and writes
  // them to the source's `region_migrations` row, which cleanup never deletes.
  //
  // Capped: a hand-built or corrupted bundle can conflict with itself on every
  // edge, and this array becomes an HTTP response body AND a `jsonb` column. The
  // count above is always the true total, so a shorter array is the truncation
  // signal — see `VOCABULARY_REFUSAL_DETAIL_CAP`.
  //
  // Field-by-field rather than spread: `VocabularyMergeRefusal` nests the edge
  // and carries `existingTarget` on only one arm, and the wire type is FLAT with
  // `existingTarget` always present. Spreading would put a nested `edge` object
  // on the wire and make the field absent on three of the four refusal kinds —
  // and "absent" and "there is no conflicting edge" read identically to the
  // operator this payload exists for, which is the same distinction the
  // target-side warn already makes with an explicit `null`.
  result.brainVocabularyEdges.refusalDetails = vocabularyMerge.refusals
    .slice(0, VOCABULARY_REFUSAL_DETAIL_CAP)
    .map((refusal) => ({
      slotPosition: refusal.edge.position,
      fromNorm: refusal.edge.fromNorm,
      toNorm: refusal.edge.toNorm,
      approvedBy: refusal.edge.approvedBy ?? null,
      approvedAt: refusal.edge.approvedAt,
      refusal: refusal.refusal,
      existingTarget: refusal.refusal === "already-aliased" ? refusal.existingTarget : null,
      reason: refusal.message,
    }));

  // --- 9a. The alias queue + its permanent rejection memory (#5023, #5113) ---
  //
  // AFTER the edge merge and BESIDE it deliberately: this is memory ABOUT the
  // edges, and the `rejected` rows are the state that stops a producer
  // re-writing what a human removed — lost, a warehouse-derived entity pair is
  // re-proposed at the destination and AUTO-APPROVES (#4507 across a region
  // boundary).
  //
  // Restored INLINE rather than delegated the way the edges are, and the
  // contrast is `brainEnrollments`' argument one section over: an arriving edge
  // must be screened by the four `approveAliasEdge` rules that would drift if
  // spelled twice, so it earns `mergeApprovedEdges`. A proposal row has no
  // closure to rebuild and no forest invariant to hold — its whole merge is
  // decided by the pair's unique slot (`uq_brain_vocabulary_proposal_pair`) and
  // the status lattice below.
  //
  // MERGE RULE, keyed on the UNORDERED pair (the table's own identity, so a
  // producer cannot route around a rejection by emitting the pair reversed):
  //
  //   - pair absent here          → INSERT verbatim (imported)
  //   - same status both sides    → skipped (idempotent re-import)
  //   - arriving DECIDED over a destination `pending` → the decision lands
  //     (imported): a decision outranks a queue entry, and the rejected arm is
  //     the one that closes #4507. Only status/reviewedBy/reviewedAt move —
  //     the destination row keeps its own proposer and direction, on
  //     `enrolledBy`'s no-re-attribution rule.
  //   - arriving `pending` over a destination decision → skipped: the queue
  //     entry re-derives and the decision already stands.
  //   - two CONTRADICTORY decisions → REFUSED: the destination's human
  //     decision is kept, on `mergeApprovedEdges`' destination-wins reasoning,
  //     and the arriving decision is logged with enough of the source row to
  //     re-author it. Surfaced, never silently overwritten.
  //
  // ⚠️ The edge merge above deliberately does NOT consult this memory (#5036's
  // scope), so a source-approved edge over a destination-REJECTED pair still
  // lands in section 9 while the arriving `approved` proposal is refused here.
  // The refusal line is what surfaces that tension; `removeAliasEdge` is the
  // destination admin's remedy, and re-ordering the two sections would not
  // remove it — it would only decide it silently in the other direction.
  //
  // ⚠️ The MIRROR direction exists too: an arriving `approved` proposal can
  // land over a destination `pending` here while `mergeApprovedEdges` refused
  // its edge (cycle / second parent). The pair's unique slot then holds an
  // `approved` row with no in-force edge, and the QUEUE cannot re-establish
  // the alias — a re-proposal meets the already-approved row. Not silent: the
  // edge refusal is surfaced with persisted `refusalDetails`, and
  // `authorAliasEdge` (which bypasses the queue) is the remedy there.
  //
  // ⚠️ THE LOCK IS TAKEN FOR THESE TWO SECTIONS TOO, on section 10's "taken for
  // the READ" reasoning. Section 9 acquires it only when the bundle carries
  // EDGES, and a bundle can carry proposals or cardinality entries with none.
  // Unlocked, two races open: (a) every other writer to the proposal table
  // (`proposeAliasEdge`, the decide seam) runs under this lock, so an unlocked
  // SELECT-then-INSERT here can 23505 against a concurrent proposer and take
  // the whole import with it; (b) the cardinality screen below reads the
  // predicate CLOSURE, and a concurrent `decideAliasProposal` approval rebuilds
  // that closure mid-read — the screen would then judge an entry against a
  // vocabulary this region no longer holds. `pg_advisory_xact_lock` is
  // re-entrant, so this costs nothing when section 9 already took it.
  if (
    (bundle.brainVocabularyProposals ?? []).length > 0 ||
    (bundle.brainPredicateCardinalities ?? []).length > 0
  ) {
    await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, orgId]);
  }
  for (const proposal of bundle.brainVocabularyProposals ?? []) {
    const existing = await client.query(
      `SELECT id, status FROM brain_vocabulary_proposal
        WHERE workspace_id = $1 AND slot_position = $2
          AND pair_low = LEAST($3, $4) AND pair_high = GREATEST($3, $4)`,
      [orgId, proposal.slotPosition, proposal.fromNorm, proposal.toNorm],
    );
    const held = existing.rows[0] as { id: string; status: string } | undefined;
    if (held === undefined) {
      await client.query(
        `INSERT INTO brain_vocabulary_proposal
           (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
            confidence, status, proposed_by, proposed_at, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          crypto.randomUUID(),
          orgId,
          proposal.slotPosition,
          proposal.fromNorm,
          proposal.toNorm,
          proposal.directed,
          proposal.sourceClass,
          proposal.confidence,
          proposal.status,
          proposal.proposedBy,
          // Verbatim, never re-stamped — the dates say when the SOURCE region
          // proposed and reviewed, and a destination re-stamping them would
          // assert readings it never took (`brain_actor_identity`'s rule).
          proposal.proposedAt,
          proposal.reviewedBy,
          proposal.reviewedAt,
        ],
      );
      result.brainVocabularyProposals.imported++;
    } else if (held.status === proposal.status) {
      result.brainVocabularyProposals.skipped++;
    } else if (held.status === "pending" && isDecidedStatus(proposal.status)) {
      const applied = await client.query(
        `UPDATE brain_vocabulary_proposal
            SET status = $2, reviewed_by = $3, reviewed_at = $4
          WHERE id = $1 AND workspace_id = $5 AND status = 'pending'`,
        [held.id, proposal.status, proposal.reviewedBy, proposal.reviewedAt, orgId],
      );
      // The status predicate re-checks under the lock; zero rows means the row
      // changed between the SELECT and here (the enrollments section's
      // concurrent-change arm, one table over). Counted `refused` and warned —
      // an `imported` that wrote nothing would report a decision as landed.
      if ((applied.rowCount ?? 0) > 0) {
        result.brainVocabularyProposals.imported++;
      } else {
        result.brainVocabularyProposals.refused++;
        log.warn(
          { orgId, correlationId, slotPosition: proposal.slotPosition, fromNorm: proposal.fromNorm, toNorm: proposal.toNorm, arrivingStatus: proposal.status },
          "Region import: the arriving vocabulary-proposal decision matched no pending row to update — it was decided concurrently. The source decision is NOT applied; re-author it here if it is the right one",
        );
      }
    } else if (proposal.status === "pending") {
      result.brainVocabularyProposals.skipped++;
    } else {
      result.brainVocabularyProposals.refused++;
      log.warn(
        {
          orgId,
          correlationId,
          slotPosition: proposal.slotPosition,
          fromNorm: proposal.fromNorm,
          toNorm: proposal.toNorm,
          arrivingStatus: proposal.status,
          existingStatus: held.status,
          reviewedBy: proposal.reviewedBy,
          reviewedAt: proposal.reviewedAt,
        },
        // FUTURE tense, on the vocabulary merge's reasoning exactly: this runs
        // inside the import transaction, and a rollback means nothing was
        // dropped because nothing was applied.
        "Region import WILL DROP an arriving vocabulary-proposal decision when this transaction " +
          "commits — this region's own human decision for the pair contradicts it and is kept. " +
          "Re-author it here if the source region's reading is the right one",
      );
    }
  }

  // --- 9a-ii. Canonical-predicate cardinality decisions (#5027, #5113) ---
  //
  // AFTER the edge merge, and the ordering is the section's whole safety
  // argument: the key screen below reads the destination's POST-MERGE
  // predicate closure, so an entry is judged against the vocabulary this
  // region will actually hold — not the one it held before the source's edges
  // landed.
  //
  // ⚠️ THE RE-CANONICALIZATION SCREEN is the arm the old `stays` deferral
  // existed for. `predicate_key` is `alias(lexicalNorm(surface))` UNDER THE
  // SOURCE'S vocabulary; if THIS region's closure aliases that norm onto a
  // different target, the arriving entry names a slot this region files
  // elsewhere. Landing it verbatim would leave a `single` license on a key no
  // fact here carries (silent), and RE-KEYING it onto the destination's target
  // would make an unrelated slot destructively supersedable with no preview —
  // the direction bundle-scope.ts calls the one that is not affordable. So it
  // is REFUSED, per row, visibly: counted, and logged with the key both ways.
  // Re-authoring at the destination (where a human can see both norms) is the
  // remedy, and under-supersession until then is the recoverable direction.
  for (const entry of bundle.brainPredicateCardinalities ?? []) {
    const closure = await client.query(
      `SELECT effective_target FROM brain_vocabulary_target
        WHERE workspace_id = $1 AND slot_position = 'predicate' AND norm = $2`,
      [orgId, entry.predicateKey],
    );
    const reKeyedTo = (closure.rows[0] as { effective_target: string } | undefined)
      ?.effective_target;
    if (reKeyedTo !== undefined) {
      // A closure row exists only for a norm aliased AWAY (`not_self` CHECK),
      // so its presence IS the disagreement — no comparison needed.
      result.brainPredicateCardinalities.refused++;
      log.warn(
        {
          orgId,
          correlationId,
          predicateKey: entry.predicateKey,
          canonicalHere: reKeyedTo,
          cardinality: entry.cardinality,
          status: entry.status,
          reviewedBy: entry.reviewedBy,
        },
        "Region import WILL DROP an arriving predicate-cardinality entry when this transaction " +
          "commits — this region's vocabulary canonicalizes its predicate onto a different norm, " +
          "and re-keying it silently would license supersession on a slot no human curated. " +
          "Re-author the decision here against the canonical predicate this region holds",
      );
      continue;
    }
    const existing = await client.query(
      `SELECT status, cardinality FROM brain_predicate_cardinality
        WHERE workspace_id = $1 AND predicate_key = $2`,
      [orgId, entry.predicateKey],
    );
    const held = existing.rows[0] as { status: string; cardinality: string } | undefined;
    if (held === undefined) {
      // `ON CONFLICT DO NOTHING` + RETURNING rather than a bare INSERT: the
      // table's OWN writers (`proposeSingleCardinality`, the authoring upsert)
      // are atomic single statements that take no advisory lock, so the
      // vocabulary lock above does not serialize them — a concurrent proposer
      // can take the key's only slot between the SELECT and here, and a bare
      // INSERT would then 23505 the whole import. Zero rows is that race:
      // counted `refused` and warned (destination-wins, like every conflict in
      // this section), never retried blind.
      const inserted = await client.query(
        `INSERT INTO brain_predicate_cardinality
           (workspace_id, predicate_key, cardinality, status, source_class,
            proposed_by, proposed_at, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (workspace_id, predicate_key) DO NOTHING
         RETURNING 1 AS inserted`,
        [
          orgId,
          entry.predicateKey,
          entry.cardinality,
          entry.status,
          entry.sourceClass,
          entry.proposedBy,
          entry.proposedAt,
          entry.reviewedBy,
          entry.reviewedAt,
        ],
      );
      if (inserted.rows.length > 0) {
        result.brainPredicateCardinalities.imported++;
      } else {
        // The concurrent row decides the outcome the way a pre-held row would
        // have: an IDENTICAL decision (same status, and same value or both
        // rejected) is the skip arm arriving late, and counting it `refused`
        // would report a human conflict where there is agreement — the
        // reconciliation still balances either way, but `refused` is the
        // counter an operator acts on. Anything else stays destination-wins,
        // refused and warned; the racy arm deliberately does NOT re-enter the
        // decision-over-pending lattice, because a concurrent `pending` row's
        // proposer is actively working the key right now and destination-wins
        // is the direction that never overwrites a human mid-decision.
        const raced = await client.query(
          `SELECT status, cardinality FROM brain_predicate_cardinality
            WHERE workspace_id = $1 AND predicate_key = $2`,
          [orgId, entry.predicateKey],
        );
        const racedHeld = raced.rows[0] as { status: string; cardinality: string } | undefined;
        if (
          racedHeld !== undefined &&
          racedHeld.status === entry.status &&
          (racedHeld.cardinality === entry.cardinality || racedHeld.status === "rejected")
        ) {
          result.brainPredicateCardinalities.skipped++;
        } else {
          result.brainPredicateCardinalities.refused++;
          log.warn(
            {
              orgId,
              correlationId,
              predicateKey: entry.predicateKey,
              arrivingStatus: entry.status,
              existingStatus: racedHeld?.status ?? null,
              existingCardinality: racedHeld?.cardinality ?? null,
            },
            "Region import: a predicate-cardinality entry appeared concurrently while importing this one — this region's row is kept and the arriving entry is NOT applied; re-author it here if it is the right one",
          );
        }
      }
    } else if (
      held.status === entry.status &&
      // Two REJECTED rows agree in effect whatever value each declined: the
      // memory — a rejection occupying the key's only slot — is identical.
      (held.cardinality === entry.cardinality || held.status === "rejected")
    ) {
      result.brainPredicateCardinalities.skipped++;
    } else if (held.status === "pending" && isDecidedStatus(entry.status)) {
      // A decision outranks a queue entry. The value moves WITH the decision —
      // an approval of `single` over a pending `multi` is an approval of
      // `single` — but the destination row keeps its own proposer, on
      // `enrolledBy`'s no-re-attribution rule. The status predicate re-checks
      // under the statement's own snapshot (`decidePredicateCardinality`'s
      // shape); zero rows is a concurrent decision, counted and warned.
      const applied = await client.query(
        `UPDATE brain_predicate_cardinality
            SET cardinality = $3, status = $4, reviewed_by = $5, reviewed_at = $6
          WHERE workspace_id = $1 AND predicate_key = $2 AND status = 'pending'`,
        [orgId, entry.predicateKey, entry.cardinality, entry.status, entry.reviewedBy, entry.reviewedAt],
      );
      if ((applied.rowCount ?? 0) > 0) {
        result.brainPredicateCardinalities.imported++;
      } else {
        result.brainPredicateCardinalities.refused++;
        log.warn(
          { orgId, correlationId, predicateKey: entry.predicateKey, arrivingStatus: entry.status },
          "Region import: the arriving predicate-cardinality decision matched no pending row to update — it was decided concurrently. The source decision is NOT applied; re-author it here if it is the right one",
        );
      }
    } else if (entry.status === "pending") {
      result.brainPredicateCardinalities.skipped++;
    } else {
      result.brainPredicateCardinalities.refused++;
      log.warn(
        {
          orgId,
          correlationId,
          predicateKey: entry.predicateKey,
          arrivingStatus: entry.status,
          arrivingCardinality: entry.cardinality,
          existingStatus: held.status,
          existingCardinality: held.cardinality,
          reviewedBy: entry.reviewedBy,
        },
        "Region import WILL DROP an arriving predicate-cardinality decision when this transaction " +
          "commits — this region's own human decision for the predicate contradicts it and is " +
          "kept. Re-author it here if the source region's reading is the right one",
      );
    }
  }

  // --- 9b. The Slack ingest-scope narrowings (#5203) ---
  // Written BEFORE the episodes below, and that ordering is load-bearing: the
  // destination's first sync resolves scope from this table, and an exclusion
  // that landed after a sync had already run would be an exclusion applied to
  // channels already ingested. Nothing in the import triggers a sync, so the
  // window is theoretical today — but the cheap ordering is the one that stays
  // correct when it is not.
  //
  // `is_member = false` on insert, deliberately: this bundle carries no
  // membership (see `ExportedBrainSlackChannelExclusion`), and claiming the bot
  // is in a channel it may have been removed from before the migration would put
  // the row in the destination's poll scope the moment someone un-excluded it.
  // The first sync sets it from `users.conversations`.
  for (const exclusion of bundle.brainSlackChannelExclusions ?? []) {
    // ⚠️ NOT `DO NOTHING`. A `brain_slack_channel` row is ALSO created by the
    // membership walk with `excluded_at IS NULL` — and if the destination's
    // Slack sync ran before this import (chat installs travel independently of
    // the bundle), every exclusion for a channel the bot is a member of — i.e.
    // exactly the ones that matter — would hit the conflict and be DROPPED
    // while being counted `skipped`. A lost exclusion is over-disclosure, the
    // direction the export type's own docstring calls unrecoverable. So the
    // conflict arm mirrors `excludeSlackChannel`'s upsert: the exclusion lands
    // on an unexcluded row, and a row a destination admin ALREADY excluded
    // keeps its own author and reason (first attribution wins). `prior` reads
    // the pre-statement snapshot so the imported/skipped split reports what
    // actually happened: `imported` = the exclusion took effect here,
    // `skipped` = the channel was already excluded. There is no `refused` arm
    // today; the counter exists so a future conflict rule has somewhere to
    // report that is not `skipped`.
    const { rows } = await client.query(
      `WITH prior AS (
         SELECT excluded_at FROM brain_slack_channel
          WHERE workspace_id = $1 AND channel_id = $2
       )
       INSERT INTO brain_slack_channel
         (workspace_id, channel_id, is_member, excluded_at, exclusion_reason, excluded_by,
          created_at, updated_at)
       VALUES ($1, $2, false, $3, $4, $5, now(), now())
       ON CONFLICT (workspace_id, channel_id) DO UPDATE
         SET excluded_at = COALESCE(brain_slack_channel.excluded_at, EXCLUDED.excluded_at),
             exclusion_reason = CASE WHEN brain_slack_channel.excluded_at IS NULL
                                     THEN EXCLUDED.exclusion_reason
                                     ELSE brain_slack_channel.exclusion_reason END,
             excluded_by = CASE WHEN brain_slack_channel.excluded_at IS NULL
                                THEN EXCLUDED.excluded_by
                                ELSE brain_slack_channel.excluded_by END,
             updated_at = now()
       RETURNING (SELECT excluded_at IS NOT NULL FROM prior) AS was_excluded`,
      [orgId, exclusion.channelId, exclusion.excludedAt, exclusion.exclusionReason, exclusion.excludedBy],
    );
    const wasExcluded = (rows[0] as { was_excluded: boolean | null } | undefined)?.was_excluded;
    if (wasExcluded === true) result.brainSlackChannelExclusions.skipped++;
    else result.brainSlackChannelExclusions.imported++;
  }

  if (bundle.brainSlackIngestScope !== undefined) {
    // `DO NOTHING`: a destination that already has a scope row has its own
    // reconcile state, and overwriting it with the source's could un-reconcile a
    // workspace — putting a spent allowlist back in charge of a scope the
    // exclusions above already express.
    await client.query(
      `INSERT INTO brain_slack_ingest_scope (workspace_id, legacy_channels, created_at, updated_at)
       VALUES ($1, $2::text[], now(), now())
       ON CONFLICT (workspace_id) DO NOTHING`,
      // Deduped: a bundle with a repeated id would otherwise have the
      // legacy-pending poll walk the channel twice per pass (deduped
      // downstream, so waste and skewed exclusion arithmetic, not
      // corruption).
      [orgId, [...new Set(bundle.brainSlackIngestScope.legacyChannels)]],
    );
  }

  // --- 9c. The warehouse producer's enrolled reach (#5196, ADR-0039) ---
  //
  // Restored INLINE rather than delegated to a `lib/brain/` merge the way
  // `brainVocabularyEdges` is, and the contrast is the argument. An arriving
  // alias edge has to be screened against this region's own approved edges for
  // at-most-one-parent and for cycles — four rules that would drift if spelled
  // twice — so it earns a shared implementation. An arriving enrollment has
  // nothing to screen: the pair IS the primary key, both regions' rows are the
  // same kind of deliberate human act, and a pair enrolled in both regions is
  // one decision made twice. The union is the whole merge.
  //
  // `DO NOTHING` rather than `DO UPDATE`, on the enroll verb's own rule: the
  // destination's row, if it has one, carries ITS OWN author and timestamp, and
  // overwriting them would re-attribute a local admin's decision to whoever
  // happened to enroll the same pair in the source region.
  //
  // `namedEntities` guards the partial unique index — see the `naming` param
  // below. Seeded from the DESTINATION, not from the bundle: the row that must
  // win is the one already here.
  // ⚠️ Keyed on `(entity, group)` since #5286, matching
  // `uq_brain_enrollment_naming`'s own scope. Keyed on the entity alone it would
  // read one group's naming decision as the other group's and report an
  // arriving row as `namingDropped` when the two never competed — the same class
  // of false loss the dimension half of this key was added to fix, one column
  // over.
  const namingKey = (entity: string, group: string | null) => `${entity}\u0000${group ?? ""}`;
  const namedEntities = new Map<string, string>(
    (
      await client.query(
        `SELECT entity, connection_group_id, dimension FROM brain_enrollment WHERE workspace_id = $1 AND naming`,
        [orgId],
      )
    ).rows.map(
      (r) =>
        [
          namingKey(r.entity as string, (r.connection_group_id as string) || null),
          r.dimension as string,
        ] as const,
    ),
  );
  for (const enrollment of bundle.brainEnrollments ?? []) {
    const wantsNaming = enrollment.naming === true;
    // Absent (a pre-#5286 bundle) and explicit `null` are one state: the flat
    // scope, stored as `''`. Normalised once here so the key, the INSERT and the
    // naming UPDATE below cannot disagree about which row they mean.
    const group = enrollment.connectionGroupId ?? null;
    const storedGroup = group ?? "";
    // ⚠️ The map holds the DIMENSION, not just the entity, and that distinction
    // is the difference between a loss and a no-op. Keyed on the entity alone,
    // a destination that already names the SAME dimension the bundle names
    // counted as a drop — so an idempotent re-import reported a human decision
    // discarded when nothing at all had happened. Caught by the round-trip's own
    // second-import assertion.
    const namedHere = namedEntities.get(namingKey(enrollment.entity, group));
    const alreadyApplied = wantsNaming && namedHere === enrollment.dimension;
    const granted = wantsNaming && namedHere === undefined;
    const { rows } = await client.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, connection_group_id, dimension, enrolled_at, enrolled_by, note, naming)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, entity, connection_group_id, dimension) DO NOTHING
       RETURNING entity`,
      [
        orgId,
        enrollment.entity,
        storedGroup,
        enrollment.dimension,
        enrollment.enrolledAt,
        enrollment.enrolledBy,
        enrollment.note ?? null,
        // `?? false` because the field is OPTIONAL on the wire: a v3 bundle
        // written before #5043 carries no `naming`, and `false` is that
        // bundle's truth rather than a guess about it.
        //
        // ⚠️ It can still collide. `uq_brain_enrollment_naming` admits one
        // naming row per entity, and a destination that already named a
        // DIFFERENT dimension for the same entity would raise 23505 here and
        // abort the cutover. `DO NOTHING` does not cover it — the conflict is
        // on the partial index, not on the primary key — so the arriving row's
        // flag is dropped when this region already has one. The local decision
        // wins for `enrolledBy`'s reason: it is this region's admin's, and
        // silently re-pointing it would re-key their corpus.
        granted,
      ],
    );
    if (granted) namedEntities.set(namingKey(enrollment.entity, group), enrollment.dimension);
    // `DO NOTHING` returns no row for the conflict case, which is exactly the
    // "this region already holds it" split `skipped` reports.
    if (rows.length > 0) result.brainEnrollments.imported++;
    else result.brainEnrollments.skipped++;

    // ⚠️ **TWO ways the flag is lost, and only ONE of them is the deliberate
    // policy above (#5232's review).**
    //
    //   (a) This region already names a DIFFERENT dimension for the entity.
    //       The local decision wins — deliberate — but it is a human authority
    //       decision being discarded, so it is counted and logged rather than
    //       dropped by an `&&`.
    //   (b) This region already holds the SAME pair with `naming = false` and
    //       names nothing. `granted` is true, but `ON CONFLICT DO NOTHING`
    //       skipped the write, so the column keeps `false`. The local-wins
    //       argument does NOT cover this case — there is no local decision to
    //       protect — and the loss is ADR-0039-invisible: the destination's
    //       store writes no entry, every lookup abstains, the list still shows
    //       the pair as live, and the section reports `skipped`, which
    //       everywhere else means "this region already holds it". It holds the
    //       PAIR; it does not hold the DECISION.
    if (wantsNaming && !granted && !alreadyApplied) {
      result.brainEnrollments.namingDropped++;
      log.warn(
        { orgId, entity: enrollment.entity, dimension: enrollment.dimension },
        "Region import: the arriving naming dimension was dropped — this region already names a " +
          "different dimension for that entity. Its imported entity-store entries are cleared on " +
          "the next producer run unless an admin re-names it",
      );
    } else if (granted && rows.length === 0) {
      // (b). One UPDATE, the same shape `setNamingDimension` uses, rather than
      // an `ON CONFLICT DO UPDATE` on the whole row — the row's `enrolled_by`,
      // `enrolled_at` and `note` must stay the destination's.
      const applied = await client.query(
        `UPDATE brain_enrollment SET naming = true
          WHERE workspace_id = $1 AND entity = $2 AND connection_group_id = $3 AND dimension = $4
            AND NOT naming`,
        [orgId, enrollment.entity, storedGroup, enrollment.dimension],
      );
      // ⚠️ **COUNTED, because `skipped` says the opposite of what happened.**
      // Everywhere else `skipped` means "this region already holds it" — and it
      // holds the PAIR, not the DECISION. This UPDATE is what makes the
      // destination's next producer run write entity-store entries and raise an
      // edge that RE-KEYS every fact about the entity, which is the blast radius
      // `setNamingDimension` puts behind an owner/admin bar. Reporting it under
      // a counter that reads "nothing happened" is the silence `namingDropped`
      // was added to end, one branch over — so the positive twin exists too.
      if ((applied.rowCount ?? 0) > 0) {
        result.brainEnrollments.namingApplied++;
        log.info(
          { orgId, entity: enrollment.entity, dimension: enrollment.dimension },
          "Region import: applied an arriving naming dimension to a pair this region already held " +
            "unnamed — the next producer run re-keys every fact about that entity",
        );
      } else {
        // Zero rows: something changed the row between the SELECT that seeded
        // `namedEntities` and here. Not silent — the human decision is lost.
        result.brainEnrollments.namingDropped++;
        log.warn(
          { orgId, entity: enrollment.entity, dimension: enrollment.dimension },
          "Region import: the arriving naming dimension matched no row to update — it was " +
            "changed concurrently. The decision is NOT applied; re-name it by hand",
        );
      }
    }
  }

  // --- 9d. The entity store's snapshot entries (#5043, ADR-0037 §5) ---
  //
  // Restored inline, on `brainEnrollments`' reasoning: there is nothing to
  // screen. `entity_id` is a digest of `(workspace, entity, primary key)`, so
  // two regions holding one id hold one warehouse row.
  //
  // `DO NOTHING` and NOT `DO UPDATE`, and this is the arm where the difference
  // has teeth. An arriving snapshot may be OLDER than the destination's — a
  // bundle taken last week against a workspace whose producer has run since —
  // and last-writer-wins would re-key that workspace's corpus onto a canonical
  // surface that has already changed. That is ADR-0037 §5's workspace-wide blast
  // radius arriving from a direction nobody is watching. Under-restoring is
  // recoverable by re-running the producer; a wrong re-key is not.
  //
  // ⚠️ **NOTHING RECONCILES NAMES HERE, and that is the decision rather than the
  // omission** (#5320). Two regions naming one entity differently leaves both
  // sets live under two `(workspace_id, entity)` keys with the same canonical
  // norms and different ids, which poisons every shared norm — #5316 measured
  // the same shape arriving from an ordinary rename. The obvious place to fix it
  // looks like this loop, and this loop is the one place it must not be fixed:
  //
  //   - The imported entries ARE the bridge. `bundle-scope.ts` exports them for
  //     exactly one reason — they answer surfaces by name from the moment the
  //     bundle lands until the destination has warehouse credentials again — so
  //     deleting any of them here blinds the window they exist to cover. That is
  //     the remedy #5233 rules out by name.
  //   - And this importer has no standing to say which name is current. The
  //     destination cannot read its warehouse yet, by construction; the first
  //     moment anything knows the destination's own naming is its first producer
  //     run, which is where `writeEntityEntries` does the reconciliation.
  //
  // So the poisoning is SELF-CLEARING rather than unreachable: it can exist
  // between the import and that first run, `entityEdges.ambiguous` reports it
  // while it does, and the run clears it in the minting transaction. The one
  // shape that outlives that is two source regions merged into one destination
  // whose producer never runs — reported, never silent.
  //
  // Before the facts below, though nothing depends on it: `regionPortableComparable`
  // classifies the `entity:` tag `store-local`, so this importer NULLS an
  // entity-valued `_cmp` on every arriving fact and none of them references an
  // entry. The order is for a reader of a half-finished import, not a
  // constraint — and an earlier version of this comment claimed otherwise,
  // which is the claim `bundle-scope.ts` corrects two files away.
  for (const entry of bundle.brainEntities ?? []) {
    const { rows } = await client.query(
      `INSERT INTO brain_entity
         (workspace_id, entity_id, entity, key_surface, key_norm, canonical_surface, canonical_norm, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, entity_id) DO NOTHING
       RETURNING entity_id`,
      [
        orgId,
        entry.entityId,
        entry.entity,
        entry.keySurface,
        entry.keyNorm,
        entry.canonicalSurface,
        entry.canonicalNorm,
        entry.snapshotAt,
      ],
    );
    if (rows.length > 0) result.brainEntities.imported++;
    else result.brainEntities.skipped++;
  }

  // --- 9c. The human NAME behind each claim's actor handle (#5440, ADR-0036 §T5) ---
  //
  // ⚠️ This section exists because the enumeration above is EXPLICIT and its
  // omissions are SILENT. A brain table absent from this file does not travel,
  // the bundle imports clean, every count reads fine, and every migrated claim
  // comes out `opaque` — a workspace that could name its authors before the
  // cutover cannot afterwards, with no error anywhere. ADR-0036 §T5's amendment
  // decided snapshots travel for exactly that reason. (The evidence this
  // comment used to cite — `brain_predicate_cardinality`, absent from this file
  // under a recorded deferral — has since been closed: #5113 wires it in
  // section 9a-ii above.)
  //
  // Ordered BEFORE the facts below, and unlike the entity store's ordering note
  // this one is not merely for a reader: nothing enforces it with an FK — the
  // join is `provenance ->> 'actor'` to `actor`, a VALUE join with no
  // constraint — but landing the identities first means a half-finished import
  // never has a window where claims are readable and their authors are not.
  //
  // `DO NOTHING`, for `brain_entity`'s reason sharpened by one more: an older
  // arriving snapshot must not overwrite a newer local one, AND must not
  // overwrite a local ERASURE. A bundle taken before an operator cleared a name
  // would otherwise restore it here, which is the one outcome an erasure has to
  // survive. `snapshot_at` and `erased_at` are written VERBATIM rather than
  // stamped `now()`: the dates say when the vendor named this person and when a
  // human removed the name, and re-stamping either would assert a reading this
  // region never took.
  for (const entry of bundle.brainActorIdentities ?? []) {
    const { rows } = await client.query(
      `INSERT INTO brain_actor_identity
         (workspace_id, actor, source, vendor_user_id, state, user_id,
          display_name, real_name, email, snapshot_at, erased_at, erased_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workspace_id, actor) DO NOTHING
       RETURNING actor`,
      [
        orgId,
        entry.actor,
        entry.source,
        entry.vendorUserId,
        entry.state,
        entry.userId ?? null,
        entry.displayName ?? null,
        entry.realName ?? null,
        entry.email ?? null,
        entry.snapshotAt ?? null,
        entry.erasedAt ?? null,
        entry.erasedBy ?? null,
      ],
    );
    if (rows.length > 0) result.brainActorIdentities.imported++;
    else result.brainActorIdentities.skipped++;
  }

  // --- 10. Company brain (#4767, ADR-0036) — facts ride inside their episode ---
  // Ordering is load-bearing, and it is the reason facts are NESTED rather
  // than a sibling array: episode → its facts → (later) edges. A fact's
  // `source_episode_id` is NOT NULL, so writing facts before episodes would
  // fail the FK; writing edges before both would fail theirs.
  //
  // Everything that makes a fact trustworthy is carried verbatim — provenance,
  // grant, review status, all four temporal columns, and since #5035 the three
  // identity keys. Nothing is defaulted except the bundle-version fallback on `preWideningVisibleTo` (#4836, see below): a
  // permissive fallback here would manufacture the very rows the table's
  // CHECKs exist to refuse, and would do it while claiming a successful
  // migration.
  //
  // Where this import's identity comes from, decided ONCE for the whole bundle
  // (#5035). A v3 bundle carries it and needs no lookup; a legacy bundle is
  // keyed here, against the vocabulary section 9 just merged and rebuilt.
  //
  // A discriminated union rather than a nullable vocabulary, so the pairing is
  // structural: there is no shape in which the legacy arm runs without a
  // vocabulary, and therefore no IMPLICIT `?? identityVocabulary` fallback that
  // would silently key a whole corpus against the identity function when a load
  // failed. ⚠️ It does NOT stop an explicit one — `ClaimVocabulary` is
  // structural and `identityVocabulary` satisfies the field, which is exactly
  // the substitution `bundle-identity.mutations.ts` performs. The union closes
  // the accident, not the decision. One query per legacy import, not per fact.
  //
  // Gated on the bundle actually carrying facts, and that is not an
  // optimization: `loadClaimVocabulary` THROWS `VocabularyClosureError` when the
  // DESTINATION's closure is half-rebuilt, and failing a conversations-and-
  // dashboards migration over corruption in a subsystem it never touches is a
  // refusal with no cause. When it does fire it is loud, rolls the whole import
  // back, and is repairable with `recomputeEffectiveTargets` — the right shape
  // for a corpus that genuinely cannot be keyed.
  //
  // ⚠️ THE LOCK IS TAKEN FOR THE READ, not only for the edge INSERTs above.
  // Section 9 acquires it only when the bundle carries edges — and a legacy
  // bundle usually carries NONE, since v1/v2 predate the vocabulary. That is
  // precisely the arm that reads the vocabulary here. Without this acquisition:
  // this transaction reads the closure at t0 unlocked; `decideAliasProposal`
  // approves an edge, rebuilds, and runs `REKEY_DRIFTED_FACTS_SQL` over every
  // row for the workspace, committing at t1 — it cannot see our uncommitted
  // rows; we commit at t2 with pre-approval keys. The corpus is then split
  // permanently, local rows keyed post-approval and imported rows pre-, which is
  // `vocabulary-decide.ts`'s own "a committed lie about what the corpus collides
  // on". `pg_advisory_xact_lock` is re-entrant, so this costs nothing when
  // section 9 already took it.
  const legacyKeying =
    bundle.manifest.version < IDENTITY_FROM_VERSION &&
    (bundle.brainEpisodes ?? []).some((e) => e.facts.length > 0);
  if (legacyKeying) {
    await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, orgId]);
  }
  const identitySource: IdentitySource = legacyKeying
    ? { carried: false, vocabulary: await loadClaimVocabulary(client, orgId) }
    : { carried: true };

  // Identity losses, aggregated for ONE warn at the end of the brain block
  // rather than one per fact — a per-row line on a corpus-sized import trains an
  // operator to skim, and skimming is how the one line that mattered is missed.
  //
  // Three counters, not one, because they mean different things and only two of
  // them are the design working:
  //
  //   storeLocalPositions — an `entity:` id dropped. ADR-0037 §8's rule,
  //                expected, and the size of it is what tells an operator how
  //                much of the corpus abstains until recomputed.
  //   unreadablePositions — the source region wrote a tag or a payload THIS
  //                region cannot read. Real evidence lost, and the only symptom
  //                otherwise is its absence. A version skew between two
  //                independently deployed regions produces exactly this.
  //   unkeyableFacts — a legacy surface that normalizes away, so no key exists.
  //                Legal and permanent. Ingest REFUSES such a claim since #5047;
  //                this writer cannot, since the row already exists in the source
  //                region, so it tombstones it as migration 0194 does.
  //   nullKeyFacts — a v3 fact that ARRIVED with a null key. Only reaches here
  //                when its surface ALSO normalizes away: a null key beside a
  //                keyable surface refuses the import instead (#5047), because
  //                that row is repairable and both ways of landing it are not.
  //   tombstonedFacts — what the import DID: the row carries a placeholder key
  //                and `invalidated_at`. The count to act on.
  //
  // ⚠️ The names carry their UNIT because the first two count POSITIONS (up to
  // two per fact) and the last three count FACTS. Read against `brainFacts.imported`
  // without that, a ratio is nonsense in one direction and understated in the other.
  const identityLoss = {
    storeLocalPositions: 0,
    unreadablePositions: 0,
    unkeyableFacts: 0,
    nullKeyFacts: 0,
    // What the import DID about the two above (#5047), as opposed to why the key
    // was absent. Kept separate from them deliberately: those two say WHERE the
    // null came from — computed here off a degenerate surface, or arrived null on
    // the wire — and this says the row landed TOMBSTONED, which is the fact an
    // operator has to act on. A fourth cause would otherwise land unmarked and
    // untold at once.
    tombstonedFacts: 0,
  };
  /**
   * Facts whose bundle `status` said `published` and whose provenance named no
   * person, so this import landed them `draft` instead (#5424).
   *
   * Counted OUTSIDE `identityLoss` on purpose. Every member of that object is
   * about a key that could not be supplied; this is about a claim that could not
   * be attributed, and folding it in would put two unrelated failure classes
   * behind one number an operator reads as "identity problems".
   */
  let unattributedDemoted = 0;

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

      // #5424 — the region import must not CONFER authority on a claim that
      // names nobody.
      //
      // The bundle's `status` is otherwise restored verbatim, and that is right:
      // restoring a review decision is not making one, which is the same
      // restore-is-not-arbitration line `sources.ts` draws for `source` and
      // `RETRACT_FACT_SQL`'s sole-writer scan draws for `invalidated_at`. It
      // stops being right when the restored decision is `published` on a row
      // whose provenance names no person — finish condition 2 admits no
      // exception "including for claims that arrived by import, correction, or
      // migration", and a published claim is served by `searchBrain` to every
      // reader its grant admits.
      //
      // DEMOTED, not refused, and the choice is the argument. Refusing the
      // bundle is what `sources.ts` rejected for `source` and the reasoning
      // transfers unchanged: validation is all-or-nothing, so one unattributed
      // fact from a corpus that predates the reconcile gate would strand the
      // whole workspace in its old region, discovered at cutover. Demotion
      // costs a human one review click and is reversible in the direction that
      // matters — a draft can be published once somebody attributes it, while
      // an unattributable published claim cannot be un-served retroactively.
      //
      // ⚠️ It does NOT hide the row. The claim, its surfaces and its evidence
      // all import verbatim; only `status` moves. The fact stays visible in the
      // review queue, which is the surface a human can act on.
      const namesAPerson = bundleFactNamesAPerson(fact);
      const demoteUnattributed = !namesAPerson && fact.status === "published";
      if (demoteUnattributed) {
        unattributedDemoted++;
        // Logged per row, not just counted — this is the lane #5424 found, and
        // the `source` fail-open it is modelled on logs its value too. A count
        // alone would say "some claims arrived unattributed" with no way back
        // to which.
        log.warn(
          { orgId, factId: fact.id, sourceId: episode.sourceId, source: episode.source },
          "Imported a brain fact whose provenance names no person — landed as a DRAFT rather than restoring the bundle's 'published' status (#5424, finish condition 2). The claim, its surfaces and its evidence are imported verbatim; only the review status moved. Publish it once its provenance carries an actor",
        );
      }

      const identity = importedIdentity(fact, identitySource);
      for (const reason of identity.carryReasons) {
        switch (reason) {
          case "store-local":
            identityLoss.storeLocalPositions++;
            break;
          case "unreadable":
            identityLoss.unreadablePositions++;
            break;
          case "carried":
          case "absent":
            break;
          default: {
            // A fifth reason must not fall silently out of BOTH this counter and
            // `comparableDropped` — two silent drops from one added union
            // member, in the one file that otherwise pins exhaustiveness twice.
            const exhaustive: never = reason;
            throw new Error(`importBundle: unhandled carry reason ${String(exhaustive)}`);
          }
        }
      }
      if (identity.unkeyable) identityLoss.unkeyableFacts++;
      if (identity.nullKeys) identityLoss.nullKeyFacts++;
      // NEWLY tombstoned only. `identity.tombstoned` drives the WRITE, which
      // `COALESCE`s so a fact that arrived already tombstoned keeps the source
      // region's timestamp — for that row this import retired nothing, and
      // counting it would raise a false alarm pointing at manual DB surgery.
      if (identity.tombstoned && (fact.invalidatedAt ?? null) === null) {
        identityLoss.tombstonedFacts++;
      }

      await client.query(
        // `pre_widening_visible_to` travels or the target region re-opens the
        // #4836 disclosure: absent, every widened fact reads as never-widened
        // and hands its first episode's actor, channel and timestamp to the
        // whole org. It cannot be re-derived here — the import writes `status`
        // verbatim, so the fact never re-publishes and the widening UPDATE
        // that is its only writer never runs again.
        //
        // The three IDENTITY KEY columns are here since #5035, and a CARRY is
        // what ADR-0037 §8 settles on: re-deriving at the destination fails to
        // OVER-match (irreversible), carrying fails to UNDER-match
        // (recoverable). {@link importedIdentity} owns both arms and the
        // null-out; this statement only binds what it decided.
        //
        // ⚠️ `predicate_cardinality` LEFT this list. #5027 moved cardinality
        // onto the canonical predicate and the per-row values are LLM guesses,
        // so the column falls to its schema default (`multi`, the conservative
        // arm — coexisting is recoverable, wrongly superseding destroys a
        // belief). This is the same move `INSERT_FACT_SQL` made, one writer
        // over. ⚠️ #5028 phase 2 has since DROPPED the column (migration 0195),
        // so re-adding it here no longer writes a stale guess — it aborts the
        // import outright, which `migrate-roundtrip-pg.test.ts` catches by the
        // legacy row not arriving at all. A v1/v2 bundle's carried value is
        // accepted by validation and dropped HERE, deliberately: honouring it
        // would restore a guess as though it were a curated decision.
        //
        // ⚠️ `provenance` is the one column with a MUTATION rather than a
        // verbatim bind, and it is spelled `jsonb_set` rather than a rebuilt
        // object so exactly one key moves and every producer-specific key the
        // payload carries is untouched. It writes `provisional` — the marker's
        // one job, *this row's comparable value is worth recomputing* — on the
        // rows whose `_cmp` this import dropped, and on no others. Without it
        // the null-out is merely safe; with it, it is recoverable, and
        // `PROVISIONAL_PREDICATE` is the query that finds the rows.
        `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, subject_key, predicate_key, object_key, subject_cmp, object_cmp, valid_from, valid_to, ingested_at, invalidated_at, extracted_at, source_episode_id, provenance, status, visible_to, pre_widening_visible_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 -- invalidated_at is the one other column with a CASE, and for
                 -- #5047's reason rather than #5035's. A fact whose key this
                 -- import could not supply lands TOMBSTONED, matching migration
                 -- 0194's treatment of the same state; the placeholder key beside
                 -- it only satisfies the constraint, and the tombstone is what
                 -- keeps the row out of all three slot consumers.
                 --
                 -- COALESCE and not an overwrite: a fact that arrived ALREADY
                 -- tombstoned keeps the source region's timestamp, because when
                 -- it stopped being a belief is a fact about the corpus and not
                 -- about this import. now() and not a bind, so the stamp comes
                 -- from the same clock the migration's does.
                 -- (No backticks in this comment: the statement is a template
                 -- literal, and one would end it.)
                 CASE WHEN $24::boolean THEN COALESCE($14::timestamptz, now())
                      ELSE $14::timestamptz END,
                 $15, $16,
                 CASE WHEN $17::boolean
                      THEN jsonb_set($18::jsonb, '{provisional}', 'true'::jsonb, true)
                      ELSE $18::jsonb END,
                 $19, $20, $21, $22, $23)`,
        [
          fact.id,
          orgId,
          fact.subject,
          fact.predicate,
          fact.object,
          identity.subjectKey,
          identity.predicateKey,
          identity.objectKey,
          identity.subjectCmp,
          identity.objectCmp,
          fact.validFrom ?? null,
          fact.validTo ?? null,
          fact.ingestedAt,
          fact.invalidatedAt ?? null,
          fact.extractedAt ?? null,
          episodeId,
          identity.comparableDropped,
          JSON.stringify(fact.provenance),
          // #5424 — `draft` when the payload names no person, the bundle's own
          // value otherwise. The ONLY column this route overrides on a
          // trust-tier judgement rather than restoring verbatim.
          demoteUnattributed ? "draft" : fact.status,
          fact.visibleTo,
          // `?? null` is the BUNDLE-VERSION fallback, not a permissive one: a
          // pre-#4836 bundle carries no RECORDED pre-widening grants, because
          // the source region had no column to record them in. Facts widened
          // in the #4823-to-0183 window therefore land disclosing — migration
          // 0183's accepted residual, reappearing for cross-region moves.
          fact.preWideningVisibleTo ?? null,
          fact.createdAt,
          fact.updatedAt,
          // $24 — appended rather than inserted beside `invalidated_at`'s $14,
          // which the CASE above reads. Renumbering the binds to put it there
          // would move every placeholder after it, and this statement's column
          // list and bind array are already the pair most exposed to that class
          // of slip.
          identity.tombstoned,
        ],
      );
      result.brainFacts.imported++;
    }
  }

  // The one identity-loss line, and it is not decoration: without it an expected
  // `entity:` drop, a tag vocabulary the two regions disagree about, and a
  // corpus of surfaces that norm away all present identically — a `200` with
  // healthy counts. `unreadable > 0` is the one an operator must act on; it
  // means the SOURCE region emitted something this one cannot read, and those
  // rows lost real evidence rather than following a rule.
  if (Object.values(identityLoss).some((n) => n > 0)) {
    log.warn(
      {
        orgId,
        bundleVersion: bundle.manifest.version,
        ...identityLoss,
        // The denominators the message tells the operator to divide by. Without
        // them `unreadablePositions: 412` is unreadable on its own, and the only
        // other place the fact count appears is the route's post-COMMIT info
        // line — which is never written at all if the import then fails.
        brainFactsImported: result.brainFacts.imported,
        comparablePositions: result.brainFacts.imported * 2,
      },
      "Region import WILL land identity losses when this transaction commits (#5035, ADR-0037 §8). `storeLocalPositions` is the RULE — a store-local entity id means nothing in this region, so those positions abstain until recomputed, and the rows carry `provenance.provisional` (find them with PROVISIONAL_PREDICATE). `unreadablePositions` is DRIFT and is the count to act on: the source region wrote a tag or payload this deployment cannot read, so that evidence is lost rather than deferred — check whether the two regions are on compatible releases. ⚠️ `tombstonedFacts` IS THE COUNT TO ACT ON FIRST (#5047): those facts had no identity at some position and the slot keys are NOT NULL, so they landed with a per-row placeholder key AND `invalidated_at` set — they are invisible to searchBrain and to the review queue, and no verb in the product restores them; only clearing `invalidated_at` by hand does. Their surfaces are retained verbatim, so the claim text is recoverable. Every one of them is a claim whose surface normalizes away (`-`, `___`), which is what migration 0194 did to the same population — a fact whose key merely FAILED TO ARRIVE while its surface keys fine refuses the whole import instead of landing (RegionImportUnkeyableError), because tombstoning a healthy belief and re-deriving its key under this region's vocabulary are both irreversible. `unkeyableFacts` counts those keyed HERE off a legacy bundle; `nullKeyFacts` counts those that arrived null on a v3 one. Units: the first two count POSITIONS, up to two per fact; the last three count FACTS",
    );
  }

  // Its own line rather than a key on the identity warning above, because it is
  // a different KIND of loss and the two are acted on differently: an identity
  // loss is repaired by recomputing keys, and this is repaired by a human
  // deciding whether the claim is worth publishing without a name on it.
  if (unattributedDemoted > 0) {
    log.warn(
      {
        orgId,
        bundleVersion: bundle.manifest.version,
        unattributedDemoted,
        brainFactsImported: result.brainFacts.imported,
      },
      "Region import landed brain facts as DRAFT that the bundle marked published, because their provenance names no person (#5424, finish condition 2: every authoritative claim has a human name on it, with no exception for claims that arrived by migration). The claims, their surfaces and their evidence imported verbatim — only the review status moved, and it is the one column this route does not restore verbatim. They are in the review queue: attribute them and publish, or leave them as drafts. The bundle was NOT refused, deliberately — validation is all-or-nothing, so refusing would strand the whole workspace in its source region at cutover",
    );
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

  return result;
}

/**
 * The post-`COMMIT` confirmation that turns "WILL DROP" into "DID DROP" (#5112).
 *
 * `mergeApprovedEdges` emits one `log.warn` per refusal in the FUTURE TENSE, and
 * that tense is correct: the merge is section 9 of ~13 inside the caller's
 * transaction, so the closure rebuild, the brain's identity refusal or any driver
 * error can still roll the whole import back — and then no edge was dropped
 * because none was applied. The cost of being correct there is that nothing ever
 * said the drop HAPPENED. An operator following the recovery path could not tell
 * a committed loss from a rolled-back attempt whose retry succeeded.
 *
 * ⚠️ CALLED AFTER `COMMIT`, NEVER INSIDE THE `try` BEFORE IT, and the position is
 * the whole content of the line. Moved one statement earlier it makes exactly the
 * over-report the future tense exists to avoid.
 *
 * `correlationId` is the same token the per-refusal lines carry, so the two line
 * sets join on one grep. The payloads are repeated rather than referenced: the
 * warns and this line can be separated by minutes of unrelated traffic, and a
 * confirmation that says only "the 3 lines above are real" is unreadable once
 * they are not above it.
 *
 * Silent when nothing was refused — a `refused: 0` confirmation would fire on
 * every import that carries a vocabulary and train an operator to skip the line.
 *
 * ## Why THIS side logs the payloads and the source side logs only counts
 *
 * A deliberate asymmetry, recorded because the two halves look inconsistent and a
 * later reader will otherwise "fix" one to match the other. In the TARGET region
 * the log IS the recovery path — this is the only process that ever holds the
 * refused edges, so a count here would discard the thing worth keeping. In the
 * SOURCE region (`residency/migrate.ts`) the payloads go to a DATABASE COLUMN and
 * the log carries counts, because that module's whole argument is that a log line
 * does not outlive the data it describes.
 *
 * The cost is real and accepted: these lines put customer-derived lexical norms and
 * approver user ids into this region's log stream, which is a retention surface. It
 * is the same data the region already holds in `brain_vocabulary_edge`, it is
 * bounded by the cap, and it fires only when a human decision was actually dropped.
 */
function logVocabularyRefusalsCommitted(
  correlationId: string,
  orgId: string,
  result: ImportResult,
): void {
  const { refused, refusalDetails } = result.brainVocabularyEdges;
  if (refused === 0) return;
  logRefusalConfirmation(correlationId, orgId, refused, refusalDetails);
}

/**
 * The confirmation's body, wrapped so it CANNOT fail the request (panel round 1).
 *
 * Both handlers call `logVocabularyRefusalsCommitted` inside the `try`, after
 * `COMMIT` — the position the confirmation's whole meaning depends on. The residual
 * that round 1 caught: a throw in that window (a pino transport EPIPE on a closed
 * stdout, a full transport buffer) lands in the catch, where `ROLLBACK`-after-COMMIT
 * succeeds, so `uncertain` is false and the handler answers **500 `import_failed`**
 * — whose message says the import did not take effect — for a transaction that
 * committed, refusals included. `transferBundleToTarget` then maps that 500 to
 * "Target region import failed", aborts the migration, and discards the very
 * refusal evidence it was about to persist.
 *
 * So the disclosure is made unable to invalidate the thing it discloses. Additive
 * rather than a restructure: hoisting the post-`COMMIT` statements out of the `try`
 * would need a new response code for "committed but reporting failed", which is new
 * machinery for a strictly worse outcome — the data DID land, and a 200 that lost
 * one log line is the honest answer.
 *
 * The catch logs at `error` and re-narrows, so the failure is never silent: what is
 * lost is the confirmation, and that loss is itself announced.
 */
function logRefusalConfirmation(
  correlationId: string,
  orgId: string,
  refused: number,
  refusalDetails: ImportResult["brainVocabularyEdges"]["refusalDetails"],
): void {
  try {
    emitRefusalConfirmation(correlationId, orgId, refused, refusalDetails);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), correlationId, orgId, refused },
      "Import COMMITTED and its refusal confirmation could not be emitted — the data landed and " +
        "the refusals ARE dropped; the per-refusal WILL DROP lines carrying this correlationId " +
        "are the surviving record",
    );
  }
}

function emitRefusalConfirmation(
  correlationId: string,
  orgId: string,
  refused: number,
  refusalDetails: ImportResult["brainVocabularyEdges"]["refusalDetails"],
): void {
  log.warn(
    {
      correlationId,
      orgId,
      refused,
      // Both numbers, always. `refused` is the truth and `refusalDetails` is
      // capped, so a reader who sees only the array reads a smaller loss than
      // happened. Naming the cap in the payload is what makes the difference
      // legible rather than looking like an inconsistency.
      detailsCarried: refusalDetails.length,
      detailCap: VOCABULARY_REFUSAL_DETAIL_CAP,
      refusalDetails,
    },
    "Vocabulary merge DID DROP arriving alias edges — the import COMMITTED, so this many " +
      "approved human review decisions are permanently not applied in this region. Every " +
      "preceding 'WILL DROP' line carrying this correlationId is now a fact. The source " +
      "region's own brain_vocabulary_edge rows are the recovery path and its cleanup deletes " +
      "them once the grace period expires; the same payloads are recorded on the source's " +
      "region_migrations row, which cleanup never touches.",
  );
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
  // Set ONLY when the ROLLBACK itself failed. FOUR readers: the client release,
  // the `uncertain` derivation below (which the response arm and the log message
  // both consume) and the log payload's `rolledBack`. See
  // {@link IMPORT_ROLLBACK_UNCERTAIN_MESSAGE} for why the release's question is
  // narrower than the body's.
  let rollbackErr: Error | undefined;
  // ⚠️ Set only once BEGIN has RESOLVED. Without it, a `pool.connect()` that
  // handed back a dead socket fails at BEGIN, the catch's ROLLBACK fails on the
  // same dead socket, `rollbackErr` is set — and the caller is told to
  // hand-inspect a workspace for an import that provably never started. The
  // uncertain body is expensive advice; it should only be given where the
  // uncertainty is real.
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const result = await importBundle(client, bundle, orgId, requestId);
    await client.query("COMMIT");

    logVocabularyRefusalsCommitted(requestId, orgId, result);
    log.info({ requestId, orgId, result }, "Migration import complete");
    return c.json(result, 200);
  } catch (err) {
    // ROLLBACK can itself fail (a TCP reset between BEGIN and ROLLBACK, `57P01`
    // admin shutdown, a statement timeout on the rollback, a pgbouncer-side
    // kill). `pg` destroys the socket when `release(err)` is called with a
    // truthy arg, so a poisoned client does not return to the pool to corrupt
    // the next borrower's transaction — `admin-revoke.ts`, `admin-mfa-reset.ts`,
    // `me-trusted-devices.ts` and `oauth-workspace-grants.ts` all do this and
    // this handler was the outlier.
    //
    // ⚠️ `log.error`, not `warn`: this line says a pooled connection may be
    // poisoned AND that a partial import's fate is unknown. It carries `orgId`
    // because it is the one line that names a possibly-corrupted workspace.
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.error(
        { err: rollbackErr, requestId, orgId },
        "ROLLBACK failed after import error — the client will be DESTROYED rather than pooled, and whether the transaction committed is UNKNOWN",
      );
    });
    // ⚠️ ONE derived answer, read by the log AND the body. Round 3 keyed the log
    // on `rollbackErr` alone while the body used `rollbackErr && begun`, so a
    // BEGIN that never resolved produced a log saying "the transaction's fate is
    // unknown" beside a body saying "all changes rolled back, nothing was
    // written" — the very contradiction the conditional message was added to
    // remove, reproduced between the two surfaces instead of between two lines.
    const uncertain = rollbackErr !== undefined && begun;
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        requestId,
        orgId,
        rolledBack: !uncertain,
      },
      // ⚠️ CONDITIONAL, because the unconditional wording contradicted the line
      // seven lines above it. An operator grepping one `requestId` would get two
      // `error` lines making opposite claims about the same transaction, and the
      // one that named the actual cause was the one that lied.
      uncertain
        ? "Migration import failed AND the ROLLBACK did not complete — see the line above; the transaction's fate is unknown"
        : "Migration import failed, rolled back",
    );
    // ⚠️ A FAILED ROLLBACK OUTRANKS THE DIAGNOSIS, and this check sits ABOVE the
    // 409 arm for that reason (round 3). The refusal's message ends "re-export
    // and re-run" and its OpenAPI description says NOTHING WAS WRITTEN — both
    // claims about the ROLLBACK, not about the error that triggered it. And the
    // refusals are raised in `importBundle`'s brain-facts section, AFTER
    // EVERY earlier section has already inserted into the open transaction. So a refusal
    // whose rollback failed is the uncertain state exactly, and answering it
    // with a confident 409 tells the operator to re-send over a possibly
    // committed partial import — the defect this arm exists to prevent, left
    // standing on the arm #5047 exists to serve.
    if (uncertain) {
      return c.json(
        { error: "import_rollback_uncertain", message: IMPORT_ROLLBACK_UNCERTAIN_MESSAGE, requestId },
        500,
      );
    }
    // A refused bundle is not a server fault (#5047). TWO causes with two
    // different remedies, and the `message` carries the right one: a v3 bundle
    // that supplied no identity for a keyable surface (source-side — re-export),
    // or a v1/v2 bundle this region's own vocabulary cannot key (destination-side
    // — fix the alias entry; re-exporting changes nothing). Naming only the first
    // here is the unfollowable advice #5047 removed from the error message and
    // from the OpenAPI description.
    //
    // 409 rather than 400 because the request itself is well-formed —
    // `validateBundle` passed — and rather than 500 because retrying THIS body
    // can never succeed and nothing here is broken.
    if (
      err instanceof RegionImportUnkeyableError ||
      err instanceof RegionImportVocabularyTargetError
    ) {
      // ⚠️ `err.message` is read HERE, inside the narrowed branch, and nowhere
      // else (#5106 round 2). An outer `const detail = …` in the catch's scope
      // was visible to the 500 return one line below — the exact leak #5106
      // closed, sitting in scope and guarded only by a comment. Narrowing the
      // read to the arm makes it unreachable rather than merely un-taken.
      //
      // Safe because BOTH constructors interpolate only a fact UUID and
      // position names — no surfaces, no row content, no connection detail.
      // That is a property of those constructors, not of this line: if either
      // ever interpolates a `cause`, the leak returns here silently.
      return c.json({ error: "import_refused", message: err.message, requestId }, 409);
    }
    // Reached TWO ways, and "nothing was written" is established on both: the
    // ROLLBACK completed, or it failed before BEGIN ever resolved — in which
    // case no statement ran at all and `begun === false` is the evidence, not
    // the rollback. An earlier cut of this line said simply "the rollback
    // SUCCEEDED", which is false on exactly the path `begun` was added to
    // create.
    return c.json({ error: "import_failed", message: IMPORT_FAILED_MESSAGE, requestId }, 500);
  } finally {
    // Truthy arg ⇒ `pg` destroys the socket instead of pooling it. No
    // `?? undefined`: this variable is already `Error | undefined`. (Contrast
    // `admin-archive.ts`, whose own is `Error | null` and genuinely needs it.)
    client.release(rollbackErr);
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
  // Set ONLY when the ROLLBACK itself failed. FOUR readers: the client release,
  // the `uncertain` derivation below (which the response arm and the log message
  // both consume) and the log payload's `rolledBack`. See
  // {@link IMPORT_ROLLBACK_UNCERTAIN_MESSAGE} for why the release's question is
  // narrower than the body's.
  let rollbackErr: Error | undefined;
  // ⚠️ Set only once BEGIN has RESOLVED. Without it, a `pool.connect()` that
  // handed back a dead socket fails at BEGIN, the catch's ROLLBACK fails on the
  // same dead socket, `rollbackErr` is set — and the caller is told to
  // hand-inspect a workspace for an import that provably never started. The
  // uncertain body is expensive advice; it should only be given where the
  // uncertainty is real.
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const result = await importBundle(client, bundle, orgId, requestId);
    await client.query("COMMIT");

    logVocabularyRefusalsCommitted(requestId, orgId, result);
    log.info({ requestId, orgId, result }, "Internal cross-region import complete");
    return c.json(result, 200);
  } catch (err) {
    // ROLLBACK can itself fail (a TCP reset between BEGIN and ROLLBACK, `57P01`
    // admin shutdown, a statement timeout on the rollback, a pgbouncer-side
    // kill). `pg` destroys the socket when `release(err)` is called with a
    // truthy arg, so a poisoned client does not return to the pool to corrupt
    // the next borrower's transaction — `admin-revoke.ts`, `admin-mfa-reset.ts`,
    // `me-trusted-devices.ts` and `oauth-workspace-grants.ts` all do this and
    // this handler was the outlier.
    //
    // ⚠️ `log.error`, not `warn`: this line says a pooled connection may be
    // poisoned AND that a partial import's fate is unknown. It carries `orgId`
    // because it is the one line that names a possibly-corrupted workspace.
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.error(
        { err: rollbackErr, requestId, orgId },
        "ROLLBACK failed after import error — the client will be DESTROYED rather than pooled, and whether the transaction committed is UNKNOWN",
      );
    });
    // ⚠️ ONE derived answer, read by the log AND the body. Round 3 keyed the log
    // on `rollbackErr` alone while the body used `rollbackErr && begun`, so a
    // BEGIN that never resolved produced a log saying "the transaction's fate is
    // unknown" beside a body saying "all changes rolled back, nothing was
    // written" — the very contradiction the conditional message was added to
    // remove, reproduced between the two surfaces instead of between two lines.
    const uncertain = rollbackErr !== undefined && begun;
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        requestId,
        orgId,
        rolledBack: !uncertain,
      },
      // ⚠️ CONDITIONAL, because the unconditional wording contradicted the line
      // seven lines above it. An operator grepping one `requestId` would get two
      // `error` lines making opposite claims about the same transaction, and the
      // one that named the actual cause was the one that lied.
      uncertain
        ? "Internal import failed AND the ROLLBACK did not complete — see the line above; the transaction's fate is unknown"
        : "Internal import failed, rolled back",
    );
    // ⚠️ A FAILED ROLLBACK OUTRANKS THE DIAGNOSIS, and this check sits ABOVE the
    // 409 arm for that reason (round 3). The refusal's message ends "re-export
    // and re-run" and its OpenAPI description says NOTHING WAS WRITTEN — both
    // claims about the ROLLBACK, not about the error that triggered it. And the
    // refusals are raised in `importBundle`'s brain-facts section, AFTER
    // EVERY earlier section has already inserted into the open transaction. So a refusal
    // whose rollback failed is the uncertain state exactly, and answering it
    // with a confident 409 tells the operator to re-send over a possibly
    // committed partial import — the defect this arm exists to prevent, left
    // standing on the arm #5047 exists to serve.
    if (uncertain) {
      return c.json(
        { error: "import_rollback_uncertain", message: IMPORT_ROLLBACK_UNCERTAIN_MESSAGE, requestId },
        500,
      );
    }
    // A refused bundle is not a server fault (#5047). TWO causes with two
    // different remedies, and the `message` carries the right one: a v3 bundle
    // that supplied no identity for a keyable surface (source-side — re-export),
    // or a v1/v2 bundle this region's own vocabulary cannot key (destination-side
    // — fix the alias entry; re-exporting changes nothing). Naming only the first
    // here is the unfollowable advice #5047 removed from the error message and
    // from the OpenAPI description.
    //
    // 409 rather than 400 because the request itself is well-formed —
    // `validateBundle` passed — and rather than 500 because retrying THIS body
    // can never succeed and nothing here is broken.
    if (
      err instanceof RegionImportUnkeyableError ||
      err instanceof RegionImportVocabularyTargetError
    ) {
      // ⚠️ `err.message` is read HERE, inside the narrowed branch, and nowhere
      // else (#5106 round 2). An outer `const detail = …` in the catch's scope
      // was visible to the 500 return one line below — the exact leak #5106
      // closed, sitting in scope and guarded only by a comment. Narrowing the
      // read to the arm makes it unreachable rather than merely un-taken.
      //
      // Safe because BOTH constructors interpolate only a fact UUID and
      // position names — no surfaces, no row content, no connection detail.
      // That is a property of those constructors, not of this line: if either
      // ever interpolates a `cause`, the leak returns here silently.
      return c.json({ error: "import_refused", message: err.message, requestId }, 409);
    }
    // Reached TWO ways, and "nothing was written" is established on both: the
    // ROLLBACK completed, or it failed before BEGIN ever resolved — in which
    // case no statement ran at all and `begun === false` is the evidence, not
    // the rollback. An earlier cut of this line said simply "the rollback
    // SUCCEEDED", which is false on exactly the path `begun` was added to
    // create.
    return c.json({ error: "import_failed", message: IMPORT_FAILED_MESSAGE, requestId }, 500);
  } finally {
    // Truthy arg ⇒ `pg` destroys the socket instead of pooling it. No
    // `?? undefined`: this variable is already `Error | undefined`. (Contrast
    // `admin-archive.ts`, whose own is `Error | null` and genuinely needs it.)
    client.release(rollbackErr);
  }
});
