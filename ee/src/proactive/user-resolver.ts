/**
 * Proactive `userResolver` — chat-platform identity → Atlas identity (#2624).
 *
 * The chat plugin's `ProactiveUserResolver` (post-#2624 + #2641 shape) is:
 *
 *     (asker, { workspaceId: WorkspaceId }) => Promise<ResolvedAsker>
 *
 *     ResolvedAsker = { kind: "linked"; atlasUserId: AtlasUserId }
 *                   | { kind: "unlinked" }
 *
 * The `workspaceId` is the per-event tenant resolved by
 * `./workspace-id-resolver.ts:createSlackWorkspaceIdResolver`
 * (Slack `team_id` → `chat_cache:slack:installation` → `org_id`,
 * post-#2634). This module wires a resolver factory for the Slack
 * platform that:
 *
 *   1. **Verifies the workspace is a real Atlas org.** A defensive
 *      lookup against the consolidated install store — defends against a
 *      hypothetical caller that hands us an unknown workspaceId (the
 *      listener's resolver should already have returned `null` in that
 *      case, but if a future code path bypasses the per-event resolver
 *      we still refuse to attribute the asker to a stale tenant).
 *
 *   2. **Returns `{ kind: "unlinked" }`** for every asker today.
 *      The mapping from `(workspaceId, slack_user_id)` to an Atlas
 *      `user.id` requires a link table (e.g. `slack_user_links` with
 *      `(workspace_id, slack_user_id, atlas_user_id)`) that does NOT
 *      yet exist in core. Without that table the resolver cannot
 *      safely link an asker — and we MUST NOT invent a heuristic
 *      match (e.g. "first member of the org") because that would
 *      silently bypass per-user RLS for an unlinked asker by binding
 *      their query to another user's identity. The unlinked branch
 *      is the safe fallback: the listener's public-dataset gate +
 *      refusal copy gate that asker's access.
 *
 * **Hook point for future linking work.** A follow-up issue is
 * expected to add a Slack-user link mechanism (OAuth user grant, an
 * admin-managed link table, or email matching via the Slack profile
 * API). When that lands the resolver replaces step 2 with
 * `{ kind: "linked", atlasUserId: assertAtlasUserId(row.atlas_user_id) }`
 * for matching rows; the surrounding wiring (#2624 contract change +
 * #2641 brand types) stays as-is.
 *
 * Failures resolve as `{ kind: "unlinked" }` rather than throwing —
 * the listener's `safeResolveUser` catches throws and treats them as
 * the apology path (refuse, do not downgrade to public-dataset).
 * Returning an explicit unlinked result keeps the three-state ladder
 * ("linked" / "unlinked" / "errored") meaningful for the failure
 * mode that's actually "we don't know yet" (no link table) rather
 * than "the registry is broken" (errored).
 *
 * Layer hygiene: relocated to `ee/src/proactive/` (#3999) — proactive is
 * a paid EE surface. Does NOT import from `api/routes/`. Only the SaaS
 * deploy wires this up; self-hosted deployments can either reuse this
 * factory (the unlinked-only path is correct everywhere) or omit
 * `userResolver` entirely (the listener defaults to
 * `{ kind: "unlinked" }` when undefined).
 *
 * @module
 */

import type {
  ProactiveAsker,
  ProactiveUserResolver,
  ProactiveUserResolverContext,
  ResolvedAsker,
  WorkspaceId,
} from "@useatlas/chat";

import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getInstallationByOrg } from "@atlas/api/lib/slack/store";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("proactive:user-resolver");

/**
 * Options for {@link createSlackProactiveUserResolver}. All optional;
 * tests pass `verifyWorkspace: () => Promise.resolve(true)` to stub
 * the DB lookup.
 */
export interface SlackProactiveUserResolverOptions {
  /**
   * Verify the given workspaceId maps to a real Atlas org via
   * `chat_cache` (consolidated post-#2634 — was `slack_installations`).
   * Defaults to a single-row lookup against the internal DB. Override
   * in tests to stub.
   *
   * The Slack workspace-id resolver
   * (`createSlackWorkspaceIdResolver`) already does this lookup at
   * the per-event boundary; this is a defensive re-check so a
   * resolver invoked through a code path that bypasses the workspace
   * resolver still refuses to attribute the asker. Cheap (indexed
   * lookup against `idx_chat_cache_slack_org_id` on
   * `value->>'orgId'`) so the extra read isn't material.
   *
   * Accepts a branded {@link WorkspaceId} (#2641) so a transposed-arg
   * call (e.g. passing `asker.externalUserId` here) is a compile error.
   */
  verifyWorkspace?: (workspaceId: WorkspaceId) => Promise<boolean>;
}

/**
 * Build the SaaS proactive user-resolver for the Slack platform.
 *
 * Today: validates the workspaceId and returns
 * `{ atlasUserId: undefined }` for every asker (no Slack-user link
 * table exists yet). When a link mechanism lands, the lookup goes
 * inside the inner `try` block below — the calling contract stays
 * unchanged.
 *
 * The factory pattern (vs a top-level function) keeps the test
 * surface narrow: pass a stubbed `verifyWorkspace` and you can
 * exercise every branch without touching the internal DB.
 */
export function createSlackProactiveUserResolver(
  options: SlackProactiveUserResolverOptions = {},
): ProactiveUserResolver {
  const verifyWorkspace =
    options.verifyWorkspace ?? defaultVerifyWorkspace;

  return async (
    asker: ProactiveAsker,
    ctx: ProactiveUserResolverContext,
  ): Promise<ResolvedAsker> => {
    const { workspaceId } = ctx;
    if (asker.platform !== "slack") {
      // Future platforms wire their own resolver. Returning unlinked
      // (vs throwing) keeps the failure-closed posture: the listener
      // refuses-safely via the public-dataset gate rather than
      // surfacing an apology copy on a misrouted event.
      log.debug(
        { platform: asker.platform, workspaceId },
        "Proactive user resolver invoked for non-Slack platform — returning unlinked",
      );
      return { kind: "unlinked" };
    }

    // `workspaceId` is the branded {@link WorkspaceId} threaded from
    // the listener (post-#2641); empty values never reach the resolver
    // because `assertWorkspaceId` throws at the listener boundary. The
    // length check below is belt-and-braces against a future caller
    // that bypasses the listener.
    if (workspaceId.length === 0) {
      log.warn(
        { externalUserId: asker.externalUserId },
        "Proactive user resolver invoked without workspaceId — returning unlinked",
      );
      return { kind: "unlinked" };
    }

    try {
      const known = await verifyWorkspace(workspaceId);
      if (!known) {
        log.warn(
          { workspaceId, externalUserId: asker.externalUserId },
          "Proactive user resolver: workspaceId not in chat_cache — returning unlinked",
        );
        return { kind: "unlinked" };
      }
    } catch (err) {
      // DB outage → unlinked (NOT errored): the listener treats
      // `errored` as "post the apology copy", and a registry hiccup
      // should fall through to the public-dataset path (refuse-safely
      // via the listener's allowlist gate) rather than blocking
      // every asker behind an apology. The pause registry uses the
      // opposite posture (fail-closed) because IT is a control;
      // user-linking is observability + UX, not a permission gate.
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          workspaceId,
          externalUserId: asker.externalUserId,
        },
        "Proactive user resolver: verifyWorkspace failed — returning unlinked",
      );
      return { kind: "unlinked" };
    }

    // Hook point — when a Slack-user link table lands, replace the
    // line below with a lookup keyed on (workspaceId, asker.externalUserId)
    // and return `{ kind: "linked", atlasUserId: assertAtlasUserId(row.atlas_user_id) }`
    // for matches. Until then every asker takes the unlinked path:
    // the listener's public-dataset gate is the answer-or-refuse
    // branch, and that branch IS tenant-scoped now (#2624) via the
    // workspaceId threaded through `getPublicDataset(asker, { workspaceId })`.
    return { kind: "unlinked" };
  };
}

/**
 * Default workspace verifier — single-row lookup via the consolidated
 * `chat_cache` store (post-#2634). Returns false on a missing row.
 * Throws on DB error so the caller can distinguish "unknown
 * workspace" from "DB is down"; the calling resolver collapses both
 * onto the same unlinked outcome but logs them separately (warn for
 * missing, warn-with-error for outage).
 */
async function defaultVerifyWorkspace(
  workspaceId: WorkspaceId,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const installation = await getInstallationByOrg(workspaceId);
  return installation !== null;
}
