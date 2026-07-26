/**
 * Admin publish endpoint — atomic promotion of drafts to published.
 *
 * Mounted under /api/v1/admin/publish via admin.route(). Admin-only.
 *
 * Runs the 4-phase publish flow from PRD #1421 in a single transaction:
 * 1. Apply `draft_delete` tombstones (delete the targeted published rows,
 *    then delete the tombstones themselves).
 * 2. Delete published entity rows superseded by drafts (same entity key).
 * 3. Promote every draft content type to `published`, in order:
 *    3a. Entities (merged with phase 2 via `promoteDraftEntities()`).
 *    3b. Connections.
 *    3c. Prompt collections.
 *    3d. Starter-prompt suggestions (`query_suggestions`) — #1478.
 *    3e. Knowledge documents (`knowledge_documents`) — #4206 / ADR-0028.
 *    3f. Company-brain facts (`brain_facts`) — #4769 / ADR-0036. The only
 *        phase that can REFUSE an individual row: a fact missing provenance or
 *        a usable grant is left `draft` and reported under
 *        `refusedDrafts`. The refusal quarantines the claim, not the
 *        transaction — see `lib/content-mode/adapters/brain-facts.ts`.
 * 4. If `archiveConnections` is provided, archive those connections and
 *    cascade to their entities. When the archive list includes the reserved
 *    `__demo__` ID, also archive the built-in demo prompt collections whose
 *    industry matches the org's `demo_industry` setting.
 *
 * Any failure rolls back the entire transaction — no partial state.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { PublishPromotedCounts, PublishResult } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import { readDemoIndustry } from "@atlas/api/lib/demo-industry";
import {
  archiveSingleConnection,
  listIncompleteProfileLayers,
  DEMO_CONNECTION_ID,
} from "@atlas/api/lib/semantic/entities";
import { runHandler } from "@atlas/api/lib/effect/hono";
import {
  CONTENT_MODE_TABLES,
  collectRefusals,
  makeService,
  promotedCountsFromReports,
  type RefusalSweep,
} from "@atlas/api/lib/content-mode";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

/**
 * Module-level content-mode registry (#1515 phase 2e).
 *
 * `runPublishPhases` iterates `CONTENT_MODE_TABLES` in tuple order inside
 * the caller's transaction. The registry's `PromotionReport[]` return is
 * projected onto the wire shape by `promotedCountsFromReports` — one count
 * per registered entry, so a newly-registered surface can never be silently
 * dropped from the publish result.
 */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

const log = createLogger("admin-publish");

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const PublishRequestSchema = z.object({
  /**
   * Optional list of connection IDs to archive as part of the publish.
   * When set, each connection's status is flipped to `archived` and its
   * published entities cascade to `archived`. When the list includes the
   * reserved `__demo__` connection, built-in demo prompt collections for
   * the org's demo industry are also archived.
   */
  archiveConnections: z.array(z.string().min(1)).optional(),
});

const PublishResponseSchema = z.object({
  promoted: z.object({
    connections: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
    starterPrompts: z.number().int().nonnegative(),
    knowledgeDocuments: z.number().int().nonnegative(),
    brainFacts: z.number().int().nonnegative(),
  }),
  deleted: z.object({
    entities: z.number().int().nonnegative(),
  }),
  archived: z.object({
    connections: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
  }),
  /**
   * Durable partial-profile warning (#3682). Present (non-empty) when the org
   * has one or more semantic layers that were profiled INCOMPLETELY — some
   * tables failed introspection below the abort threshold, so the layer is live
   * with those tables NOT queryable. Surfaced here so an admin publishing the
   * layer sees the degraded state instead of an unconditional success. Read from
   * the durable `semantic_profile_status` marker, so it survives a restart and
   * reflects layers profiled in any process. Omitted when no layer is partial.
   */
  warnings: z
    .object({
      incompleteLayers: z.array(
        z.object({
          connectionGroupId: z.string().nullable(),
          totalTables: z.number().int().nonnegative(),
          failedCount: z.number().int().nonnegative(),
          failedTables: z.array(
            z.object({ table: z.string(), error: z.string() }),
          ),
        }),
      ),
    })
    .optional(),
  /**
   * Draft rows the review gate REFUSED to promote (#4769, ADR-0036). Each stays
   * `draft` and is re-offered on the next publish, so this is the actionable
   * half of "never stamps it published": without it the admin would read an
   * unqualified success while some drafts silently did not go live.
   *
   * TOP-LEVEL, not under `warnings`, because it belongs to the SHARED
   * `PublishResult` core — REST, the MCP tool, and the CLI must all report a
   * refusal under one name in one place. Surfaces that each invented their own
   * spelling are exactly what #4156 unified.
   *
   * Omitted (not `[]`) when nothing was refused.
   */
  refusedDrafts: z
    .array(
      z.object({
        id: z.string(),
        surface: z.string(),
        reasons: z.array(z.string()),
        detail: z.string(),
      }),
    )
    .optional(),
  /**
   * How many drafts were refused IN TOTAL — never capped, unlike the list
   * above. Count off this, not `refusedDrafts.length`: they differ exactly when
   * the backlog is worst, which is when an accurate number matters most.
   */
  refusedDraftTotal: z.number().int().nonnegative().optional(),
});

export type PublishResponse = z.infer<typeof PublishResponseSchema>;

// #4156 drift guard: the REST response must stay a structural superset of the
// shared `PublishResult` core (promoted counts + `deleted.entities`) so the
// REST / MCP / CLI publish surfaces can't diverge on the delete-count field
// name. This never-called function fails to compile if the REST core reshapes
// (e.g. `deleted` → `deleted_entities`, or a promoted-count rename); the
// `archived` + `warnings` extras don't break it (a superset is assignable to
// the core). The REST schema itself stays local hono-`z` because
// `@useatlas/schemas` carries no `.openapi()` metadata. Mirrors the guard idiom
// in `packages/mcp/src/structured-output.ts`.
const _assertPublishResponseIsShared = (r: PublishResponse): PublishResult => r;

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const publishRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "Publish all drafts",
  description:
    "Atomically promote every `draft` and apply every `draft_delete` tombstone " +
    "for the active org, optionally archiving the specified connections. " +
    "After a successful response, no draft or tombstone rows remain for the org — " +
    "EXCEPT any listed in `refusedDrafts`, which the review gate declined " +
    "to promote (a company-brain fact missing provenance or a usable grant). Those " +
    "stay `draft`, stay in `draftCounts`, and are re-offered on the next publish.",
  request: {
    body: {
      content: { "application/json": { schema: PublishRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Publish summary",
      content: { "application/json": { schema: PublishResponseSchema } },
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
    422: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({
            details: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Publish failed — transaction rolled back",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminPublish = createAdminRouter();
adminPublish.use(requireOrgContext());

adminPublish.openapi(publishRoute, async (c) =>
  runHandler(c, "publish mode", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const authResult = c.get("authResult");

    // Body validation is handled upstream by `validationHook` (returns 422
    // on invalid shapes) and `requireOrgContext()` (returns 404 when the
    // internal DB is unavailable). Here we just consume the validated body.
    const { archiveConnections } = c.req.valid("json");
    const archiveIds = archiveConnections ?? [];
    const archiveDemo = archiveIds.includes(DEMO_CONNECTION_ID);

    // Resolve demo industry before opening the transaction. A read
    // failure must 500 here — otherwise publish would commit with
    // prompts = 0 and demo prompts would stay published after archive.
    let demoIndustry: string | null = null;
    if (archiveDemo) {
      const industryResult = readDemoIndustry(orgId, requestId);
      if (!industryResult.ok) {
        return c.json(
          {
            error: "publish_failed",
            message:
              "Publish failed — could not read demo industry setting. See server logs for details.",
            requestId,
          },
          500,
        );
      }
      demoIndustry = industryResult.value;
    }

    // ── Transaction ────────────────────────────────────────────────
    let promoted: PublishPromotedCounts;
    let refusals: RefusalSweep;
    let deletedEntityCount: number;
    let archivedConnectionCount: number;
    let archivedEntityCount: number;
    let archivedPromptCount: number;

    try {
      const tx = await withInternalTransaction("admin-publish", async (client) => {
        // Phases 1–3 — delegate to the content-mode registry. It runs every
        // registered adapter in tuple order inside this transaction: the
        // simple UPDATEs (connections / prompts / starter prompts / knowledge
        // documents), then the exotic semantic_entities adapter composes
        // applyTombstones + promoteDraftEntities. A failure surfaces as
        // `PublishPhaseError` tagged with `{ table, phase }`; `Effect.runPromise`
        // throws on failure and `withInternalTransaction` rolls back.
        const reports = await Effect.runPromise(
          contentModeRegistry.runPublishPhases(client, orgId),
        );

        // Phase 4: archive requested connections (+ cascade to their entities +
        // demo prompt collections when the id is `__demo__`). Loops the shared
        // single-connection helper so publish and the standalone archive
        // endpoints stay in lockstep — see #1437.
        const archived = { connections: 0, entities: 0, prompts: 0 };
        for (const id of archiveIds) {
          const archiveResult = await archiveSingleConnection(client, orgId, id, {
            demoIndustry: id === DEMO_CONNECTION_ID ? demoIndustry : null,
          });
          // Exhaustive switch — matches the pattern in admin-archive.ts so a
          // future ArchiveConnectionResult variant fails the `never` default
          // at compile time instead of getting silently treated as
          // `not_found`.
          switch (archiveResult.status) {
            case "archived":
              archived.connections++;
              archived.entities += archiveResult.entities;
              archived.prompts += archiveResult.prompts;
              break;
            case "already_archived":
              // The connection row itself was already archived, but the
              // helper's cascade still reconciled any straggler entities /
              // demo prompts.
              archived.entities += archiveResult.entities;
              archived.prompts += archiveResult.prompts;
              log.warn(
                {
                  requestId,
                  orgId,
                  connectionId: id,
                  cascadedEntities: archiveResult.entities,
                  cascadedPrompts: archiveResult.prompts,
                },
                "archiveConnection id already archived during publish — cascade reconciled",
              );
              break;
            case "not_found":
              // Admin passed a bogus id. Surface it in the log so ops can
              // spot typos; publish itself still commits the rest.
              log.warn(
                { requestId, orgId, connectionId: id },
                "archiveConnection id not found during publish — skipped",
              );
              break;
            default: {
              const _exhaustive: never = archiveResult;
              throw new Error(
                `Unhandled archive result in publish loop: ${JSON.stringify(_exhaustive)}`,
              );
            }
          }
        }

        return { reports, archived };
      });

      // One promoted count per registry entry — derived, so a newly-registered
      // surface is reported here without a hand-edit (#81 arch review: the
      // hand-listed fan-out layout is what let knowledge ship under-reported).
      promoted = promotedCountsFromReports(CONTENT_MODE_TABLES, tx.reports);
      // Draft rows an adapter declined to promote (#4769). They stayed `draft`
      // and the transaction still committed — a refusal quarantines the row,
      // not the workspace's whole publish. `collectRefusals` is shared with the
      // MCP lib seam so the two publish paths cannot report differently.
      refusals = collectRefusals(tx.reports);
      deletedEntityCount =
        tx.reports.find((r) => r.table === "semantic_entities")?.tombstonesApplied ?? 0;
      archivedConnectionCount = tx.archived.connections;
      archivedEntityCount = tx.archived.entities;
      archivedPromptCount = tx.archived.prompts;
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          orgId,
          requestId,
        },
        "Publish failed — transaction rolled back",
      );
      return c.json(
        {
          error: "publish_failed",
          message:
            "Publish failed — all changes rolled back. See server logs for details.",
          requestId,
        },
        500,
      );
    }

    // ── Audit + response ────────────────────────────────────────────
    logAdminAction({
      actionType: ADMIN_ACTIONS.mode.publish,
      targetType: "mode",
      targetId: orgId,
      ipAddress:
        c.req.header("x-forwarded-for") ??
        c.req.header("x-real-ip") ??
        null,
      metadata: {
        promotedConnections: promoted.connections,
        promotedEntities: promoted.entities,
        promotedPrompts: promoted.prompts,
        promotedStarterPrompts: promoted.starterPrompts,
        promotedKnowledgeDocuments: promoted.knowledgeDocuments,
        promotedBrainFacts: promoted.brainFacts,
        // ids + reasons, not just a count: the audit_log row is the DURABLE
        // record, and `log.warn` rotates. "3 drafts were refused" six months
        // later is unactionable. `detail` is deliberately dropped — it is
        // rendered prose, reconstructible from `reasons`.
        // Uncapped ids + reasons. The response cap exists to bound an HTTP
        // payload; this is a jsonb column, and the comment above is only true
        // if the ids actually make it into the row. `detail` is dropped — it is
        // rendered prose, reconstructible from `reasons`.
        refusedDrafts: refusals.all.map((r) => ({
          id: r.id,
          surface: r.surface,
          reasons: r.reasons,
        })),
        refusedDraftCount: refusals.total,
        deletedEntities: deletedEntityCount,
        archivedConnections: archivedConnectionCount,
        archivedEntities: archivedEntityCount,
        archivedPrompts: archivedPromptCount,
        archiveIds,
      },
    });

    log.info(
      {
        requestId,
        orgId,
        actorId: authResult.user?.id,
        promoted,
        refusedDrafts: refusals.total,
        deleted: { entities: deletedEntityCount },
        archived: {
          connections: archivedConnectionCount,
          entities: archivedEntityCount,
          prompts: archivedPromptCount,
        },
      },
      "Publish succeeded",
    );

    // #3856 — hot-register newly-published datasources (and deregister archived
    // ones) into the live `ConnectionRegistry`, so a standalone datasource is
    // agent-queryable immediately after publish with NO api restart and no
    // manual `group_id` SQL. Boot-time `loadSavedConnections` registered the
    // process's installs once; publish (a pure status flip + archive cascade
    // above) never touched the registry, so without this the just-published
    // connection relied on its install-time registration surviving and a
    // just-archived one kept serving from a stale pool until the next boot.
    // Run AFTER commit so the registry reflects the persisted truth, and
    // best-effort: the publish has already committed, so a transient registry
    // failure must not turn it into a 500 — log and move on (the next boot's
    // `loadSavedConnections` reconciles). Reconcile is idempotent + symmetric:
    // the bridge's `has()` guards make a NATIVE re-register a no-op and a
    // deregister of a never-live row a no-op (a PLUGIN pool — clickhouse /
    // snowflake / … — is rebuilt in place via `createFromConfig`, still safe in
    // effect: the live connection is swapped for an equivalent one).
    //
    // Lazy-`import` (not a top-level import) so this route's static module
    // graph doesn't require the export at load time — several admin-route tests
    // partial-`mock.module("@atlas/api/lib/db/internal")` with a subset of
    // exports, and a top-level import would break the admin router's load on
    // any fixture that omits this one symbol. Same posture `loadSavedConnections`
    // and `workspace-installer.ts` use for the registry bridge.
    try {
      const { reconcileWorkspaceDatasources } = await import(
        "@atlas/api/lib/db/internal"
      );
      const reconcile = await reconcileWorkspaceDatasources(orgId);
      if (reconcile.registered > 0 || reconcile.deregistered > 0) {
        log.info(
          {
            requestId,
            orgId,
            registered: reconcile.registered,
            deregistered: reconcile.deregistered,
          },
          "Publish hot-registered datasources into the live ConnectionRegistry",
        );
      }
    } catch (reconcileErr) {
      log.warn(
        {
          requestId,
          orgId,
          err:
            reconcileErr instanceof Error
              ? reconcileErr.message
              : String(reconcileErr),
        },
        "Publish committed, but reconciling datasources into the ConnectionRegistry failed — newly-published connections may need an api restart until the next boot",
      );
    }

    // #4208 — bust the per-mode semantic + knowledge disk mirror so the next
    // `explore` call rebuilds from the just-published DB state. Publish is a pure
    // status flip (drafts → published), so without this the published-mode mirror
    // keeps serving pre-publish content (notably newly-published knowledge
    // collections) until the next entity CRUD or boot. Best-effort + post-commit:
    // a cache-bust failure must not turn an already-committed publish into a 500.
    // Same lazy-import posture as the reconcile above (avoid static-graph coupling
    // that partial-mock admin-route fixtures would break) — though a different
    // module (`semantic/sync`, not `db/internal`).
    try {
      const { invalidateOrgModeRoots } = await import("@atlas/api/lib/semantic/sync");
      invalidateOrgModeRoots(orgId);
    } catch (invalidateErr) {
      log.warn(
        {
          requestId,
          orgId,
          err: invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr),
        },
        "Publish committed, but invalidating the per-mode mirror failed — the agent may serve stale semantic/knowledge content until the next rebuild",
      );
    }

    // #3682 — surface any DURABLE partial-profile markers for the org. The
    // publish just promoted these layers to `published`; if one was profiled
    // incompletely (tables failed introspection below the abort threshold), it
    // is now live with those tables NOT queryable. Read the marker AFTER commit
    // so an admin sees the degraded state. Best-effort: a read failure must not
    // turn an already-committed publish into a 500 — log and omit the warning.
    let incompleteLayers: Awaited<ReturnType<typeof listIncompleteProfileLayers>> = [];
    try {
      incompleteLayers = await listIncompleteProfileLayers(orgId);
    } catch (warnErr) {
      log.warn(
        {
          requestId,
          orgId,
          err: warnErr instanceof Error ? warnErr.message : String(warnErr),
        },
        "Publish committed, but reading partial-profile markers failed — warning omitted",
      );
    }
    if (incompleteLayers.length > 0) {
      log.warn(
        {
          requestId,
          orgId,
          partialLayers: incompleteLayers.length,
          groups: incompleteLayers.map((l) => l.connectionGroupId),
        },
        "Published one or more INCOMPLETE semantic layers — some tables are not queryable",
      );
    }

    if (refusals.total > 0) {
      log.warn(
        {
          requestId,
          orgId,
          refusedCount: refusals.total,
          refused: refusals.reported.map((r) => ({
            id: r.id,
            surface: r.surface,
            reasons: r.reasons,
          })),
        },
        "Publish committed, but the review gate refused to promote one or more drafts — they remain drafts",
      );
    }

    const response: PublishResponse = {
      promoted,
      deleted: { entities: deletedEntityCount },
      archived: {
        connections: archivedConnectionCount,
        entities: archivedEntityCount,
        prompts: archivedPromptCount,
      },
      ...(incompleteLayers.length > 0
        ? {
            warnings: {
              incompleteLayers: incompleteLayers.map((l) => ({
                connectionGroupId: l.connectionGroupId,
                totalTables: l.totalTables,
                failedCount: l.failedCount,
                failedTables: l.failedTables.map((f) => ({
                  table: f.table,
                  error: f.error,
                })),
              })),
            },
          }
        : {}),
      // Omitted, not `[]`, when nothing was refused — so a client can branch on
      // presence without an empty-array false positive.
      ...(refusals.total > 0
        ? {
            refusedDrafts: refusals.reported.map((r) => ({
              id: r.id,
              surface: r.surface,
              reasons: [...r.reasons],
              detail: r.detail,
            })),
            refusedDraftTotal: refusals.total,
          }
        : {}),
    };
    return c.json(response, 200);
  }),
);

export { adminPublish };
