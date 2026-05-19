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
 * The lookup table is `slack_installations` (defined in
 * `0000_baseline.sql:74` — `team_id PRIMARY KEY, org_id TEXT`). The
 * issue body refers to "`slack_integrations`" but the actual table in
 * the migrations is `slack_installations`; we use the canonical table
 * name here.
 *
 * @module
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("proactive:workspace-id-resolver");

/**
 * Structural shape of the resolver event passed by the chat plugin.
 * Kept structural (the `chat` npm package is not a dependency of
 * `@atlas/api`) so the host helper can sit under `lib/proactive/`
 * without pulling the plugin's full type surface in. The chat plugin's
 * `ResolveWorkspaceIdFn` is the strict type; this is the minimum surface
 * the Slack resolver actually reads from the event.
 */
interface ResolverEvent {
  adapter: { name?: string } | undefined;
  thread: unknown;
  message: { raw?: unknown } | undefined;
}

/**
 * Build the Slack-platform workspace resolver.
 *
 * Maps the inbound Slack `team_id` (from the raw event payload) to the
 * Atlas workspace id by reading `slack_installations.org_id`. Behaves
 * defensively at every step:
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
      const rows = await internalQuery<{ org_id: string | null }>(
        `SELECT org_id
           FROM slack_installations
          WHERE team_id = $1
          LIMIT 1`,
        [teamId],
      );
      if (rows.length === 0) return null;
      return rows[0]!.org_id ?? null;
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
        "Proactive workspace resolver: slack_installations lookup failed — treating as unknown tenant",
      );
      return null;
    }
  };
}
