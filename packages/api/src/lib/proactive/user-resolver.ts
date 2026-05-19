/**
 * Proactive `userResolver` — chat-platform identity → Atlas identity (#2624).
 *
 * The chat plugin's `ProactiveUserResolver` (post-#2624 shape) is:
 *
 *     (asker, { workspaceId }) => Promise<{ atlasUserId? }>
 *
 * The `workspaceId` is the per-event tenant resolved by
 * `lib/proactive/workspace-id-resolver.ts:createSlackWorkspaceIdResolver`
 * (Slack `team_id` → `slack_installations.org_id`). This module wires
 * a resolver factory for the Slack platform that:
 *
 *   1. **Verifies the workspace is a real Atlas org.** A defensive
 *      lookup against `slack_installations.org_id` — defends against a
 *      hypothetical caller that hands us an unknown workspaceId (the
 *      listener's resolver should already have returned `null` in that
 *      case, but if a future code path bypasses the per-event resolver
 *      we still refuse to attribute the asker to a stale tenant).
 *
 *   2. **Returns `{ atlasUserId: undefined }`** for every asker today.
 *      The mapping from `(workspaceId, slack_user_id)` to an Atlas
 *      `user.id` requires a link table (e.g. `slack_user_links` with
 *      `(workspace_id, slack_user_id, atlas_user_id)`) that does NOT
 *      yet exist in core. Without that table the resolver cannot
 *      safely link an asker — and we MUST NOT invent a heuristic
 *      match (e.g. "first member of the org") because that would
 *      silently bypass per-user RLS for an unlinked asker by binding
 *      their query to another user's identity.
 *
 *      The listener's unlinked-asker path (public-dataset gate +
 *      refusal copy) is the safe behaviour until the link table
 *      lands.
 *
 * **Hook point for future linking work.** A follow-up issue is
 * expected to add a Slack-user link mechanism (OAuth user grant, an
 * admin-managed link table, or email matching via the Slack profile
 * API). When that lands the resolver replaces step 2 with a real
 * lookup; the surrounding wiring (#2624 contract change) stays as-is.
 *
 * Failures resolve as `{ atlasUserId: undefined }` rather than
 * throwing — the listener's `safeResolveUser` catches throws but
 * treats them as the apology path (refuse, do not downgrade to
 * public-dataset). Returning an explicit unlinked result keeps the
 * three-state ladder ("linked" / "unlinked" / "errored") meaningful
 * for the failure mode that's actually "we don't know yet" (no link
 * table) rather than "the registry is broken" (errored).
 *
 * Layer hygiene: lives under `lib/proactive/`. Does NOT import from
 * `@atlas/ee` or from `api/routes/`. Only the SaaS deploy wires this
 * up; self-hosted deployments can either reuse this factory (the
 * unlinked-only path is correct everywhere) or omit `userResolver`
 * entirely (the listener defaults to "unlinked" when undefined).
 *
 * @module
 */

import type {
  ProactiveAsker,
  ProactiveUserResolver,
  ProactiveUserResolverContext,
  ResolvedAsker,
} from "@useatlas/chat";

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
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
   * `slack_installations.org_id`. Defaults to a single-row lookup
   * against the internal DB. Override in tests to stub.
   *
   * The Slack workspace-id resolver
   * (`createSlackWorkspaceIdResolver`) already does this lookup at
   * the per-event boundary; this is a defensive re-check so a
   * resolver invoked through a code path that bypasses the workspace
   * resolver still refuses to attribute the asker. Cheap (indexed
   * lookup against `idx_slack_installations_org` on `org_id`) so the
   * extra read isn't material.
   */
  verifyWorkspace?: (workspaceId: string) => Promise<boolean>;
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
      return { atlasUserId: undefined };
    }

    if (!workspaceId) {
      // Defensive: workspaceId should always be non-empty (the
      // listener short-circuits on a null/empty resolver result),
      // but an empty string here would skip the workspace check and
      // collapse all tenants onto the global path. Refuse-safely.
      log.warn(
        { externalUserId: asker.externalUserId },
        "Proactive user resolver invoked without workspaceId — returning unlinked",
      );
      return { atlasUserId: undefined };
    }

    try {
      const known = await verifyWorkspace(workspaceId);
      if (!known) {
        log.warn(
          { workspaceId, externalUserId: asker.externalUserId },
          "Proactive user resolver: workspaceId not in slack_installations — returning unlinked",
        );
        return { atlasUserId: undefined };
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
      return { atlasUserId: undefined };
    }

    // Hook point — when a Slack-user link table lands, replace the
    // line below with a lookup keyed on (workspaceId, asker.externalUserId)
    // and return `{ atlasUserId }` for matches. Until then every
    // asker takes the unlinked path: the listener's public-dataset
    // gate is the answer-or-refuse branch, and that branch IS
    // tenant-scoped now (#2624) via the workspaceId threaded through
    // `getPublicDataset(asker, { workspaceId })`.
    return { atlasUserId: undefined };
  };
}

/**
 * Default workspace verifier — single-row lookup against
 * `slack_installations`. Returns false on a missing row or null
 * `org_id`. Throws on DB error so the caller can distinguish
 * "unknown workspace" from "DB is down"; the calling resolver
 * collapses both onto the same unlinked outcome but logs them
 * separately (warn for missing, warn-with-error for outage).
 */
async function defaultVerifyWorkspace(workspaceId: string): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const rows = await internalQuery<{ org_id: string | null }>(
    `SELECT org_id
       FROM slack_installations
      WHERE org_id = $1
      LIMIT 1`,
    [workspaceId],
  );
  const [row] = rows;
  return row !== undefined && row.org_id !== null;
}
