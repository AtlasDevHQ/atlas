/**
 * Per-event workspace resolution for the proactive listener (#2620).
 *
 * The chat plugin's `registerProactiveListener` calls
 * `config.resolveWorkspaceId({ adapter, thread, message })` at the top
 * of every event handler so it can attribute meter rows / pause checks /
 * quota lookups to the right tenant. SaaS routes Slack events from N
 * tenants through one Chat instance; pre-#2620 a baked-in workspaceId
 * would have stamped every event with the same tenant.
 *
 * This module ships the Slack-platform resolver — the only platform on
 * the SaaS roadmap today (per the #2620 spec). Other platforms (Teams,
 * Discord, ...) plug in their own resolver when the time comes; each
 * just needs to extract the tenant identifier from `message.raw` and
 * look it up against the internal DB.
 *
 * Contract (from `plugins/chat/src/proactive/types.ts:ResolveWorkspaceIdFn`):
 *
 *   - Returns the Atlas workspace id (`org_id` in the internal DB) for
 *     the tenant that sent this event, or `null` when the event doesn't
 *     belong to any known tenant (unrecognized `team_id`, missing raw
 *     payload, non-matching adapter, ...). On `null` the listener
 *     silently skips: no classification, no meter row, no kill-switch
 *     read.
 *   - Never throws. Implementation failures should resolve as `null` so
 *     the listener fails closed (skip) without crashing the SDK loop —
 *     the wrapper inside `listener.ts:safeResolveWorkspace` provides a
 *     defensive try/catch, but a clean resolver still returns `null` on
 *     every error path.
 *
 * The lookup goes through `lib/slack/store.getInstallation` — backed
 * by the consolidated `chat_cache` table (#2634). The partial
 * expression index on `value->>'orgId'` keeps `getInstallationByOrg`
 * fast; this resolver does the inverse (`team_id` → `orgId`) which is
 * a primary-key lookup on `chat_cache.key`.
 *
 * @module
 */

import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getInstallation } from "@atlas/api/lib/slack/store";
import { createLogger } from "@atlas/api/lib/logger";
import type { ResolverEvent } from "@useatlas/chat";

const log = createLogger("proactive:workspace-id-resolver");

// Pre-#2623 this module declared a local structural `interface
// ResolverEvent { adapter; thread: unknown; message: { raw } }` to
// avoid taking a `@useatlas/chat` runtime dependency. Post-#2623 item 2
// the plugin's `ResolverEvent` is `Pick<Message, "id" | "raw">` plus an
// `adapter` and an optional `thread`; importing the named type as a
// type-only reference keeps host + plugin shapes in lockstep so a
// future widening (e.g. adding a `metadata` field) propagates here at
// compile time instead of silently drifting.

/**
 * Build the Slack-platform workspace resolver.
 *
 * Maps the inbound Slack `team_id` (from the raw event payload) to the
 * Atlas workspace id via `lib/slack/store.getInstallation` (backed by
 * `chat_cache` post-#2634). Behaves defensively at every step:
 *
 *   - Non-Slack adapter → `null` (the caller may pass events from
 *     multiple platforms through the same listener).
 *   - Missing `team_id` / `team` in the raw payload → `null`. Slack
 *     events always carry `team_id` for `message`-type events; defence
 *     against synthetic events from tests / unusual webhooks.
 *   - DB read failure → `null` + structured `log.warn` so an operator
 *     triaging missing meter rows can spot the resolver outage in logs.
 *   - Row missing (`team_id` not installed) → `null`. Treated as
 *     "unknown tenant"; matches the behaviour the listener relies on.
 *
 * Never throws. The chat plugin's safe-wrapper catches throws as a
 * defence in depth, but a clean resolver returns `null` on every error
 * path so the listener's behaviour stays observable in logs (warn rows
 * line up with rejected events).
 */
export function createSlackWorkspaceIdResolver(): (
  event: ResolverEvent,
) => Promise<string | null> {
  return async (event) => {
    if (event.adapter?.name !== "slack") return null;

    // Slack `team_id` lives at the top level of the raw event for
    // channel messages, app mentions, and reactions; `team` is the
    // older alias still used on some webhook shapes. Accept either.
    const raw = event.message?.raw as
      | { team_id?: string; team?: string }
      | undefined;
    const teamId = raw?.team_id ?? raw?.team;
    if (!teamId) return null;

    if (!hasInternalDB()) {
      // Self-hosted / no internal DB → the listener can't resolve any
      // tenant, so silently skip. The chat plugin's gate (`isEnabled`)
      // already returns false in this configuration, so we won't be
      // reached in practice — defensive return for completeness.
      return null;
    }

    try {
      const installation = await getInstallation(teamId);
      return installation?.org_id ?? null;
    } catch (err) {
      // `pg`-shaped errors carry a `.code` (e.g. `57P01` admin shutdown,
      // `42P01` undefined-table); spread onto the warn payload so an
      // operator can distinguish a missing migration from a DB blip.
      const code =
        err instanceof Error && "code" in err
          ? { code: (err as { code: unknown }).code }
          : {};
      log.warn(
        {
          teamId,
          err: err instanceof Error ? err.message : String(err),
          ...code,
        },
        "Proactive workspace resolver: chat_cache lookup failed — treating as unknown tenant",
      );
      return null;
    }
  };
}
