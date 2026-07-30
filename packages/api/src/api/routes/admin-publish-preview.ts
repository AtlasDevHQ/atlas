/**
 * GET /api/v1/admin/publish/preview — per-surface draft rows about to be
 * promoted by the next call to /api/v1/admin/publish (#2177).
 *
 * The pending-changes Publish modal reads this endpoint when the admin
 * opens it and renders a per-surface list of draft rows. Confirming the
 * modal POSTs to /api/v1/admin/publish to promote them atomically.
 *
 * Returns lightweight identity fields per surface — id, name/description,
 * updated_at, status — not the full row. Full diffs against the published
 * row are out of scope for v1; the existing semantic-entity diff endpoint
 * covers the most-asked-for case.
 *
 * Scope follows the content-mode registry: connections, prompt_collections,
 * query_suggestions (starter prompts), knowledge_documents (hosted-OKF
 * drafts, ADR-0028), brain_facts (company-brain tier-2 claims, ADR-0036), and
 * semantic_entities (drafts, draft-edits, and tombstoned deletes). Adding a new
 * mode-tracked surface means widening the response schema below in lockstep
 * with `CONTENT_MODE_TABLES`.
 *
 * ## One surface is ACL-gated on top of content mode: `brain_facts` (#4825)
 *
 * Every other surface here is workspace-scoped and that is the whole story —
 * an entity or a prompt has no audience narrower than the org. A brain fact
 * does: `visible_to` can name a private channel's audience, and the review
 * queue at `/admin/brain-facts` refuses to show an admin claims from a channel
 * they were never in (ADR-0036 — a platform role confers no brain grant).
 *
 * This preview used to select `subject || predicate || object` for every draft
 * in the workspace, which handed that same admin the exact claims the review
 * queue had just withheld, one modal over. So the brain segment now composes
 * `aclVisibilityClause` for its LABELS and reports the remainder as
 * {@link PublishPreview.brainFactsWithheld} — a number, never content. Publish
 * itself stays workspace-scoped and still promotes all of them; that scope is
 * exactly what the count exists to state before the click, rather than after it
 * in a response the admin has no way to interpret.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { matchScopeAcrossAliases } from "@atlas/api/lib/db/with-group-scope";
import { aclVisibilityClause } from "@atlas/api/lib/brain/acl";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  brainFactPreviewSql,
  brainFactsCountSql,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { WILL_SUPERSEDE_TOTAL_SQL } from "@atlas/api/lib/brain/oversight";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { AuthMode } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-publish-preview");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DraftRowSchema = z.object({
  id: z.string(),
  /** Human-readable label — `name` for entities/prompts/connections, `description` for starter prompts. */
  label: z.string(),
  /** Last-edit timestamp (ISO-8601). */
  updatedAt: z.string().datetime(),
});

const TombstoneRowSchema = z.object({
  id: z.string(),
  /** Entity name that will be deleted on publish. */
  label: z.string(),
  updatedAt: z.string().datetime(),
});

const EntityEditRowSchema = z.object({
  id: z.string(),
  /** Entity name; the published row sharing the same `connection_group_id` will be replaced. */
  label: z.string(),
  /**
   * Group scope (#2340) — the environment the entity belongs to. `null`
   * for legacy `__global__` rows whose backfill did not resolve a group.
   */
  connectionGroupId: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

const PublishPreviewSchema = z.object({
  connections: z.array(DraftRowSchema),
  /** Drafts of new entities (no published row exists yet for that `connection_group_id`). */
  entities: z.array(DraftRowSchema),
  /** Drafts that supersede an existing published entity row. */
  entityEdits: z.array(EntityEditRowSchema),
  /** Tombstones — published rows that will be deleted. */
  entityDeletes: z.array(TombstoneRowSchema),
  prompts: z.array(DraftRowSchema),
  starterPrompts: z.array(DraftRowSchema),
  /** Draft hosted-OKF knowledge documents (ADR-0028). Label = title or path. */
  knowledgeDocuments: z.array(DraftRowSchema),
  /**
   * Draft company-brain facts (#4769 / ADR-0036). Label = the SPO claim.
   * Includes facts the publish endpoint will REFUSE to promote — the preview
   * lists what publish will CONSIDER, and a refused fact is still considered
   * (and still a draft afterwards). The refusal itself is reported by the
   * publish response, which is where the verdict is actually reached.
   *
   * SCOPED TO THIS READER'S GRANTS (#4825), unlike every other array here.
   * See the module header. `brainFacts.length` is therefore NOT what publish
   * will promote — that is `brainFacts.length + brainFactsWithheld`.
   */
  brainFacts: z.array(DraftRowSchema),
  /**
   * Draft facts publish WILL promote and this reader may NOT read (#4825).
   *
   * A separate number rather than padded rows, because there is no honest row
   * to render: the claim is the only identity a fact has, and a placeholder row
   * carrying a fact id would disclose which facts exist without disclosing
   * what they say — the worst of both. Zero for every workspace with no
   * private-audience facts, which is the common case.
   */
  brainFactsWithheld: z.number().int().nonnegative(),
  /**
   * True when `brainFactsWithheld` means "Atlas could not establish what you
   * may read" rather than "these are outside your audiences" (#4825).
   *
   * The two need different copy and only one of them is about Slack
   * membership. Without this flag an infrastructure fault renders as a
   * confident, false explanation above the publish button.
   */
  brainFactsScopeUnavailable: z.boolean(),
  /**
   * How many already-published facts this publish will SUPERSEDE (#4912):
   * promoting a `single`-cardinality draft that collides with a live published
   * fact stamps the old fact's `valid_to` atomically with the promotion, and
   * as-of-now reads then hide it.
   *
   * A workspace-wide COUNT, unscoped like `brainFactsWithheld`'s other half
   * and content-free like it — the modal is the confirm surface, so silence
   * here would be silent supersession for any admin who publishes without
   * visiting `/admin/brain-facts`, where the per-pair disclosure lives
   * (`willSupersede` on the oversight response).
   */
  brainFactsWillSupersede: z.number().int().nonnegative(),
});

export type PublishPreview = z.infer<typeof PublishPreviewSchema>;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const previewRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "List drafts that the next publish call will promote",
  description:
    "Returns the per-surface inventory of draft rows that " +
    "`POST /api/v1/admin/publish` would promote on this org. Read by the " +
    "Publish modal in the admin top bar so the admin can review before " +
    "confirming. The shape mirrors the content-mode registry tuple.",
  responses: {
    200: {
      description: "Per-surface draft inventory",
      content: { "application/json": { schema: PublishPreviewSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DbRow = {
  id: string;
  label: string;
  updated_at: Date | string | null;
  connection_group_id?: string | null;
} & Record<string, unknown>;

/** Coerce pg timestamptz → ISO-8601 string, falling back to epoch-zero so
 *  the wire schema's `.datetime()` validator stays satisfied. Mismatches
 *  log noisily upstream but never fail the preview render. */
function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * The brain segment: reader-scoped labels plus the withheld remainder.
 *
 * A union on `scopeUnavailable` so "degraded means nothing was listed" is
 * structural — the unavailable arm's `rows` is `readonly []`, which it always
 * is in fact. Deliberately NOT the fuller treatment
 * `BrainFactOversightBucket` gets: forgetting there discloses a private channel
 * name, where forgetting here shows correctly-ACL-filtered rows beside the wrong
 * explanatory sentence. There is no unscoped-rows path left — `brainFactPreviewSql`
 * requires an interpolated `aclSql` — so a mis-set flag produces bad copy, never
 * a disclosure. The sole consumer does `.rows.map(…)`, which typechecks on both
 * arms unchanged, so this costs no branching at the call site.
 */
export type BrainFactSegment =
  | {
      /**
       * Atlas could not work out what this reader may see, so `withheld` is
       * "all of them" for an INFRASTRUCTURE reason rather than an ACL one.
       *
       * This arm exists because the copy differs, and the wrong copy is a lie:
       * without it the modal tells an admin who can read every fact in the
       * workspace that all of them came from channels they are not a member of
       * — a confident, fabricated explanation, printed directly above the
       * publish button, with no hint that anything failed.
       */
      readonly scopeUnavailable: true;
      readonly rows: readonly [];
      readonly withheld: number;
    }
  | {
      readonly scopeUnavailable: false;
      readonly rows: readonly DbRow[];
      readonly withheld: number;
    };

/**
 * Load the brain-fact segment of the preview.
 *
 * The labels go through `aclVisibilityClause`; the TOTAL goes through
 * `brainFactsCountSql` — the same statement that feeds `/api/v1/mode`
 * `draftCounts.brainFacts`. Anchoring the unscoped half to the count the mode
 * chip already shows is deliberate: the modal's arithmetic
 * (`shown + withheld = the pending badge`) is then true by construction rather
 * than by two queries that happen to agree, and a drift between them becomes a
 * visible contradiction on one screen instead of a silent one across two.
 *
 * ## An IDENTITY fault never fails the whole preview
 *
 * A reader whose grants cannot be established — `resolveBrainReaderContext`
 * raising a `BrainReaderIdentityError`, or a `deny-all` clause — degrades this
 * segment to "nothing shown, everything withheld, scope unavailable" and logs.
 * Fail-CLOSED for confidentiality, while leaving the other seven surfaces
 * intact: an admin must not lose the ability to publish their semantic layer
 * because a brain ACL lookup blipped, and the withheld count still reports the
 * real blast radius.
 *
 * Everything else PROPAGATES, and the whole preview 500s with a requestId like
 * any other surface here. That includes `aclVisibilityClause`'s own throws
 * (a bad `paramIndex`, an unsafe alias) — those are defects on constant inputs,
 * not ACL outcomes, and degrading on them would bury a programming error under
 * a confidentiality message. A DB fault on either statement propagates too;
 * this function is not a shield against those.
 *
 * Exported for `__tests__/admin-publish-preview-brain.test.ts`: both degraded
 * arms return the same shape as the happy path, so a refactor that "simplified"
 * either into `withheld: 0` would restore #4825's defect and pass a suite that
 * only tested the route end to end.
 */
export async function loadBrainFactSegment(
  orgId: string,
  mode: AuthMode,
  user: AtlasUser | undefined,
  requestId: string | undefined,
): Promise<BrainFactSegment> {
  // Both reads are independent, so they go together rather than in sequence —
  // this segment already costs the preview a third round trip for the labels.
  //
  // The reader context is REIFIED to a settled result rather than left as a
  // rejecting promise: the two have different error semantics (a count failure
  // propagates, an identity failure degrades), so they cannot share a `try`,
  // and an un-reified rejection would go unhandled in the window where the
  // count throws first.
  // `getInternalDB()` is resolved BEFORE the first promise exists. It throws
  // SYNCHRONOUSLY on a missing `DATABASE_URL` or a failed `pg` require, and a
  // throw between `countPromise`'s creation and the first handler attaching to
  // it would orphan that promise into an unhandled rejection — the same hazard
  // the reification closes, in the other direction.
  const db = getInternalDB();
  const countPromise = internalQuery<{ n: number }>(brainFactsCountSql("$1"), [orgId]);
  const readerPromise = resolveBrainReaderContext(db, {
    workspaceId: orgId,
    mode,
    user,
    requestId,
  }).then(
    (ctx) => ({ ok: true, ctx }) as const,
    (err: unknown) => ({ ok: false, err }) as const,
  );
  const [totalRows, reader] = await Promise.all([countPromise, readerPromise]);

  const rawTotal = totalRows[0]?.n;
  const total = typeof rawTotal === "number" ? rawTotal : Number(rawTotal);
  // `typeof` first, then `Number`: a bare `Number(rawTotal)` coerces BOTH
  // `null` and `""` to 0, so a NULL count would sail through as "nothing
  // withheld" rather than as the drift it is. `COUNT(*)` cannot return NULL, so
  // this is unreachable from Postgres — but 0 is the failure-silencing answer
  // here, and the guard costs one comparison.
  if (rawTotal === null || rawTotal === undefined || !Number.isFinite(total) || total < 0) {
    if (!reader.ok) {
      // Two independent faults, one 500. Without this the reader's error is
      // discarded entirely — an operator debugs the count while a pool
      // exhaustion that might explain the whole incident leaves no trace. Before
      // the two reads were parallelised this was unreachable, because the reader
      // never ran when the count failed.
      log.warn(
        { workspaceId: orgId, requestId, err: errorMessage(reader.err) },
        "publish preview: the brain reader ALSO failed while the draft count was unreadable — the count fault is the one thrown; this one is logged so it is not lost behind it",
      );
    }
    // Silently treating this as 0 would drop `WithheldFactsNotice` and put
    // "Publish all (N)" on a button that promotes more — #4825's defect,
    // reproduced without a trace, precisely when the count query is
    // misbehaving. The admin cannot see the scope, so they must not be shown a
    // confident preview.
    throw new Error(
      `publish preview: the brain-fact draft count did not read back as a number for workspace ${orgId} — refusing to report a scope Atlas cannot establish`,
    );
  }
  const withheldAll = {
    rows: [],
    withheld: Math.trunc(total),
    scopeUnavailable: true,
  } as const satisfies BrainFactSegment;

  if (!reader.ok) {
    // ONLY an identity failure degrades. Anything else is a defect or an
    // outage, and laundering it into a confidentiality message would hide it.
    if (!(reader.err instanceof BrainReaderIdentityError)) throw reader.err;
    log.warn(
      { workspaceId: orgId, requestId, err: errorMessage(reader.err) },
      "publish preview: could not resolve the brain reader's grants — listing no claims rather than risking one this admin may not read",
    );
    return withheldAll;
  }

  // OUTSIDE any catch, deliberately. `aclVisibilityClause` throws only on a bad
  // `paramIndex` or an unsafe alias — both constants here, so a throw is a
  // defect on constant inputs. Inside the block above it would have been
  // laundered into a confidentiality message.
  const acl = aclVisibilityClause(reader.ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    log.warn(
      { workspaceId: orgId, requestId, origin: reader.ctx.origin },
      "publish preview: brain reader resolved to no principals — listing no claims; the withheld count still reports what publish would promote",
    );
    return withheldAll;
  }
  const { sql: aclSql, params: aclParams } = acl;

  const rows = await internalQuery<DbRow>(brainFactPreviewSql(aclSql), [...aclParams]);

  if (rows.length > withheldAll.withheld) {
    // Ordinarily the ingest race below. But the scoped projection derives its
    // ENTIRE tenant boundary from the interpolated `aclSql`, so this is also
    // what a regression that dropped `workspace_id` from the `grant-match` arm
    // would look like — cross-workspace rows arriving here. The clamp would
    // absorb that silently, so it is logged before it is clamped.
    log.warn(
      { workspaceId: orgId, requestId, shown: rows.length, workspaceTotal: withheldAll.withheld },
      "publish preview: the reader-scoped fact projection returned more rows than the workspace draft count — a brief ingest race, or the scoped statement is reaching outside the workspace; reporting 0 withheld",
    );
  }

  // `Math.max(0, …)` because the two halves are separate statements and a fact
  // ingested between them would otherwise render as a NEGATIVE withheld count.
  // Clamping is right HERE, unlike in the oversight aggregate: this number is
  // the modal's "and N more you cannot see", where the honest answer under a
  // race is "none extra that we know of" rather than a nonsense figure.
  return {
    rows,
    withheld: Math.max(0, withheldAll.withheld - rows.length),
    scopeUnavailable: false,
  };
}

/**
 * The will-supersede count off `pg`, guarded like the brain draft count above
 * and for the same reason with the same asymmetry: 0 is the failure-silencing
 * answer — it drops the supersession notice from the modal precisely when the
 * count query is misbehaving, which is #4912's "no silent supersession"
 * reproduced as a driver drift. `COUNT(*)` cannot return NULL, so the throw is
 * unreachable from Postgres; it exists so drift is a 500 with a requestId
 * rather than a confident all-clear.
 */
function readWillSupersedeTotal(
  rows: ReadonlyArray<{ will_supersede_total: number }>,
  orgId: string,
): number {
  const raw = rows[0]?.will_supersede_total;
  const total = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || !Number.isFinite(total) || total < 0) {
    throw new Error(
      `publish preview: the will-supersede count did not read back as a number for workspace ${orgId} — refusing to report a supersession scope Atlas cannot establish`,
    );
  }
  return Math.trunc(total);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminPublishPreview = createAdminRouter();
adminPublishPreview.use(requireOrgContext());

// `runEffect` rather than `runHandler`: the brain segment needs the reader's
// identity to gate its labels, and `AuthContext` is where that lives —
// `runHandler`'s plain-async callback cannot `yield*` a Context Tag at all.
//
// `orgContext` is still read off Hono below, and that is not the same thing:
// it is `requireOrgContext()`'s payload, the middleware that 400s an org-less
// request, so the router-level contract is where it belongs.
adminPublishPreview.openapi(previewRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user } = yield* AuthContext;
      const { orgId } = c.get("orgContext");
      const preview = yield* Effect.tryPromise({
        try: () => buildPreview(orgId, mode, user, requestId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      return c.json(preview, 200);
    }),
    { label: "preview publish" },
  ),
);

/**
 * Assemble the whole preview.
 *
 * Exported for `__tests__/admin-publish-preview-brain.test.ts`. Hono does not
 * validate responses and this route runs no `checked()`, so the
 * {@link BrainFactSegment} → wire mapping below is unguarded at runtime:
 * dropping `brainFactsWithheld`, or wiring it to `rows.length`, would ship. The
 * segment's own tests cannot see that — they stop at the helper.
 */
export async function buildPreview(
  orgId: string,
  mode: AuthMode,
  user: AtlasUser | undefined,
  requestId: string | undefined,
): Promise<PublishPreview> {
  {
    // Fan out one query per surface — runs in parallel via Promise.all.
    // Each query is indexed on `(org_id, status)` (see migration
    // `0044_content_mode_indexes.sql`) so the planner uses an index scan
    // even for orgs with thousands of historical rows.
    const [
      connectionsRows,
      newEntityRows,
      entityEditRows,
      entityDeleteRows,
      promptRows,
      starterPromptRows,
      knowledgeRows,
      brainFactSegment,
      willSupersedeRows,
    ] = await Promise.all([
      internalQuery<DbRow>(
        `SELECT install_id AS id, install_id AS label, updated_at
           FROM workspace_plugins
          WHERE workspace_id = $1 AND pillar = 'datasource' AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      // Entities that are NOT also a draft-edit (no published sibling).
      // The `NOT EXISTS` filter mirrors the `entityEdits` segment in
      // `CONTENT_MODE_TABLES` so the two lists never overlap. Scope match
      // keys on `connection_group_id` (#2340) — multi-environment drafts
      // collapse to one preview row per logical entity, not N per replica.
      //
      // `pub.entity_type = d.entity_type` is load-bearing: the partial
      // unique indexes from 0063 key on `(org_id, entity_type, name,
      // connection_group_id)`, so without this clause a draft *metric*
      // named "accounts" would falsely "match" a published *entity* of
      // the same name (and vice versa) — counted as a new-entity create
      // when it should be an edit, or hidden from `entities` when it's
      // genuinely new. Same fix on both queries below.
      internalQuery<DbRow>(
        `SELECT d.id::text AS id, d.name AS label, d.updated_at,
                d.connection_group_id
           FROM semantic_entities d
          WHERE d.org_id = $1
            AND d.status = 'draft'
            AND NOT EXISTS (
              SELECT 1 FROM semantic_entities pub
               WHERE pub.org_id = d.org_id
                 AND pub.entity_type = d.entity_type
                 AND pub.name = d.name
                 AND ${matchScopeAcrossAliases({ leftAlias: "pub", rightAlias: "d", column: "connection_group_id" })}
                 AND pub.status = 'published'
            )
          ORDER BY d.updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT d.id::text AS id, d.name AS label, d.updated_at,
                d.connection_group_id
           FROM semantic_entities d
           INNER JOIN semantic_entities pub
             ON d.org_id = pub.org_id
            AND d.entity_type = pub.entity_type
            AND d.name = pub.name
            AND ${matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub", column: "connection_group_id" })}
          WHERE d.org_id = $1
            AND d.status = 'draft'
            AND pub.status = 'published'
          ORDER BY d.updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, name AS label, updated_at
           FROM semantic_entities
          WHERE org_id = $1 AND status = 'draft_delete'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, name AS label, updated_at
           FROM prompt_collections
          WHERE org_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, description AS label, updated_at
           FROM query_suggestions
          WHERE org_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      // Knowledge documents label on their title, falling back to the bundle
      // path when a lenient-parsed document has no frontmatter title.
      internalQuery<DbRow>(
        `SELECT id::text AS id, COALESCE(NULLIF(title, ''), path) AS label, updated_at
           FROM knowledge_documents
          WHERE workspace_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      // Brain facts label on the SPO claim itself — a fact has no name, and
      // "subject predicate object" is how a reviewer recognises the claim they
      // are about to publish. THE ONE ACL-GATED SEGMENT: see the module header
      // and `loadBrainFactSegment`.
      loadBrainFactSegment(orgId, mode, user, requestId),
      // #4912 — how many published facts this publish will supersede. A
      // workspace-wide count with no content and no reader in it, so it rides
      // the plain fan-out rather than the ACL-gated segment above.
      internalQuery<{ will_supersede_total: number }>(WILL_SUPERSEDE_TOTAL_SQL, [orgId]),
    ]);

    const response: PublishPreview = {
      connections: connectionsRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      entities: newEntityRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      entityEdits: entityEditRows.map((r) => ({
        id: r.id,
        label: r.label,
        connectionGroupId: r.connection_group_id ?? null,
        updatedAt: toIso(r.updated_at),
      })),
      entityDeletes: entityDeleteRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      prompts: promptRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      starterPrompts: starterPromptRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      knowledgeDocuments: knowledgeRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      brainFacts: brainFactSegment.rows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      brainFactsWithheld: brainFactSegment.withheld,
      brainFactsScopeUnavailable: brainFactSegment.scopeUnavailable,
      brainFactsWillSupersede: readWillSupersedeTotal(willSupersedeRows, orgId),
    };

    return response;
  }
}

export { adminPublishPreview };
