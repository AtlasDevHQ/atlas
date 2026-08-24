/**
 * Admin semantic entity editor routes.
 *
 * Registered directly on the admin router (not as a subrouter) to avoid
 * middleware conflicts with existing /semantic/* routes. Provides structured
 * JSON endpoints for creating, updating, and deleting semantic entities
 * from the web editor.
 *
 * These complement the existing raw-YAML endpoints at /semantic/org/entities/
 * by accepting structured JSON (for the form-based editor) rather than
 * raw YAML strings.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
// Statically, from `lib/effect/errors` rather than through the dynamic
// `lib/semantic/entities` import below — the same reason `api/routes/semantic.ts`
// does it: the entity module is `mock.module`'d by a lot of suites, and reaching
// the class through it would make every one of them add a stub to keep an
// `instanceof` from silently evaluating false. `entities.ts` re-exports THIS
// class, so the two spellings are the same identity.
import { AmbiguousEntityError } from "@atlas/api/lib/effect/errors";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { connections } from "@atlas/api/lib/db/connection";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { noActiveOrgBody } from "./admin-router";

const log = createLogger("admin-semantic-editor");

// ---------------------------------------------------------------------------
// Zod schemas — column metadata
// ---------------------------------------------------------------------------

const ColumnInfoSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean(),
});

const ColumnsResponseSchema = z.object({
  columns: z.array(ColumnInfoSchema),
});

// ---------------------------------------------------------------------------
// Zod schemas — structured entity data
// ---------------------------------------------------------------------------

const DimensionSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.enum(["string", "number", "date", "boolean", "timestamp"]),
  description: z.string().optional().default(""),
  sample_values: z.array(z.string()).optional().default([]),
  primary_key: z.boolean().optional(),
  foreign_key: z.boolean().optional(),
  /**
   * ⚠️ THE ONE DIMENSION KEY WHOSE LOSS IS A FALSE STATEMENT, not merely a
   * thinner one (#5402). A virtual dimension is a computed EXPRESSION, not a
   * column — `CASE WHEN plan_tier IN (…) THEN true ELSE false END`. Dropping
   * the flag makes the layer assert that expression is a real column of the
   * table, which `search.ts` then formats to the agent as one
   * (`dimensions.filter((d) => !d.virtual)` is the split it drives).
   *
   * Every OTHER unmanaged dimension key (`unique_count`, `indexed`,
   * `index_type`, `filter_hint`, …) survives by preservation rather than by
   * being modelled here — see {@link mergeEntityDocument}.
   */
  virtual: z.boolean().optional(),
});

const MeasureSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.enum(["count", "sum", "avg", "count_distinct", "min", "max"]),
  description: z.string().optional().default(""),
});

/**
 * `joins[]` in the SQL editor's own shape: a named join with a raw ON clause.
 */
const SqlJoinSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  description: z.string().optional().default(""),
});

/**
 * `joins[]` in the shape the LAYER actually writes — `target_entity` /
 * `relationship` / `join_columns`, the vocabulary both entity-YAML renderers
 * speak (`@useatlas/schemas/semantic-entity-yaml`) and the one `search.ts`
 * reads (#5402).
 *
 * ⚠️ Before this existed, `JoinSchema` required `name` AND `sql`, both
 * `.min(1)` — so a relationship-shaped join (which carries NEITHER) was a 400
 * on the way in, and the six real joins on the dogfood `organization` entity
 * could not survive a structured edit at all.
 *
 * `relationship` is a free string, not an enum, and OPTIONAL — `target_entity`
 * alone identifies this member. Both choices are about not rejecting documents
 * the layer already stores: the generator emits `many_to_one`, the OKF importer
 * accepts whatever the source declared, and a join that names a target without
 * declaring cardinality is thinner than ideal but real. An enum, or a required
 * `relationship`, would turn "this entity is stored in a shape I dislike" into
 * "this entity cannot be saved", which is worse than the loss being fixed.
 *
 * ⚠️ A join matching NEITHER member (no `name`+`sql`, no `target_entity`) is a
 * 422 naming the field. That is the "refuse" half of the issue's requirement —
 * *preserve them or refuse with a message naming what it cannot represent* —
 * and it is a deliberate outcome, not an oversight: silent loss is the one
 * result ruled out, and a join with no target in any vocabulary is not
 * something this route can honestly store.
 */
const RelationshipJoinSchema = z.object({
  target_entity: z.string().min(1),
  relationship: z.string().min(1).optional(),
  join_columns: z.record(z.string(), z.string()).optional(),
  description: z.string().optional().default(""),
});

/**
 * ⚠️ A UNION, tried in order, and the two members are structurally disjoint —
 * `name`+`sql` vs `target_entity`+`relationship` — so no document can match
 * both and the order cannot silently reshape a join.
 */
const JoinSchema = z.union([SqlJoinSchema, RelationshipJoinSchema]);

const QueryPatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  sql: z.string().min(1),
});

/**
 * The structured editor's wire body.
 *
 * ⚠️ EXPORTED for one reason: `__tests__/entity-body-schema-parity.test.ts`
 * enumerates its keys against `EntityShape`'s, so a key added to the semantic
 * layer cannot become silently unrepresentable in the editor (#5402). Nothing
 * else should import it.
 */
export const EntityBodySchema = z.object({
  table: z.string().min(1),
  // ⚠️ NO `.default()` on any section (#5402). A default collapses the two
  // cases the write has to tell apart: the key ABSENT (a caller that does not
  // model this section — preserve what is stored) and the key sent EMPTY (a
  // caller deleting the section — clear it). `.default([])` made every absent
  // section read as a deletion, which is how a UI that cannot render
  // relationship joins silently deleted them.
  description: z.string().optional(),
  dimensions: z.array(DimensionSchema).optional(),
  measures: z.array(MeasureSchema).optional(),
  joins: z.array(JoinSchema).optional(),
  query_patterns: z.array(QueryPatternSchema).optional(),
  // ── Entity-level keys the layer defines (#5402) ──────────────────────────
  //
  // ⚠️ These are here so the editor can REPRESENT them, and the parity guard in
  // `__tests__/entity-body-schema-parity.test.ts` is what keeps the list honest
  // as the layer grows. They are all optional and all preserve-on-absent: a
  // body that omits `filter` keeps the stored `filter` rather than clearing it
  // (see {@link mergeEntityDocument}), because the FE that omits a key is
  // usually one that has never heard of it.
  //
  // `filter` is the key that exposed the divergence: v0.2.16 shipped it into
  // `EntityShape` and the warehouse producer, and the editor silently stripped
  // it on the next read-modify-write (#5329, #5402).
  filter: z.string().optional(),
  type: z.string().optional(),
  grain: z.string().optional(),
  use_cases: z.array(z.string()).optional(),
  identifier_style: z.enum(["sql", "opaque"]).optional(),
  // Connection-id scope: the write resolves this id → its group_id via
  // `inlineConnectionGroupSql`. Mutually exclusive with `connectionGroupId`
  // (see below) — sending both is a 400, never a silent resolution (#3854).
  // `""` is treated as absent (an empty id resolves to no connection),
  // unlike `connectionGroupId` where `""` is the explicit legacy-null group.
  connectionId: z.string().optional(),
  // Group scope for multi-environment orgs (#2412). When the entity name
  // exists in more than one group, the FE must pick one or the backend
  // will 409. Empty string deliberately encodes "legacy null-group" so
  // a workspace mixing `__global__` demo rows with named-group rows can
  // still address the demo row explicitly.
  //
  // Precedence vs `connectionId` (#3854): the two are MUTUALLY EXCLUSIVE.
  // Providing `connectionGroupId` writes the row under that group DIRECTLY
  // (via `upsertDraftEntityForGroup`); providing `connectionId` resolves the
  // group from the connection. Sending BOTH is rejected with 400 rather than
  // silently picking one — they can disagree, and guessing hides bugs.
  connectionGroupId: z.string().optional(),
});

export type EntityBody = z.infer<typeof EntityBodySchema>;

const EntityResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  entityType: z.string(),
});

// ---------------------------------------------------------------------------
// Zod schemas — version history
// ---------------------------------------------------------------------------

const VersionSummarySchema = z.object({
  id: z.string(),
  versionNumber: z.number(),
  changeSummary: z.string().nullable(),
  authorId: z.string().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string(),
});

const VersionListResponseSchema = z.object({
  versions: z.array(VersionSummarySchema),
  total: z.number(),
});

const VersionDetailSchema = VersionSummarySchema.extend({
  name: z.string(),
  entityType: z.string(),
  yamlContent: z.string(),
});

const VersionDetailResponseSchema = z.object({
  version: VersionDetailSchema,
});

const RollbackBodySchema = z.object({
  versionId: z.string().uuid(),
  // Group scope for multi-environment orgs (#2412). Empty string →
  // legacy null-group row. Missing → backend disambiguates or 409s.
  connectionGroupId: z.string().optional(),
});

const RollbackResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  versionNumber: z.number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode the `?connectionGroupId=<value>` query param (#2412).
 *
 * - Missing param → `undefined` → backend uses unique-or-409 default.
 * - Empty string `?connectionGroupId=` → `null` → match legacy null-scope row.
 * - Non-empty string → that group id.
 *
 * This mirrors the mapping in `admin.ts`'s GET handler so a single
 * vocabulary holds across every editor route.
 */
function parseConnectionGroupIdQuery(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "") return null;
  return raw;
}

/**
 * Where a caller may put `connectionGroupId` on a given verb — the 409's
 * remediation advice, in a field a client can act on (#5413).
 *
 * ## Why this is not just prose
 *
 * `getEntity`'s message is `Entity "X" exists in N environments. Pass
 * connectionGroupId to disambiguate.` It names the parameter and NOT its
 * location, and the obvious reading was wrong: the `DELETE` on this same path
 * documents `?connectionGroupId=<group>` as a query parameter, while the `PUT`
 * read it only from the JSON body — so a caller who followed the sibling
 * verb's convention got the IDENTICAL 409 back and reasonably concluded the
 * group name was wrong rather than the location. Measured on prod `us`,
 * 2026-08-24: `?connectionGroupId=g_prod` → 409, the same body → 200.
 *
 * ⭐ Remediation copy that names a parameter but not its location is only
 * useful where the API is already consistent about location, and here one path
 * was not consistent with itself. Both halves of the fix are needed: the `PUT`
 * now accepts the query string too, so the two verbs agree, and the refusal
 * says so in a field rather than leaving a client to guess from prose.
 *
 * The message is rebuilt here rather than in `entities.ts` because the LOCATION
 * is a property of the route, not of the lookup — `entities.ts` is called by
 * six surfaces with different request shapes, and a message naming a body there
 * would be wrong on most of them.
 */
const DISAMBIGUATION_PARAM = "connectionGroupId" as const;

/** Accepted locations for {@link DISAMBIGUATION_PARAM}, per verb. */
type DisambiguationLocation = "query" | "body";

/**
 * The one spelling of "where to put it", shared by the 409 BODY the handler
 * returns and the 409 DESCRIPTION the spec publishes.
 *
 * Both used to spell it out by hand, which is how the two drift: the prose in
 * `responses[409].description` is what a caller reads in the docs, and
 * `disambiguateWith.in` is what a client branches on. #5413 exists because
 * remediation advice and the handler disagreed once already — deriving both
 * from the same `accepts` array is what stops that being possible again.
 */
function disambiguationLocationProse(
  accepts: readonly DisambiguationLocation[],
): string {
  return accepts
    .map((loc) =>
      loc === "query"
        ? `\`?${DISAMBIGUATION_PARAM}=<group>\` in the query string`
        : `\`${DISAMBIGUATION_PARAM}\` in the JSON body`,
    )
    .join(" or ");
}

function ambiguousEntityBody(
  err: AmbiguousEntityError,
  requestId: string | undefined,
  accepts: readonly DisambiguationLocation[],
): EntityAmbiguousBody {
  const where = disambiguationLocationProse(accepts);
  return {
    error: "entity_ambiguous",
    message:
      `Entity "${err.entityName}" exists in ${err.groups.length} environments. ` +
      `Pass ${where} to disambiguate — one of: ${err.groups.map((g) => g ?? "(none)").join(", ")}.`,
    groups: [...err.groups],
    entityName: err.entityName,
    entityType: err.entityType,
    // The machine-readable half. A client picks a group from `groups` and needs
    // to know where to send it back; without this it can only re-read the prose.
    disambiguateWith: { parameter: DISAMBIGUATION_PARAM, in: [...accepts] },
    requestId,
  };
}

/**
 * The 409 wire shape, shared by both verbs on `/entities/edit/{name}`.
 *
 * Declared as a response on BOTH routes deliberately: the status was reachable
 * on each of them long before #5413 — through `runHandler`'s tagged-error
 * mapping, which Hono does not validate against `responses` — so the published
 * spec documented a 409 on neither. A status a caller must handle and cannot
 * find in the spec is how #5413's caller ended up guessing.
 */
const EntityAmbiguousSchema = z.object({
  error: z.literal("entity_ambiguous"),
  message: z.string(),
  /** The candidate `connection_group_id`s; `null` is the legacy unscoped group. */
  groups: z.array(z.string().nullable()),
  entityName: z.string(),
  entityType: z.string(),
  /** Where to send the chosen group back — the advice, machine-readable (#5413). */
  disambiguateWith: z.object({
    parameter: z.literal(DISAMBIGUATION_PARAM),
    in: z.array(z.enum(["query", "body"])),
  }),
  requestId: z.string().optional(),
});

/**
 * The 409's TS shape, inferred from the schema rather than written twice.
 *
 * Hono does not validate responses, so `ambiguousEntityBody` returning
 * `Record<string, unknown>` would let a field be renamed or dropped and still
 * compile — with the published spec still promising it. Typing the builder's
 * return against the schema is the only thing that makes the two agree.
 */
type EntityAmbiguousBody = z.infer<typeof EntityAmbiguousSchema>;

/**
 * The 409's OpenAPI `responses` entry, built from the SAME `accepts` array the
 * handler passes to {@link ambiguousEntityBody}.
 *
 * Three routes declare this status and each one's prose was written out by
 * hand, identical but for the trailing location clause — the exact shape that
 * lets the published description say "the query string" while the handler
 * answers `in: ["body"]`. The schema was already shared; this shares the
 * sentence, so a verb that changes where it accepts the parameter changes both
 * halves or neither.
 */
function ambiguousEntityResponse(accepts: readonly DisambiguationLocation[]) {
  return {
    description:
      "The entity name exists in more than one connection group and the request named none. " +
      "Nothing was written (#5412) — the ambiguity is resolved before any persistence. " +
      "`groups` carries the candidates and `disambiguateWith` says where to send the one you " +
      `pick — for this verb, ${disambiguationLocationProse(accepts)} (#5413).`,
    content: { "application/json": { schema: EntityAmbiguousSchema } },
  };
}

/**
 * Resolve an entity, turning a cross-group ambiguity into a VALUE the caller
 * must handle rather than an exception that escapes — so the refusal happens
 * before anything is written (#5412) and can carry `disambiguateWith` (#5413).
 *
 * ## Why both verbs go through this and neither writes first
 *
 * `PUT /entities/edit/{name}` used to return 409 `entity_ambiguous` and persist
 * a draft anyway, in a group the caller never named. ⚠️ **A refusal that
 * persists is worse than either outcome on its own**: the caller reads 409 and
 * reasonably believes nothing happened, so nobody goes looking for the row —
 * and `POST /admin/publish` is "publish all drafts" with no id selection, so
 * the next publish promotes it. There is no discard path for a semantic-entity
 * draft. Routing every entity lookup that precedes a write through here is what
 * makes "the check runs first" structural instead of a thing to remember.
 *
 * ## Why it is caught here rather than left to `runHandler`
 *
 * `runHandler`'s tagged-error mapping already turns `AmbiguousEntityError` into
 * a 409 with its candidate `groups`, and that is most of the answer. What it
 * cannot add is WHERE to send the group back: the mapping is shared by six
 * surfaces with different request shapes, and the location is a property of the
 * route. So the status is the same and the body is richer — see
 * {@link ambiguousEntityBody} for what went wrong without it.
 *
 * Every other error propagates untouched; only the ambiguity is a value.
 */
async function readEntityOrAmbiguous<T>(
  // Structural, not `typeof import(…).getEntity`: this module's tests replace
  // `lib/semantic/entities` wholesale via `mock.module`, and a type-only
  // reference to the real export would describe the module the tests removed.
  // It mirrors the real signature INCLUDING the trailing `mode`, which the
  // mocks declare — dropping it made this parameter narrower than every value
  // ever passed to it.
  getEntity: (
    orgId: string,
    entityType: "entity",
    name: string,
    connectionGroupId?: string | null,
    mode?: "developer" | "published",
  ) => Promise<T>,
  orgId: string,
  name: string,
  scope: string | null | undefined,
): Promise<{ ok: true; entity: T } | { ok: false; err: AmbiguousEntityError }> {
  try {
    return { ok: true, entity: await getEntity(orgId, "entity", name, scope) };
  } catch (err) {
    if (err instanceof AmbiguousEntityError) return { ok: false, err };
    throw err;
  }
}

/**
 * Which connection group a write with no `connectionId` lands in — the #5412
 * rule, in one statement, for every verb that has to answer it.
 *
 * 1. The request named a group → that group. `null` is a real answer here
 *    (`?connectionGroupId=` / `""` means the legacy unscoped group), which is
 *    why the test is `!== undefined` and not a truthiness check.
 * 2. It named none and the entity already exists → **the group it already
 *    lives in.** This is the fix. Falling through to `null` put the draft in a
 *    group the caller never named and the entity was not in, which made a
 *    single-group name span two groups — so the very next read raised
 *    `entity_ambiguous` about a state the request itself had just created, and
 *    left the row behind while reporting a refusal.
 * 3. It named none and the entity is new → the legacy null scope, which is
 *    what an unscoped create has always meant.
 *
 * Case 2 is reached only after {@link readEntityOrAmbiguous} resolved the name
 * to exactly one group — two or more already returned 409 — so "the group it
 * lives in" is never a guess between candidates.
 *
 * Shared by the editor `PUT` and `POST /entities/{name}/rollback`, which had
 * the same rule in two spellings. One expression is what keeps the second verb
 * from drifting back: rollback carried the *old* behaviour (always the null
 * group) long after the PUT was fixed, and nothing but a shared call site would
 * have made that visible.
 */
function resolveTargetGroup(
  scope: string | null | undefined,
  existing: { connection_group_id?: string | null } | null | undefined,
): string | null {
  if (scope !== undefined) return scope;
  return existing?.connection_group_id ?? null;
}

/**
 * Entity-level keys `entityToYaml` OWNS — it writes each of these from the
 * request body, so the body is the authority on their value.
 *
 * ⚠️ EVERY OTHER top-level key in the stored document is PRESERVED verbatim
 * (#5402). This list is therefore the exhaustive statement of what a structured
 * PUT can change, and its complement is the (open-ended) set of what it must
 * never touch — `indexes`, `name`, and whatever the layer grows next.
 */
/**
 * The scalar/list entity keys the body may set directly: absent preserves the
 * stored value, `""` clears, anything else wins.
 *
 * ⚠️ ONE list, spread into {@link EDITOR_MANAGED_ENTITY_KEYS} below and iterated
 * by `entityToYaml`. Written out twice, a key could be *managed* (so excluded
 * from preservation) without being *written* (so absent from the output) — which
 * is silent deletion wearing the fix's own clothes. `entity-body-schema-parity`
 * asserts this list against `EntityBodySchema` so a new body field cannot be
 * accepted on the wire and then dropped on the floor.
 */
export const CARRIED_ENTITY_KEYS = [
  "type",
  "grain",
  "filter",
  "identifier_style",
  "use_cases",
] as const;

export const EDITOR_MANAGED_ENTITY_KEYS = [
  "table",
  "description",
  ...CARRIED_ENTITY_KEYS,
  "dimensions",
  "measures",
  "joins",
  "query_patterns",
] as const;

/**
 * Dimension keys the editor writes; every other key on a stored dimension is
 * preserved by name.
 *
 * ⚠️ THREE OF THESE ARE BOOLEAN FLAGS THE FRONTEND NEVER SENDS — `primary_key`,
 * `foreign_key` and `virtual`. Being "managed" would ordinarily mean the body is
 * the authority, but a body that has never heard of a flag is not asserting it
 * is false. Left as plain managed keys they were dropped by exactly the
 * mechanism #5402 is about: the serializer writes them only when truthy, and
 * being in this set excludes them from the preservation loop, so a UI edit
 * silently un-flagged the primary key of every entity it touched.
 *
 * {@link DIMENSION_FLAG_KEYS} carries the `body ?? stored` fallback that makes
 * absence mean "unchanged" and an explicit `false` mean "cleared".
 */
const EDITOR_MANAGED_DIMENSION_KEYS = new Set([
  "name", "sql", "type", "description", "sample_values", "primary_key", "foreign_key", "virtual",
]);

/**
 * The dimension booleans that preserve on absence. Derived as a list rather than
 * written out at each use so the fallback cannot be given to two of the three
 * and forgotten on the fourth — which is how `primary_key` and `foreign_key`
 * were missed when `virtual` got it.
 */
const DIMENSION_FLAG_KEYS = ["primary_key", "foreign_key", "virtual"] as const;

/**
 * Parse the entity's PREVIOUS YAML so the write can preserve what it does not
 * manage. A document that will not parse (or is not a mapping) yields `null` —
 * preserving nothing, which is exactly the old behavior for that case.
 *
 * ⚠️ Non-fatal by design: a malformed stored document must not make the entity
 * uneditable. The parse failure is LOGGED (never swallowed) because the operator
 * is about to lose keys they cannot see.
 */
function parsePreviousEntity(
  yaml: typeof import("js-yaml"),
  previousYaml: string | null,
  ctx: { requestId: string; orgId: string; name: string },
): Record<string, unknown> | null {
  if (!previousYaml) return null;
  try {
    const doc = yaml.load(previousYaml);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      log.warn(ctx, "Previous entity YAML is not a mapping — unmanaged keys cannot be preserved");
      return null;
    }
    return doc as Record<string, unknown>;
  } catch (err) {
    log.warn(
      { ...ctx, err: err instanceof Error ? err.message : String(err) },
      "Previous entity YAML did not parse — unmanaged keys cannot be preserved on this write",
    );
    return null;
  }
}

/**
 * Convert structured entity data to a YAML string, PRESERVING everything the
 * editor does not manage.
 *
 * ⚠️ **THIS USED TO REBUILD THE DOCUMENT FROM SIX KEYS AND DISCARD THE REST,
 * silently (#5402).** Measured against the real dogfood `organization` entity, a
 * single structured PUT dropped `filter` (the #5329 key), `type`, `grain`, six
 * `use_cases`, and `virtual: true` on four dimensions — no 400, no warning. The
 * editor was the surface the admin UI writes through, so a read-modify-write to
 * change one description quietly degraded the document to the editor's own
 * vocabulary.
 *
 * The fix is preservation, not a longer field list: a longer list is the same
 * bug with a later trigger date, and `filter` is the proof — it was the first
 * entity-level key added since this function was written and it diverged
 * immediately. The list-vs-list hazard is separately held closed by the parity
 * guard in `__tests__/entity-body-schema-parity.test.ts`.
 *
 * ⚠️ **PRESERVE-ON-ABSENT MEANS THE STRUCTURED EDITOR CANNOT DELETE AN
 * UNMANAGED KEY.** That is deliberate and it is the honest trade: the FE that
 * omits a key is overwhelmingly one that has never heard of it, not one asking
 * for its removal. Deleting a key is the raw-YAML route's job —
 * `PUT /api/v1/admin/semantic/org/entities/{name}` takes the whole document as
 * a string and stores it verbatim (`admin.ts`, `putOrgEntityRoute`).
 *
 * ⚠️ **ABSENT ≠ EMPTY, for every section.** A body with no `joins` key keeps the
 * stored joins; a body with `joins: []` deletes them. That distinction is the
 * only thing separating "this FE does not model joins" from "the operator
 * removed the joins", and collapsing it (which `.default([])` did) always
 * resolves in favour of deletion.
 *
 * @param entity        the validated structured body
 * @param previousYaml  the stored document being replaced, or null on create
 */
async function entityToYaml(
  entity: EntityBody,
  previousYaml: string | null,
  ctx: { requestId: string; orgId: string; name: string },
): Promise<string> {
  const yaml = await import("js-yaml");
  const previous = parsePreviousEntity(yaml, previousYaml, ctx);

  // Build the object in the canonical YAML order
  const obj: Record<string, unknown> = {
    table: entity.table,
  };
  const description = entity.description ?? previous?.description;
  if (description) {
    obj.description = description;
  }
  // Entity-level keys the layer defines. `??` not `||`: only `undefined` (the
  // key absent from the body) falls through to the stored document.
  //
  // An explicitly-sent `""` is a value the caller chose, and it means CLEAR —
  // dropped rather than written. Writing it would put `filter: ""` into the
  // document, and an empty predicate is not a narrower entity, it is a broken
  // SQL fragment the warehouse producer would interpolate.
  for (const key of CARRIED_ENTITY_KEYS) {
    const value = entity[key] ?? previous?.[key];
    if (value !== undefined && value !== null && value !== "") obj[key] = value;
  }
  if (entity.dimensions === undefined) {
    if (previous?.dimensions !== undefined) obj.dimensions = previous.dimensions;
  } else if (entity.dimensions.length > 0) {
    // Unmanaged dimension keys are preserved BY NAME. `unique_count`,
    // `indexed`, `index_type` and `filter_hint` are all profiler-emitted and
    // none of them appear in `DimensionSchema`, so without this a structured
    // edit strips the profiler's work off every dimension it rewrites.
    const previousDims = new Map<string, Record<string, unknown>>();
    if (Array.isArray(previous?.dimensions)) {
      for (const d of previous.dimensions as unknown[]) {
        if (d && typeof d === "object" && !Array.isArray(d)) {
          const rec = d as Record<string, unknown>;
          if (typeof rec.name === "string") previousDims.set(rec.name, rec);
        }
      }
    }
    obj.dimensions = entity.dimensions.map((d) => {
      const dim: Record<string, unknown> = {
        name: d.name,
        sql: d.sql,
        type: d.type,
      };
      if (d.description) dim.description = d.description;
      if (d.sample_values && d.sample_values.length > 0) dim.sample_values = d.sample_values;
      const prior = previousDims.get(d.name);
      // Each flag is MODELLED, so the body wins when it says anything at all —
      // including `false`, which is how a dimension stops being virtual or stops
      // being the primary key. Absent falls through to the stored value.
      for (const flag of DIMENSION_FLAG_KEYS) {
        if ((d[flag] ?? prior?.[flag]) === true) dim[flag] = true;
      }
      if (prior) {
        for (const [key, value] of Object.entries(prior)) {
          // `Object.hasOwn`, not `key in dim`: `in` walks the prototype chain, so
          // a document with a `constructor:` or `toString:` key would be judged
          // "already present" and silently dropped — the very class this loop
          // exists to close.
          if (!EDITOR_MANAGED_DIMENSION_KEYS.has(key) && !Object.hasOwn(dim, key)) dim[key] = value;
        }
      }
      return dim;
    });
  }
  if (entity.measures === undefined) {
    if (previous?.measures !== undefined) obj.measures = previous.measures;
  } else if (entity.measures.length > 0) {
    obj.measures = entity.measures.map((m) => {
      const measure: Record<string, unknown> = {
        name: m.name,
        sql: m.sql,
        type: m.type,
      };
      if (m.description) measure.description = m.description;
      return measure;
    });
  }
  if (entity.joins === undefined) {
    if (previous?.joins !== undefined) obj.joins = previous.joins;
  } else if (entity.joins.length > 0) {
    // Each join is emitted in the SHAPE IT ARRIVED IN — the union in
    // `JoinSchema` has two disjoint members and neither is rewritten into the
    // other. Rewriting a relationship join into `name`/`sql` would be exactly
    // the silent reinterpretation this whole change exists to stop.
    obj.joins = entity.joins.map((j) => {
      const join: Record<string, unknown> = { };
      if ("target_entity" in j) {
        join.target_entity = j.target_entity;
        if (j.relationship) join.relationship = j.relationship;
      } else {
        join.name = j.name;
        join.sql = j.sql;
      }
      if ("join_columns" in j && j.join_columns) join.join_columns = j.join_columns;
      if (j.description) join.description = j.description;
      return join;
    });
  }
  if (entity.query_patterns === undefined) {
    if (previous?.query_patterns !== undefined) obj.query_patterns = previous.query_patterns;
  } else if (entity.query_patterns.length > 0) {
    obj.query_patterns = entity.query_patterns.map((p) => {
      const pattern: Record<string, unknown> = {
        name: p.name,
        sql: p.sql,
      };
      if (p.description) pattern.description = p.description;
      return pattern;
    });
  }

  // ⚠️ LAST, and it is the whole fix: every top-level key of the stored
  // document that the editor does not manage is carried across untouched, in
  // its original relative order, after the managed block. A key the editor has
  // never heard of survives a structured edit by construction rather than by
  // someone remembering to add it here.
  //
  // ⚠️ THIS INCLUDES `group:` / `connection:`, which the BODY deliberately
  // refuses — and the two are not in tension, because they answer different
  // questions. *May a client assert this row's scope?* No: a body-supplied
  // `group` can disagree with the row the write lands in, which is why #3854
  // rejects that pair rather than guessing. *May a stored document keep the
  // scope it already declares?* Yes — it is the scope of the row being read and
  // rewritten, disk-based layers resolve entity scope from it (ADR-0012), and
  // dropping it here would be a fresh instance of exactly this bug.
  if (previous) {
    const managed = new Set<string>(EDITOR_MANAGED_ENTITY_KEYS);
    for (const [key, value] of Object.entries(previous)) {
      // `Object.hasOwn`, not `key in obj` — see the dimension loop above.
      if (!managed.has(key) && !Object.hasOwn(obj, key)) obj[key] = value;
    }
  }

  return yaml.dump(obj, { lineWidth: 120, noRefs: true });
}

// ---------------------------------------------------------------------------
// Route definitions (exported for registration on parent admin router)
// ---------------------------------------------------------------------------

export const putStructuredEntityRoute = createRoute({
  method: "put",
  path: "/semantic/entities/edit/{name}",
  tags: ["Admin — Semantic"],
  summary: "Create or update a semantic entity (structured)",
  description:
    "Accepts structured entity JSON (table, dimensions, measures, joins, query_patterns), " +
    "converts to YAML, and stores in the org-scoped semantic_entities table. " +
    "Triggers semantic index rebuild for the workspace. " +
    "Scope the write with `connectionGroupId` when the same entity name exists in multiple " +
    "environments — accepted BOTH as `?connectionGroupId=<group>` and in the JSON body, so it " +
    "matches the `DELETE` on this path (#5413); the body wins if both are sent. Without it the " +
    "write targets the group the entity already lives in, and a name spanning two or more " +
    "groups returns 409 `entity_ambiguous` with the candidates. " +
    "⚠️ `connectionGroupId` and `connectionId` remain mutually exclusive (#3854) and that now " +
    "includes the query form: sending `?connectionGroupId=` alongside a body `connectionId` is a " +
    "400 `conflicting_scope`, where the query parameter was previously ignored.",
  request: {
    params: createParamSchema("name", "users"),
    // #5413 — the query form, matching the sibling DELETE. It was the obvious
    // reading of the 409's advice and was silently ignored: the same 409 came
    // back, so a caller concluded the group name was wrong rather than its
    // location. Documented here so the spec answers the question the error asks.
    query: z.object({
      connectionGroupId: z.string().optional().openapi({
        param: { name: "connectionGroupId", in: "query" },
        example: "g_prod_us",
      }),
    }),
    body: {
      content: {
        "application/json": { schema: EntityBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Entity created or updated",
      content: { "application/json": { schema: EntityResponseSchema } },
    },
    400: {
      description: "Invalid request body or entity name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: ambiguousEntityResponse(["query", "body"]),
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Demo content is read-only in published mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const deleteStructuredEntityRoute = createRoute({
  method: "delete",
  path: "/semantic/entities/edit/{name}",
  tags: ["Admin — Semantic"],
  summary: "Delete a semantic entity",
  description:
    "Deletes the named entity from the org-scoped semantic_entities table and disk. " +
    "Pass `?connectionGroupId=<group>` to scope the delete when the same entity name " +
    "exists in multiple environments — without it the backend returns 409 (#2412).",
  request: {
    params: createParamSchema("name", "users"),
    query: z.object({
      connectionGroupId: z.string().optional().openapi({
        param: { name: "connectionGroupId", in: "query" },
        example: "g_prod_us",
      }),
    }),
  },
  responses: {
    200: {
      description: "Entity deleted",
      content: { "application/json": { schema: EntityResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Demo content is read-only in published mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: ambiguousEntityResponse(["query"]),
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const getColumnsRoute = createRoute({
  method: "get",
  path: "/semantic/columns/{tableName}",
  tags: ["Admin — Semantic"],
  summary: "Get column metadata for a datasource table",
  description:
    "Queries the connected analytics datasource's information_schema to return " +
    "column names, types, and nullability for the given table. Org-scoped.",
  request: {
    params: createParamSchema("tableName", "users"),
  },
  responses: {
    200: {
      description: "Column metadata",
      content: { "application/json": { schema: ColumnsResponseSchema } },
    },
    400: {
      description: "Invalid table name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Table not found in datasource",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Route definitions — version history
// ---------------------------------------------------------------------------

export const getEntityVersionsRoute = createRoute({
  method: "get",
  path: "/semantic/entities/{name}/versions",
  tags: ["Admin — Semantic"],
  summary: "List versions for a semantic entity",
  description: "Returns paginated version history for the named entity, ordered newest first.",
  request: {
    params: createParamSchema("name", "users"),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  },
  responses: {
    200: {
      description: "Version list",
      content: { "application/json": { schema: VersionListResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Invalid query parameters (non-numeric or out-of-range `limit`/`offset`) — rejected by request validation",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const getVersionDetailRoute = createRoute({
  method: "get",
  path: "/semantic/entities/versions/{versionId}",
  tags: ["Admin — Semantic"],
  summary: "Get a single version with full YAML content",
  request: {
    params: createParamSchema("versionId", "550e8400-e29b-41d4-a716-446655440000"),
  },
  responses: {
    200: {
      description: "Version detail",
      content: { "application/json": { schema: VersionDetailResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Version not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const postRollbackRoute = createRoute({
  method: "post",
  path: "/semantic/entities/{name}/rollback",
  tags: ["Admin — Semantic"],
  summary: "Rollback an entity to a previous version",
  description:
    "Restores the entity's YAML content from the specified version. " +
    "Creates a new version snapshot recording the rollback. " +
    "The restored draft lands in the group the entity already lives in; pass `connectionGroupId` " +
    "in the body to target a different one, or to disambiguate a name that exists in several (#5412).",
  request: {
    params: createParamSchema("name", "users"),
    body: {
      content: {
        "application/json": { schema: RollbackBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Entity rolled back",
      content: { "application/json": { schema: RollbackResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Version or entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: ambiguousEntityResponse(["body"]),
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Reconcile route (#2462) — drift-drawer actions
// ---------------------------------------------------------------------------

const ReconcileBodySchema = z.object({
  action: z.enum(["sync_yaml", "remove", "create_from_db"]),
  connection: z.string().optional().default("default"),
  // Same trinary encoding as the editor PUT/DELETE (#2412).
  connectionGroupId: z.string().optional(),
});

const ReconcileResponseSchema = z.object({
  ok: z.boolean(),
  action: z.enum(["sync_yaml", "remove", "create_from_db"]),
  name: z.string(),
  entity: z.object({ name: z.string(), yamlContent: z.string() }).nullable(),
});

export const postReconcileEntityRoute = createRoute({
  method: "post",
  path: "/semantic/entities/{name}/reconcile",
  tags: ["Admin — Semantic"],
  summary: "Reconcile a semantic entity against the introspected DB schema",
  description:
    "Dispatches `sync_yaml`, `remove`, or `create_from_db` against `(name, connection)`. " +
    "All actions stage as drafts (#2177); admins publish via `/api/v1/admin/publish`.",
  request: {
    params: createParamSchema("name", "users"),
    body: {
      content: {
        "application/json": { schema: ReconcileBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Reconcile applied",
      content: { "application/json": { schema: ReconcileResponseSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: {
      description:
        "Either the entity to sync/remove doesn't exist (`error: \"not_found\"`), " +
        "or `create_from_db` was called on a name that already exists or has no matching DB table (`error: \"mismatch\"`).",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Auth function type
// ---------------------------------------------------------------------------

type AdminAuthFn = (
  c: { req: { raw: Request }; get(key: string): unknown },
  permission?: import("@atlas/api/lib/auth/permissions").Permission,
) => Promise<{
  authResult: AuthResult & { authenticated: true };
  requestId: string;
}>;

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register structured semantic entity editor routes on the admin router.
 *
 * Registered directly (not as subrouter) to avoid middleware conflicts
 * with existing /semantic/* routes. Uses `runHandler` + `adminAuthAndContext`
 * to match the admin.ts handler pattern (the main admin router doesn't
 * use the createAdminRouter middleware chain).
 *
 * @param admin - The main admin OpenAPIHono router
 * @param authFn - The `adminAuthAndContext` function from admin.ts
 */
export function registerSemanticEditorRoutes(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- admin.ts uses untyped OpenAPIHono; typed generics would require matching the exact Env
  admin: OpenAPIHono<any>,
  authFn: AdminAuthFn,
): void {
  // PUT /semantic/entities/edit/{name} — structured entity create/update
  admin.openapi(putStructuredEntityRoute, async (c) =>
    runHandler(c, "save structured semantic entity", async () => {
      const { name } = c.req.valid("param");
      const body = c.req.valid("json");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Semantic entity editor requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      // Precedence (#3854): `connectionId` and `connectionGroupId` are
      // mutually exclusive scoping inputs. They can disagree (a connection's
      // resolved group ≠ the named group), so rather than silently pick one
      // we reject the conflicting pair. `connectionGroupId` provided →
      // write the group DIRECTLY; `connectionId` provided → resolve the
      // group from the connection.
      //
      // The two fields treat the empty string ASYMMETRICALLY, on purpose:
      //   • `connectionGroupId: ""` is a real, explicit value — the legacy
      //     null/unscoped group — so it counts as "present" (a direct group
      //     write targeting the null scope).
      //   • `connectionId: ""` is meaningless (no connection resolves from an
      //     empty id), so it counts as "absent" — it neither triggers the
      //     conflict guard nor a group-resolving write.
      //
      // Checked BEFORE `entityToYaml` so a conflicting request fails fast
      // without doing the YAML serialization work (Greptile, #3854).
      // #5413 — `connectionGroupId` is read from the QUERY STRING as well as
      // the body, so this verb and the DELETE on the same path agree about
      // where it goes. Body wins when both are sent: the structured editor
      // sends a body and that stays the single source of truth for it, and a
      // request carrying two different answers to one question is not one this
      // handler should arbitrate silently — it takes the more specific one.
      //
      // `??`, not `||`: `connectionGroupId: ""` in the body is a REAL value
      // (the legacy null group, see the schema note), and `||` would discard it
      // in favour of the query string.
      //
      // ⚠️ ONE BEHAVIOUR CHANGE FALLS OUT OF THIS, and it is the right one:
      // `?connectionGroupId=g_prod` alongside a body `connectionId` is now the
      // `conflicting_scope` 400 above, where the query string used to be
      // ignored and the connection silently won. #3854 rejects that pair
      // because the two can DISAGREE — a connection's resolved group need not
      // be the named one — and that argument never depended on which envelope
      // carried the group. Ignoring it was only ever a consequence of not
      // reading it. Pinned by a test, because "a request that used to 200 now
      // 400s" is the kind of thing a caller should meet in the changelog rather
      // than in production.
      const rawConnectionGroupId = body.connectionGroupId ?? c.req.query("connectionGroupId");
      const hasConnectionId =
        body.connectionId !== undefined && body.connectionId !== "";
      const hasConnectionGroupId = rawConnectionGroupId !== undefined;
      if (hasConnectionId && hasConnectionGroupId) {
        return c.json(
          {
            error: "conflicting_scope",
            message:
              "Provide either connectionId or connectionGroupId, not both — they scope the entity differently and may disagree.",
            requestId,
          },
          400,
        );
      }

      // Store in DB
      const {
        upsertDraftEntity,
        upsertDraftEntityForGroup,
        getEntity,
        createVersion,
        generateChangeSummary,
      } = await import("@atlas/api/lib/semantic/entities");

      // Group scope, from whichever location carried it (#5413). Empty string
      // → null (explicit legacy/unscoped). Undefined → backend disambiguates
      // (or 409s with candidate groups).
      const scope = parseConnectionGroupIdQuery(rawConnectionGroupId);

      // Fetch previous version BEFORE the upsert overwrites it. It feeds THREE
      // things: the change summary, — since #5402 — the preservation of every
      // document key the structured editor does not manage, and — since #5412 —
      // the AMBIGUITY CHECK itself (see {@link readEntityOrAmbiguous}). That
      // second use is why this read happens BEFORE `entityToYaml` rather than
      // after: serializing first is what made the write lossy. The third is why
      // nothing may move above this line.
      const previous = await readEntityOrAmbiguous(getEntity, orgId, name, scope);
      if (!previous.ok) return c.json(ambiguousEntityBody(previous.err, requestId, ["query", "body"]), 409);
      const previousEntity = previous.entity;
      const oldYaml = previousEntity?.yaml_content ?? null;

      // Convert structured data to YAML, carrying the stored document's
      // unmanaged keys (`filter`, `grain`, `use_cases`, dimension `virtual`, …)
      // across the round-trip instead of silently dropping them (#5402).
      const yamlContent = await entityToYaml(body, oldYaml, { requestId, orgId, name });

      // All writes stage as drafts regardless of `atlasMode` (#2177). The
      // published row is preserved until the admin publishes via
      // `/api/v1/admin/publish`. The pending-changes pill in the top bar
      // surfaces the draft count.
      //
      // ## Which group the row lands in, and why an unscoped PUT is not "null"
      //
      // `writtenGroup` records the answer, because every read AFTER the write
      // has to use it (#5412). Two shapes, by where the answer comes from:
      //
      //   - `connectionId` → the group that connection resolves to, computed
      //     inside the INSERT by `inlineConnectionGroupSql` so a concurrent
      //     connection delete cannot race a SELECT-then-INSERT — and returned
      //     BY that statement, so nothing re-resolves it afterwards and the
      //     two answers cannot differ.
      //   - anything else → {@link resolveTargetGroup}, the shared precedence
      //     rule (named group › the group the entity already lives in › the
      //     legacy null scope) that the rollback verb also uses.
      let writtenGroup: string | null;
      if (hasConnectionId) {
        // `hasConnectionId` already collapsed `""` → absent, so pass the
        // normalized id — never the raw `""`, which would resolve to no group
        // via `inlineConnectionGroupSql`.
        //
        // `?? null` because a mocked/no-op executor can answer nothing; a real
        // `ON CONFLICT … DO UPDATE` always returns its row.
        writtenGroup =
          (await upsertDraftEntity(orgId, "entity", name, yamlContent, body.connectionId)) ?? null;
      } else {
        writtenGroup = resolveTargetGroup(scope, previousEntity);
        if (hasConnectionGroupId || previousEntity) {
          await upsertDraftEntityForGroup(orgId, "entity", name, yamlContent, writtenGroup);
        } else {
          // New entity, no scope named. `writtenGroup` is already `null`; the
          // legacy helper is kept for this arm alone because it is the only
          // path that must pass `undefined` — never `null`, never `""` — to
          // preserve unscoped-create semantics (#3854).
          await upsertDraftEntity(orgId, "entity", name, yamlContent, undefined);
        }
      }

      // Create version snapshot — non-fatal. Narrow the catch so tagged
      // errors (e.g. AmbiguousEntityError) re-throw and surface their
      // proper HTTP status instead of getting buried in a warn-log.
      //
      // Scoped to `writtenGroup`, never unscoped (#5412): a post-write read is
      // asking "where did MY row go", which has exactly one answer, and asking
      // it unscoped is what turned a completed write into a 409.
      try {
        const entity = await getEntity(orgId, "entity", name, writtenGroup);
        if (entity) {
          const changeSummary = await generateChangeSummary(oldYaml, yamlContent);
          await createVersion(
            entity.id, orgId, "entity", name, yamlContent, changeSummary,
            authResult.user?.id ?? null, authResult.user?.label ?? null,
          );
        }
      } catch (versionErr) {
        if (versionErr instanceof AmbiguousEntityError) throw versionErr;
        log.warn(
          { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, name },
          "Entity saved but version snapshot failed — version history may be incomplete",
        );
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync to disk — non-fatal; DB is authoritative. Key the disk write by
      // the PERSISTED group scope (re-fetched), not the raw request
      // `body.connectionId`, so editor writes land in the same group namespace
      // the delete/rollback paths use — a raw request id can differ from the
      // resolved group key (CodeRabbit, #3275).
      try {
        const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
        const persisted = await getEntity(orgId, "entity", name, writtenGroup);
        await syncEntityToDisk(orgId, name, "entity", yamlContent, persisted?.connection_group_id ?? null);
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Entity saved to DB but disk sync failed — will be synced on next restart",
        );
      }

      log.info({ requestId, orgId, name }, "Semantic entity upserted via editor");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.updateEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, source: "editor" },
      });

      return c.json({ ok: true, name, entityType: "entity" }, 200);
    }),
  );

  // DELETE /semantic/entities/edit/{name} — entity delete
  admin.openapi(deleteStructuredEntityRoute, async (c) =>
    runHandler(c, "delete semantic entity", async () => {
      const { name } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Semantic entity editor requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const {
        getEntity,
        upsertTombstoneForGroup,
        deleteDraftEntityForGroup,
      } = await import("@atlas/api/lib/semantic/entities");

      // Group scope from query (#2412). Forward to getEntity so multi-
      // group orgs can address the right environment; without it, an
      // ambiguous lookup throws AmbiguousEntityError → 409 with the
      // candidate groups.
      const scope = parseConnectionGroupIdQuery(c.req.query("connectionGroupId"));

      // All deletes stage as drafts regardless of `atlasMode` (#2177).
      // Resolve the existing row so we know whether to discard a draft
      // outright or stamp a tombstone over a published row.
      //
      // The 409 is caught rather than mapped for the same reason as the PUT
      // (#5413) — so it names where the parameter goes. For THIS verb that is
      // the query string only; there is no body to put it in.
      const found = await readEntityOrAmbiguous(getEntity, orgId, name, scope);
      if (!found.ok) return c.json(ambiguousEntityBody(found.err, requestId, ["query"]), 409);
      const existing = found.entity;
      if (!existing) {
        return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
      }
      let deleted: boolean;
      if (existing.status === "draft" || existing.status === "draft_delete") {
        deleted = await deleteDraftEntityForGroup(
          orgId,
          "entity",
          name,
          existing.connection_group_id ?? null,
        );
      } else {
        await upsertTombstoneForGroup(
          orgId,
          "entity",
          name,
          existing.connection_group_id ?? null,
        );
        deleted = true;
      }

      if (!deleted) {
        return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync deletion to disk — non-fatal; DB is authoritative
      try {
        const { syncEntityDeleteFromDisk } = await import("@atlas/api/lib/semantic/sync");
        await syncEntityDeleteFromDisk(orgId, name, "entity", existing.connection_group_id ?? null);
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Entity deleted from DB but disk sync failed — will be cleaned on next restart",
        );
      }

      log.info({ requestId, orgId, name }, "Semantic entity deleted via editor");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.deleteEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, source: "editor" },
      });

      return c.json({ ok: true, name, entityType: "entity" }, 200);
    }),
  );

  // GET /semantic/columns/{tableName} — column metadata from analytics datasource
  admin.openapi(getColumnsRoute, async (c) =>
    runHandler(c, "get table columns", async () => {
      const { tableName } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      // Validate table name as a SQL identifier to prevent injection.
      // Only letters, digits, underscores, and dots (for schema.table) are allowed.
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(tableName)) {
        return c.json({ error: "invalid_table_name", message: "Table name must be a valid SQL identifier (letters, digits, underscores)." }, 400);
      }

      // Get the org-scoped connection from the singleton registry
      let conn;
      let dbType;
      try {
        conn = connections.getForOrg(orgId, "default");
        dbType = connections.getDBType("default");
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), requestId, orgId },
          "Failed to get datasource connection for column metadata",
        );
        return c.json({ error: "datasource_unavailable", message: "No analytics datasource is connected. Configure a datasource to enable column autocomplete.", requestId }, 500);
      }

      // Split schema-qualified names (e.g. "public.users" → schema="public", table="users")
      // and escape single quotes for the WHERE clause string literal
      const parts = tableName.split(".");
      const rawTable = parts.length > 1 ? parts[parts.length - 1] : tableName;
      const rawSchema = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
      const escapedTable = rawTable.replace(/'/g, "''");
      const escapedSchema = rawSchema?.replace(/'/g, "''") ?? null;

      try {
        let queryResult;
        if (dbType === "mysql") {
          const schemaClause = escapedSchema
            ? `TABLE_SCHEMA = '${escapedSchema}'`
            : "TABLE_SCHEMA = DATABASE()";
          queryResult = await conn.query(
            `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE ${schemaClause} AND TABLE_NAME = '${escapedTable}' ORDER BY ORDINAL_POSITION`,
            10000,
          );
        } else {
          const schemaClause = escapedSchema
            ? `table_schema = '${escapedSchema}'`
            : "table_schema = current_schema()";
          queryResult = await conn.query(
            `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_name = '${escapedTable}' AND ${schemaClause} ORDER BY ordinal_position`,
            10000,
          );
        }

        if (queryResult.rows.length === 0) {
          return c.json({ error: "not_found", message: `Table "${tableName}" not found in the connected datasource.` }, 404);
        }

        const columns = queryResult.rows.map((row) => ({
          name: String((row.name as string) ?? ""),
          type: String((row.type as string) ?? ""),
          nullable: String((row.nullable as string) ?? "YES").toUpperCase() === "YES",
        }));

        return c.json({ columns }, 200);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), requestId, orgId, tableName },
          "Failed to query column metadata",
        );
        return c.json({ error: "query_failed", message: `Failed to query column metadata for "${tableName}". The table may not exist or the datasource may be unavailable.`, requestId }, 500);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Version history routes
  // ---------------------------------------------------------------------------

  // GET /semantic/entities/{name}/versions — list versions
  admin.openapi(getEntityVersionsRoute, async (c) =>
    runHandler(c, "list entity versions", async () => {
      const { name } = c.req.valid("param");
      const { limit, offset } = c.req.valid("query");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Version history requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { listVersions } = await import("@atlas/api/lib/semantic/entities");
      const { versions, total } = await listVersions(orgId, "entity", name, limit, offset);

      return c.json({
        versions: versions.map((v) => ({
          id: String(v.id),
          versionNumber: Number(v.version_number),
          changeSummary: v.change_summary as string | null,
          authorId: v.author_id as string | null,
          authorLabel: v.author_label as string | null,
          createdAt: String(v.created_at),
        })),
        total,
      }, 200);
    }),
  );

  // GET /semantic/entities/versions/{versionId} — version detail
  admin.openapi(getVersionDetailRoute, async (c) =>
    runHandler(c, "get entity version detail", async () => {
      const { versionId } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Version history requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { getVersion } = await import("@atlas/api/lib/semantic/entities");
      const version = await getVersion(versionId, orgId);

      if (!version) {
        return c.json({ error: "not_found", message: `Version "${versionId}" not found.` }, 404);
      }

      return c.json({
        version: {
          id: String(version.id),
          versionNumber: Number(version.version_number),
          name: String(version.name),
          entityType: String(version.entity_type),
          yamlContent: String(version.yaml_content),
          changeSummary: version.change_summary as string | null,
          authorId: version.author_id as string | null,
          authorLabel: version.author_label as string | null,
          createdAt: String(version.created_at),
        },
      }, 200);
    }),
  );

  // POST /semantic/entities/{name}/rollback — rollback to version
  admin.openapi(postRollbackRoute, async (c) =>
    runHandler(c, "rollback semantic entity", async () => {
      const { name } = c.req.valid("param");
      const body = c.req.valid("json");
      const { versionId } = body;
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Rollback requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const {
        getVersion,
        getEntity,
        upsertDraftEntityForGroup,
        createVersion,
        generateChangeSummary,
      } = await import("@atlas/api/lib/semantic/entities");

      // Group scope for multi-environment orgs (#2412).
      const scope = parseConnectionGroupIdQuery(body.connectionGroupId);

      // Fetch the target version
      const targetVersion = await getVersion(versionId, orgId);
      if (!targetVersion || targetVersion.name !== name) {
        return c.json({ error: "not_found", message: `Version "${versionId}" not found for entity "${name}".` }, 404);
      }

      // Get current entity for change summary — and, as on the PUT above, this
      // is ALSO the ambiguity check: the refusal is raised before anything is
      // written (#5412), and it names where to put the parameter (#5413). This
      // verb takes it in the BODY only — there is no query parameter declared
      // on the route — so `accepts` says `body` and nothing else rather than
      // repeating the PUT's copy at a caller who cannot act on half of it.
      const current = await readEntityOrAmbiguous(getEntity, orgId, name, scope);
      if (!current.ok) return c.json(ambiguousEntityBody(current.err, requestId, ["body"]), 409);
      const currentEntity = current.entity;
      const currentYaml = currentEntity?.yaml_content ?? null;

      // The group the rollback draft lands in — the SAME rule as the PUT
      // (#5412), and this route had the same defect. It used to call
      // `upsertDraftEntity` with no connection id at all, which puts the row in
      // the `null` group whatever group the entity is actually in: for a
      // group-scoped entity that both stranded the rollback where publish would
      // promote it into a group nobody chose, AND made the unscoped re-read
      // below raise `entity_ambiguous` about the group this request had just
      // created — a completed rollback reported as a refusal.
      //
      // The precedence itself lives in {@link resolveTargetGroup}, shared with
      // the PUT — one expression, so the two verbs cannot drift apart again.
      // The disk sync below already keyed on this value, so it and the DB write
      // now agree rather than differing whenever the group is set.
      const targetGroup = resolveTargetGroup(scope, currentEntity);

      // Rollback stages the target YAML as a draft (#2177). The admin
      // publishes via `/api/v1/admin/publish` to materialize it as the
      // new published row, preserving the existing publish gate.
      await upsertDraftEntityForGroup(orgId, "entity", name, targetVersion.yaml_content, targetGroup);

      // Create a new version snapshot for the rollback. Re-throw tagged
      // errors so AmbiguousEntityError surfaces as 409 with `groups`
      // instead of getting buried in a "version snapshot failed" warn.
      let newVersionNumber = 0;
      try {
        const entity = await getEntity(orgId, "entity", name, targetGroup);
        if (entity) {
          const changeSummary = await generateChangeSummary(currentYaml, targetVersion.yaml_content);
          const rollbackSummary = `Rolled back to v${targetVersion.version_number}${changeSummary ? ` (${changeSummary})` : ""}`;
          const vid = await createVersion(
            entity.id, orgId, "entity", name, targetVersion.yaml_content, rollbackSummary,
            authResult.user?.id ?? null, authResult.user?.label ?? null,
          );
          // Fetch the version we just created to get its number
          const newVersion = await getVersion(vid, orgId);
          newVersionNumber = newVersion?.version_number ?? 0;
        }
      } catch (versionErr) {
        if (versionErr instanceof AmbiguousEntityError) throw versionErr;
        log.warn(
          { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, name },
          "Rollback succeeded but version snapshot failed",
        );
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync to disk — non-fatal
      try {
        const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
        await syncEntityToDisk(orgId, name, "entity", targetVersion.yaml_content, targetGroup);
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Rollback succeeded but disk sync failed — will be synced on next restart",
        );
      }

      log.info({ requestId, orgId, name, targetVersion: targetVersion.version_number }, "Semantic entity rolled back");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.updateEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, action: "rollback", targetVersion: targetVersion.version_number },
      });

      return c.json({ ok: true, name, versionNumber: newVersionNumber }, 200);
    }),
  );

  // POST /semantic/entities/{name}/reconcile — drift-drawer reconcile (#2462).
  // Matches the editor's draft-staging contract (#2177); demo+published is
  // gated FE-side via `useDemoReadonly`, same as the editor's edit/delete.
  admin.openapi(postReconcileEntityRoute, async (c) =>
    runHandler(c, "reconcile semantic entity", async () => {
      const { name } = c.req.valid("param");
      const body = c.req.valid("json");
      const { authResult, requestId } = await authFn(c, "admin:semantic");

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(noActiveOrgBody(requestId), 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Reconcile requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const atlasMode =
        (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";
      const scope = parseConnectionGroupIdQuery(body.connectionGroupId);

      const { reconcileEntity } = await import("@atlas/api/lib/semantic/reconcile");
      const result = await reconcileEntity({
        orgId,
        name,
        action: body.action,
        atlasMode,
        connection: body.connection,
        connectionGroupId: scope,
      });

      if (result.status === "not_found") {
        return c.json({ error: "not_found", message: result.reason, requestId }, 404);
      }
      if (result.status === "mismatch") {
        return c.json({ error: "mismatch", message: result.reason, requestId }, 404);
      }
      if (result.status === "not_available") {
        return c.json({ error: "not_available", message: result.reason, requestId }, 501);
      }

      logAdminAction({
        actionType:
          result.action === "remove"
            ? ADMIN_ACTIONS.semantic.deleteEntity
            : ADMIN_ACTIONS.semantic.updateEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, source: "drift-reconcile", action: result.action },
      });

      const entity = result.action === "remove" ? null : result.entity;
      return c.json({ ok: true, action: result.action, name, entity }, 200);
    }),
  );
}
