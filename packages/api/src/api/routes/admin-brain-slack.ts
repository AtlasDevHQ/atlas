/**
 * The **Slack ingest scope** admin surface (#5203, grill #5200 T3).
 *
 * Mounted under `/api/v1/admin/brain-slack`:
 *
 *   GET  /channels          — every channel Atlas knows, with health + scope state
 *   POST /channels/exclude  — take a channel out of ingest scope
 *   POST /channels/include  — put it back
 *
 * ## Why this surface exists at all
 *
 * `catalog:slack-history` was a second, credential-free Slack install whose
 * whole payload was a channel list. Retiring it moved scope onto the bot's
 * channel membership, which means there is no longer an install form to put
 * two things on:
 *
 *   1. **The two-probe verification.** The retired handler probed every channel
 *      twice before persisting — `conversations.info` for existence and
 *      membership, and a ONE-MESSAGE `conversations.history` read for the
 *      history scopes, which `conversations.info` structurally cannot see (it
 *      is gated on `channels:read`, which the chat adapter's token already
 *      holds, so it returns fine for a token that cannot read a single
 *      message). Dropping it with the install would have turned three legible
 *      failures back into per-cycle sync errors nobody reads — the exact
 *      regression the ticket is about. `GET /channels` is where the verdicts
 *      land.
 *   2. **The escape hatch.** Membership alone has none: a channel the bot must
 *      be in for chat but whose contents should not be retained had no way to
 *      be expressed. `POST /channels/exclude` is it.
 *
 * ## Exclusion is a confidentiality decision, so it is attributed and 403-gated
 *
 * `adminAuth` gates the router coarsely (it reads the SESSION's role); each
 * write additionally re-resolves the principal against THIS workspace
 * (`resolveBrainReaderContext`) and applies the owner/admin bar, exactly as
 * `admin-brain-vocabulary.ts` does for the vocabulary. Neither check is
 * redundant: the router keeps a non-admin session out of the surface, the
 * re-resolution keeps an admin of ANOTHER workspace out of this one's scope.
 *
 * The recorded author is NOT optional — the table's own CHECK refuses an
 * unattributed exclusion — because "why did we stop reading that channel?" is
 * an audit question and an anonymous answer is not one.
 *
 * ## What this surface does NOT do
 *
 * It does not enumerate Slack. The listing is what the last sync OBSERVED, plus
 * whatever an admin excluded; a channel the bot was invited to five minutes ago
 * appears after the next cycle. Reading `users.conversations` here would make an
 * interactive admin request depend on a vendor round-trip whose failure mode is
 * a spinner, and the scheduled refresh already owns that call.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  InvalidSlackChannelIdError,
  excludeSlackChannel,
  includeSlackChannel,
  listSlackChannels,
  normalizeSlackChannelId,
  readSlackEpisodeSyncStatus,
  resolveSlackPollScope,
} from "@atlas/api/lib/brain/ingest/slack/scope";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

const log = createLogger("api.admin.brain-slack");

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string(),
});

const ChannelSchema = z.object({
  channelId: z.string(),
  name: z.string().nullable(),
  isPrivate: z.boolean().nullable(),
  isArchived: z.boolean(),
  isMember: z.boolean(),
  inScope: z.boolean(),
  excludedAt: z.string().nullable(),
  exclusionReason: z.string().nullable(),
  excludedBy: z.string().nullable(),
  health: z.enum(["ok", "error"]).nullable(),
  healthError: z.string().nullable(),
  healthCheckedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

/**
 * The per-workspace sync's last recorded attempt. This block is what makes a
 * revoked Slack token VISIBLE: the retired install's collection card used to
 * render this row through the admin-knowledge list, and the retirement removed
 * that surface — without it, the sync's actionable error message would be
 * recorded every cycle and read by nobody.
 */
const SyncStatusSchema = z.object({
  lastSyncAt: z.string().nullable(),
  status: z.enum(["success", "error"]),
  error: z.string().nullable(),
  coverageIncomplete: z.boolean(),
});

const ChannelListSchema = z.object({
  /**
   * `legacy-pending` means this workspace had a `slack-history` install and the
   * first sync has not yet reconciled it — until then the pre-#5203 channel
   * list is the scope, and the `inScope` flags below reflect THAT rather than
   * membership. Surfaced rather than hidden because an admin looking at a
   * mostly-empty listing needs to know it is a state that resolves itself.
   */
  scopeMode: z.enum(["membership", "legacy-pending"]),
  /** In-scope channel count — what the next scheduled pass will read. */
  inScopeCount: z.number().int().nonnegative(),
  /** Null until the first sync attempt has been recorded for this workspace. */
  sync: SyncStatusSchema.nullable(),
  channels: z.array(ChannelSchema),
});

const ExcludeRequestSchema = z.object({
  channelId: z.string().min(1),
  reason: z.string().max(500).nullish(),
});

const IncludeRequestSchema = z.object({
  channelId: z.string().min(1),
});

const MutationResultSchema = z.object({
  channelId: z.string(),
  /** False when the verb was a no-op — already excluded, or not excluded. */
  changed: z.boolean(),
});

const channelsRoute = createRoute({
  method: "get",
  path: "/channels",
  tags: ["Admin — Brain"],
  summary: "List the workspace's Slack channels and their ingest scope",
  description:
    "Every Slack channel Atlas has observed the bot in, plus any an admin excluded. `health` carries " +
    "the per-channel two-probe verification (conversations.info + a one-message conversations.history " +
    "read); it is null until the rotation reaches that channel. `sync` carries the last recorded " +
    "history-sync attempt — its `error` is where a revoked or under-scoped Slack credential surfaces.",
  responses: {
    200: { description: "Channel list", content: { "application/json": { schema: ChannelListSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const excludeRoute = createRoute({
  method: "post",
  path: "/channels/exclude",
  tags: ["Admin — Brain"],
  summary: "Exclude a Slack channel from brain ingest",
  request: {
    body: { content: { "application/json": { schema: ExcludeRequestSchema } } },
  },
  responses: {
    200: { description: "Excluded", content: { "application/json": { schema: MutationResultSchema } } },
    400: { description: "Invalid channel id or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const includeRoute = createRoute({
  method: "post",
  path: "/channels/include",
  tags: ["Admin — Brain"],
  summary: "Return a Slack channel to brain ingest scope",
  request: {
    body: { content: { "application/json": { schema: IncludeRequestSchema } } },
  },
  responses: {
    200: { description: "Included", content: { "application/json": { schema: MutationResultSchema } } },
    400: { description: "Invalid channel id or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/**
 * `admin-brain-vocabulary.ts`'s `recordedAuthor`, verbatim and for its reason.
 * An `unresolved` principal yields null — it must NOT inherit the declared local
 * operator, which would file one workspace's confidentiality decision under
 * another's operator.
 */
function recordedAuthor(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return (ctx.role === "owner" || ctx.role === "admin") && ctx.userId ? ctx.userId : null;
    case "unauthenticated-local":
      return "local-operator";
    case "unresolved":
      return null;
  }
}

function errorBody(error: string, message: string, requestId: string) {
  return { error, message, requestId };
}

const adminBrainSlack = createAdminRouter();

adminBrainSlack.use(requireOrgContext());

adminBrainSlack.openapi(channelsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const payload = yield* Effect.tryPromise({
        try: async () => {
          // One request, two loaders — the scope resolution decides `inScope`,
          // and it is NOT recomputed from the row flags here. Under
          // `legacy-pending` the in-scope set is the captured allowlist and has
          // nothing to do with `is_member`/`excluded_at`, so a client-side
          // `isMember && !excludedAt` would show a reconciling workspace a scope
          // it does not have.
          const [rows, scope, sync] = await Promise.all([
            listSlackChannels(orgId),
            resolveSlackPollScope(orgId),
            readSlackEpisodeSyncStatus(orgId),
          ]);
          const inScope = new Set(scope.channels);
          return {
            scopeMode: scope.mode,
            inScopeCount: scope.channels.length,
            sync,
            channels: rows.map((r) => ({
              channelId: r.channelId,
              name: r.name,
              isPrivate: r.isPrivate,
              isArchived: r.isArchived,
              isMember: r.isMember,
              inScope: inScope.has(r.channelId),
              excludedAt: r.excludedAt,
              exclusionReason: r.exclusionReason,
              excludedBy: r.excludedBy,
              health: r.healthStatus,
              healthError: r.healthError,
              healthCheckedAt: r.healthCheckedAt,
              lastSeenAt: r.lastSeenAt,
            })),
          };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(ChannelListSchema.parse(payload), 200);
    }),
    { label: "list brain slack channels" },
  );
});

adminBrainSlack.openapi(excludeRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const body = c.req.valid("json");

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      const author = recordedAuthor(ctx);
      if (author === null) {
        // LOGGED. An attempt to narrow what the brain reads without the
        // entitlement is exactly the event `acl.ts` says belongs in the log —
        // and the refusal message travels out in the response, which is the
        // caller's copy, not a server-side record.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Slack channel exclusion refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Excluding a Slack channel from the company brain changes what Atlas retains, so it is limited to workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const channelId = normalizeSlackChannelId(body.channelId);
          const changed = await excludeSlackChannel({
            workspaceId: orgId,
            channelId,
            reason: body.reason ?? null,
            actor: author,
          });
          return { channelId, changed };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        // A malformed channel id is the caller's mistake and names its own fix,
        // so it is a 400 carrying the seam's own sentence rather than a 500 with
        // a request id and nothing to act on. Matched by TYPE, not message
        // substring — a reworded message must not silently turn the 400 into a
        // 500 — and the message travels FROM the error, so the route cannot
        // drift from the validator's wording.
        Effect.catchAll((err) =>
          err instanceof InvalidSlackChannelIdError
            ? Effect.succeed({ invalid: err.message })
            : Effect.fail(err),
        ),
      );
      if ("invalid" in result) {
        return c.json(errorBody("invalid-channel-id", result.invalid, requestId), 400);
      }

      log.info(
        { workspaceId: orgId, channelId: result.channelId, changed: result.changed, requestId },
        "Slack channel excluded from brain ingest",
      );
      return c.json(MutationResultSchema.parse(result), 200);
    }),
    { label: "exclude brain slack channel" },
  );
});

adminBrainSlack.openapi(includeRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const body = c.req.valid("json");

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      // Gated on the SAME bar as excluding, deliberately. Re-including a channel
      // WIDENS what Atlas retains, so if anything it is the more consequential
      // of the pair — a lower bar here would let a non-admin undo an admin's
      // confidentiality decision.
      if (recordedAuthor(ctx) === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Slack channel re-inclusion refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Returning a Slack channel to the company brain's ingest scope changes what Atlas retains, so it is limited to workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      // The include verb WIDENS retention scope, so it gets the same typed 400
      // as exclude — the route's contract already documented an invalid-id 400
      // it previously could never produce.
      const result = yield* Effect.tryPromise({
        try: async () => {
          const channelId = normalizeSlackChannelId(body.channelId);
          const changed = await includeSlackChannel({ workspaceId: orgId, channelId });
          return { channelId, changed };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          err instanceof InvalidSlackChannelIdError
            ? Effect.succeed({ invalid: err.message })
            : Effect.fail(err),
        ),
      );
      if ("invalid" in result) {
        return c.json(errorBody("invalid-channel-id", result.invalid, requestId), 400);
      }

      log.info(
        { workspaceId: orgId, channelId: result.channelId, changed: result.changed, requestId },
        "Slack channel returned to brain ingest scope",
      );
      return c.json(MutationResultSchema.parse(result), 200);
    }),
    { label: "include brain slack channel" },
  );
});

export { adminBrainSlack };
