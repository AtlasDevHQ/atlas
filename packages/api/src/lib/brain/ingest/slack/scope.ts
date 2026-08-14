/**
 * The brain's Slack ingest scope (#5203, grill #5200 T3) — what replaced
 * `catalog:slack-history`.
 *
 * ## One install, and the scope is a membership
 *
 * Before this module, connecting Slack was two acts: the Chat Platform pillar
 * install, and a second credential-free `slack-history` install whose entire
 * payload was a channel list. Nothing about the first suggested the second was
 * load-bearing, and M1 proved the cost — Atlas's own Slack live as a chat
 * platform in three prod regions, extraction on, and the brain ingesting
 * nothing for four days, with every surface green.
 *
 * Scope is now **the bot's channel membership, minus an admin exclusion list**.
 * Adding a channel is inviting the bot, which is the gesture people already
 * know; removing one is an explicit, attributed exclusion.
 *
 * ## ⚠️ TWO scope predicates, deliberately, and they are not the same question
 *
 * This module exports two, and conflating them is the bug this section exists
 * to prevent:
 *
 *   - {@link resolveSlackPollScope} — "which channels should the scheduled pass
 *     READ?" It must ENUMERATE, so it reads observed membership (`is_member`)
 *     minus exclusions.
 *   - {@link isEventChannelInScope} — "may this arriving webhook event be
 *     stored?" It must answer for ONE channel with no Slack call, and it does
 *     NOT consult `is_member`.
 *
 * The asymmetry is sound because **Slack only delivers `message.channels` /
 * `message.groups` events for conversations the bot is a member of** — the
 * delivery IS the membership proof, fresher than anything this table holds. Had
 * the event path also required `is_member = true`, every channel would drop its
 * messages between the invite and the next sync cycle, because membership is
 * only observed when the refresh below runs. Those messages would not be lost
 * (the poll backfills from the channel's own floor), but they would arrive a
 * cycle late for no reason.
 *
 * What the event path DOES consult is the exclusion — because an exclusion
 * always writes a row, an excluded channel is never invisible to it. That is
 * the property that makes reading membership optional here and reading
 * exclusions mandatory.
 *
 * ## The three scope states, and why the EMPTY one is real
 *
 * `brain_slack_ingest_scope` exists so the retirement cannot silently broaden
 * an existing workspace. Migration 0198 captured the retired installs' channel
 * sets; this module reconciles them against live membership at the FIRST SYNC,
 * never inside the migration (a Slack call per workspace inside a schema
 * transaction, resolving membership at migration time for a scope defined at
 * sync time).
 *
 *   | scope row            | `reconciled_at` | `legacy_channels` | effective scope                  |
 *   |----------------------|-----------------|-------------------|----------------------------------|
 *   | absent               | —               | —                 | membership − exclusions          |
 *   | present              | NULL            | non-empty         | `legacy_channels` − exclusions   |
 *   | present              | NULL            | **empty**         | **nothing**                      |
 *   | present              | set             | (kept, unread)    | membership − exclusions          |
 *
 * Exclusions apply in EVERY state — an admin exclusion takes effect when the
 * route writes it, never "after the first reconcile". Both predicates below
 * subtract it before anything else, because an exclusion that waits on a
 * reconcile is inert exactly as long as the workspace's Slack read keeps
 * failing, while the admin who made it has already been told it changed.
 *
 * The empty row is the workspace that had an install which contributed no
 * usable scope — an unparseable config, or every install disabled/archived. It
 * ingests nothing, which is exactly what it did before the retirement. Treating
 * it as "absent" instead would promote it to the new default and broaden it
 * from nothing to everything, which is the one class the whole mechanism exists
 * to prevent.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { withBrainTransaction } from "@atlas/api/lib/brain/reconcile";
import {
  fetchConversationHistoryPage,
  fetchUserConversationsPage,
  getConversationInfo,
  type SlackConversationInfo,
} from "@atlas/api/lib/slack/api";
import { SLACK_CHANNEL_ID_PATTERN } from "./config";

const log = createLogger("brain.ingest.slack.scope");

/**
 * The synthetic install id the per-workspace dispatch books its sync state
 * under (`knowledge_sync_state.collection_id`).
 *
 * It is deliberately the retired handler's DEFAULT install slug rather than a
 * fresh name. `knowledge_sync_state` is keyed `(workspace_id, collection_id)`
 * and carries the per-channel cursor AND the high-water mark, so reusing the
 * slug lets the common single-install workspace — every workspace that took the
 * default, including Atlas's own — cross this change without re-reading a
 * single message. A new name would have orphaned all of it and made the first
 * post-upgrade cycle a full backfill for everyone.
 */
export const SLACK_EPISODE_SYNC_ID = "slack-history";

/** How the effective scope was decided — carried into logs and the sync report. */
export type SlackScopeMode = "membership" | "legacy-pending";

export interface SlackIngestScope {
  readonly mode: SlackScopeMode;
  /** The channels a scheduled pass should read. Ordered for deterministic walks. */
  readonly channels: readonly string[];
  /**
   * Exclusions that actually narrowed this scope: under `membership`, excluded
   * channels the bot is nonetheless a member of; under `legacy-pending`,
   * captured-allowlist channels an admin has since excluded.
   */
  readonly excludedInMembership: number;
}

/**
 * Page bound on the membership enumeration. 20 × 200 = 4,000 conversations,
 * against a method whose result set is bounded by what the bot was INVITED to
 * rather than by workspace size.
 *
 * ⚠️ Hitting it is not a truncation to shrug at — see
 * {@link refreshSlackIngestScope}, which refuses to retire absent channels when
 * the enumeration did not complete. A bound that silently narrowed scope would
 * reintroduce M1's failure through the other door.
 */
export const MEMBERSHIP_MAX_PAGES = 20;
export const MEMBERSHIP_PAGE_LIMIT = 200;

/**
 * Channels health-probed per cycle, oldest check first.
 *
 * ## This is the bound #5203 owes #5205
 *
 * The retired install carried `SLACK_HISTORY_MAX_CHANNELS = 50` and expected
 * multiple installs beyond it. That cap is GONE with the install: a workspace
 * whose bot sits in 400 channels now has 400 in scope. Two costs follow, and
 * only one of them is bounded here.
 *
 *   - **Health probing** is bounded by this constant: at most
 *     `2 × SLACK_CHANNEL_HEALTH_PROBES_PER_CYCLE` extra Slack calls per cycle,
 *     regardless of scope size. A 400-channel workspace takes ~20 cycles to
 *     probe every channel once, which is the right trade for a check whose job
 *     is to catch a persistent misconfiguration rather than a transient.
 *   - **Ingest** is bounded by the client's existing per-pass page budget
 *     (`HISTORY_MAX_PAGES_PER_PASS = 120`) and the engine's per-sync episode
 *     cap. Those were sized against a 50-channel ceiling, so a large workspace
 *     will now spend several cycles covering its scope, reporting
 *     `coverageIncomplete` while it does. That is convergent and visible, not
 *     silent — but sizing the budgets for a membership-shaped scope is #5205's,
 *     and this comment is the recorded bound it inherits.
 */
export const SLACK_CHANNEL_HEALTH_PROBES_PER_CYCLE = 20;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SCOPE_ROW_SQL = `SELECT legacy_channels, reconciled_at
         FROM brain_slack_ingest_scope
        WHERE workspace_id = $1`;

/**
 * The poll scope: which channels a scheduled pass should read. DB-only — the
 * membership it reads was observed by the last {@link refreshSlackIngestScope}.
 */
export const POLL_SCOPE_SQL = `SELECT channel_id
         FROM brain_slack_channel
        WHERE workspace_id = $1 AND is_member = true AND excluded_at IS NULL
        ORDER BY channel_id ASC`;

const EXCLUDED_IN_MEMBERSHIP_SQL = `SELECT count(*)::int AS n
         FROM brain_slack_channel
        WHERE workspace_id = $1 AND is_member = true AND excluded_at IS NOT NULL`;

interface ScopeRow extends Record<string, unknown> {
  legacy_channels: string[] | null;
  reconciled_at: Date | null;
}

/**
 * Read one workspace's scope-row state. Exported so the poll scope, the event
 * predicate and the reconcile all decide `legacy-pending` from ONE query rather
 * than three spellings of it.
 */
async function readScopeMode(
  workspaceId: string,
): Promise<{ mode: SlackScopeMode; legacyChannels: readonly string[] }> {
  const rows = await internalQuery<ScopeRow>(SCOPE_ROW_SQL, [workspaceId]);
  if (rows.length === 0) return { mode: "membership", legacyChannels: [] };
  const row = rows[0];
  if (row.reconciled_at !== null) return { mode: "membership", legacyChannels: [] };
  // A NULL array cannot be written (the column is NOT NULL) but a hand-edited
  // row is not a reason to fall OPEN: an unreadable legacy scope degrades to
  // the empty allowlist, which ingests nothing, not to membership, which
  // ingests everything.
  return { mode: "legacy-pending", legacyChannels: row.legacy_channels ?? [] };
}

/** Every excluded channel id for one workspace — the set BOTH scope modes subtract. */
const EXCLUDED_CHANNEL_IDS_SQL = `SELECT channel_id
         FROM brain_slack_channel
        WHERE workspace_id = $1 AND excluded_at IS NOT NULL`;

/** Which channels the scheduled pass should read for this workspace. */
export async function resolveSlackPollScope(workspaceId: string): Promise<SlackIngestScope> {
  const { mode, legacyChannels } = await readScopeMode(workspaceId);
  if (mode === "legacy-pending") {
    // The captured allowlist MINUS exclusions — not the allowlist alone. An
    // admin exclusion always writes a row, whether or not the workspace has
    // reconciled yet, and an exclusion that only takes effect after the first
    // successful reconcile is one that never takes effect at all for a
    // workspace whose Slack read keeps failing — while the route that recorded
    // it has already answered 200 {changed: true}.
    const excluded = await internalQuery<{ channel_id: string }>(EXCLUDED_CHANNEL_IDS_SQL, [
      workspaceId,
    ]);
    const excludedIds = new Set(excluded.map((r) => r.channel_id));
    const channels = [...legacyChannels].filter((c) => !excludedIds.has(c)).sort();
    return { mode, channels, excludedInMembership: legacyChannels.length - channels.length };
  }
  const [rows, counted] = await Promise.all([
    internalQuery<{ channel_id: string }>(POLL_SCOPE_SQL, [workspaceId]),
    internalQuery<{ n: number }>(EXCLUDED_IN_MEMBERSHIP_SQL, [workspaceId]),
  ]);
  return {
    mode,
    channels: rows.map((r) => r.channel_id),
    excludedInMembership: counted[0]?.n ?? 0,
  };
}

const IS_EXCLUDED_SQL = `SELECT 1
         FROM brain_slack_channel
        WHERE workspace_id = $1 AND channel_id = $2 AND excluded_at IS NOT NULL
        LIMIT 1`;

/**
 * May an arriving webhook event for this channel be stored?
 *
 * Reads exclusions, NOT membership — see the module header's two-predicate
 * section for why that is correct rather than lax. Under `legacy-pending` it
 * additionally requires the captured allowlist, so a workspace mid-upgrade
 * cannot broaden through the fast path either; that arm is the reason this
 * cannot simply be "not excluded".
 *
 * The exclusion is consulted in BOTH modes, and first. An admin exclusion is a
 * confidentiality decision that took effect the moment the route wrote it;
 * making it wait on the first successful reconcile would keep ingesting the
 * channel — indefinitely, for a workspace whose Slack read keeps failing —
 * after the admin was told 200 {changed: true}.
 */
export async function isEventChannelInScope(
  workspaceId: string,
  channelId: string,
): Promise<boolean> {
  const [excludedRows, scope] = await Promise.all([
    internalQuery<Record<string, unknown>>(IS_EXCLUDED_SQL, [workspaceId, channelId]),
    readScopeMode(workspaceId),
  ]);
  if (excludedRows.length > 0) return false;
  if (scope.mode === "legacy-pending") return scope.legacyChannels.includes(channelId);
  return true;
}

// ---------------------------------------------------------------------------
// The per-sync refresh: membership, lazy reconcile, bounded health probes
// ---------------------------------------------------------------------------

export interface SlackScopeRefreshDeps {
  readonly fetchUserConversationsPage?: typeof fetchUserConversationsPage;
  readonly getConversationInfo?: typeof getConversationInfo;
  readonly fetchConversationHistoryPage?: typeof fetchConversationHistoryPage;
  readonly now?: () => Date;
}

export interface SlackScopeRefreshReport {
  readonly mode: SlackScopeMode;
  /** Channels the bot is a member of, as observed this pass. */
  readonly observed: number;
  /** Rows this pass marked `is_member = false`. Zero on an incomplete walk. */
  readonly retired: number;
  /** Exclusions written by the lazy reconcile. Non-zero at most once per workspace. */
  readonly reconciledExclusions: number;
  /** True when the membership enumeration hit its page bound. */
  readonly membershipIncomplete: boolean;
  readonly probed: number;
  readonly unhealthy: number;
  readonly warnings: readonly string[];
}

/**
 * Refresh one workspace's observed membership, reconcile a pending legacy
 * scope, and probe a bounded rotation of channels for health.
 *
 * Throws on a membership read failure — the caller (`episode-sync.ts`) turns it
 * into a recorded `status: "error"` attempt. A refresh that failed must NOT be
 * followed by a poll over whatever membership was last observed and then
 * reported green: that is the shape of M1's failure, and the whole point of
 * this change is that "Slack is connected" and "the brain is reading it" stop
 * being two facts that can disagree quietly.
 */
export async function refreshSlackIngestScope(params: {
  readonly workspaceId: string;
  readonly token: string;
  readonly deps?: SlackScopeRefreshDeps;
}): Promise<SlackScopeRefreshReport> {
  const { workspaceId, token } = params;
  const deps = params.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const listPage = deps.fetchUserConversationsPage ?? fetchUserConversationsPage;
  const warnings: string[] = [];

  // ── 1. Enumerate the bot's memberships ──────────────────────────────────
  const observed: SlackConversationInfo[] = [];
  const seen = new Set<string>();
  const unusableIds: string[] = [];
  let cursor: string | undefined;
  let membershipIncomplete = false;
  for (let page = 0; ; page++) {
    if (page >= MEMBERSHIP_MAX_PAGES) {
      membershipIncomplete = true;
      warnings.push(
        `Slack returned more than ${MEMBERSHIP_MAX_PAGES * MEMBERSHIP_PAGE_LIMIT} conversations for this bot — channels past that bound are not in scope this cycle, and no channel was retired.`,
      );
      break;
    }
    const result = await listPage(token, {
      limit: MEMBERSHIP_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!result.ok) {
      // Not degraded to "no channels": an empty membership would retire every
      // channel in the workspace below, i.e. turn a transient Slack fault into
      // a silent, total scope loss.
      throw new Error(
        `Could not read this workspace's Slack channel membership (${result.error}) — the brain's ingest scope is the bot's membership, so nothing was read this cycle. It retries on the next.`,
      );
    }
    for (const channel of result.channels) {
      // A conversation whose id the stored-key pattern refuses (a `D…` DM, most
      // likely — Slack returns them for `im` types and a future widening of the
      // `types=` param would surface them here) is skipped rather than stored:
      // the id is interpolated into a `source_id` and an `audience:` grant, and
      // the table's CHECK would reject the row anyway. Counted as a warning so
      // "why is that channel not in scope?" has an answer.
      if (!SLACK_CHANNEL_ID_PATTERN.test(channel.id)) {
        unusableIds.push(channel.id);
        continue;
      }
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      observed.push(channel);
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  if (unusableIds.length > 0) {
    warnings.push(
      `Slack returned ${unusableIds.length} conversation${unusableIds.length === 1 ? "" : "s"} whose id is not a channel (e.g. ${unusableIds[0].slice(0, 12)}) — DMs and other non-channel conversations are never in ingest scope.`,
    );
  }

  // ── 2 + 3. Persist membership and reconcile, in ONE transaction ──────────
  // They are one unit because the reconcile's exclusion set is computed FROM
  // the membership this pass observed. Committing the membership first and
  // failing the reconcile would leave a workspace whose scope row still says
  // `legacy-pending` beside rows that already say `is_member = true` — which is
  // harmless only because the read path keys on the scope row, and is exactly
  // the kind of "harmless only because" a later refactor breaks.
  const observedAt = now().toISOString();
  const outcome = await withBrainTransaction(async (tx) => {
    for (const channel of observed) {
      await tx.query(
        `INSERT INTO brain_slack_channel
           (workspace_id, channel_id, name, is_private, is_archived, is_member,
            first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6, now(), now())
         ON CONFLICT (workspace_id, channel_id) DO UPDATE
           SET name = EXCLUDED.name,
               is_private = EXCLUDED.is_private,
               is_archived = EXCLUDED.is_archived,
               is_member = true,
               -- COALESCE keeps the ORIGINAL first sighting: this row may
               -- pre-date the membership (an admin excluded the channel before
               -- the bot was ever seen in it), and overwriting would make every
               -- channel look newly discovered on every cycle.
               first_seen_at = COALESCE(brain_slack_channel.first_seen_at, EXCLUDED.first_seen_at),
               last_seen_at = EXCLUDED.last_seen_at,
               updated_at = now()`,
        [
          workspaceId,
          channel.id,
          channel.name,
          channel.isPrivate,
          channel.isArchived,
          observedAt,
        ],
      );
    }

    // Retire rows the bot is no longer in — but ONLY on a complete walk. A
    // truncated enumeration cannot distinguish "left the channel" from "past
    // the page bound", and retiring on it would narrow scope silently, which is
    // the failure this module exists to make impossible.
    let retired = 0;
    if (!membershipIncomplete) {
      const result = await tx.query(
        `UPDATE brain_slack_channel
            SET is_member = false, updated_at = now()
          WHERE workspace_id = $1
            AND is_member = true
            AND NOT (channel_id = ANY($2::text[]))
          RETURNING channel_id`,
        [workspaceId, observed.map((c) => c.id)],
      );
      retired = result.rows.length;
    }

    // ── The lazy reconcile ────────────────────────────────────────────────
    // Every channel the bot is in that the retired installs did NOT scope
    // becomes an exclusion. That is the no-broadening guarantee, and it is
    // stated as a set difference rather than an enumeration: a workspace scoped
    // to 3 of 100 gets 97 exclusions and keeps reading exactly its 3.
    //
    // ⚠️ Guarded on a COMPLETE membership walk, exactly like the retire above
    // and for the same reason pointed the other way. The exclusion set is
    // `observed − legacy`, so a truncated enumeration computes exclusions from
    // a partial `observed`: every channel past the page bound gets NO exclusion
    // row, and stamping `reconciled_at` off that walk flips the workspace onto
    // membership mode with those channels in scope unexcluded — silent
    // broadening, through the reconcile that exists to prevent it (AC-5). An
    // incomplete walk leaves the workspace `legacy-pending`; the captured
    // allowlist stays the scope and the next complete walk reconciles.
    //
    // `NOT EXISTS` rather than `ON CONFLICT DO NOTHING`, because an ADMIN
    // exclusion written between the migration and this reconcile must keep its
    // own author and reason. `DO NOTHING` would preserve it too, but only by
    // accident of ordering; this says so.
    const scopeRows = await tx.query(SCOPE_ROW_SQL, [workspaceId]);
    let reconciledExclusions = 0;
    let wasPending = false;
    let reconciledThisPass = false;
    if (scopeRows.rows.length > 0) {
      const row = scopeRows.rows[0] as ScopeRow;
      if (row.reconciled_at === null) wasPending = true;
      if (row.reconciled_at === null && !membershipIncomplete) {
        reconciledThisPass = true;
        const legacy = row.legacy_channels ?? [];
        const inserted = await tx.query(
          `INSERT INTO brain_slack_channel
             (workspace_id, channel_id, is_member, excluded_at, exclusion_reason,
              excluded_by, created_at, updated_at)
           SELECT $1, c.channel_id, true, now(),
                  'Outside the channel scope this workspace had configured before Atlas moved Slack ingest onto the bot''s channel membership (#5203). Remove the exclusion to start reading it.',
                  'migration:5203', now(), now()
             FROM unnest($2::text[]) AS c(channel_id)
            WHERE NOT (c.channel_id = ANY($3::text[]))
              AND NOT EXISTS (
                    SELECT 1 FROM brain_slack_channel existing
                     WHERE existing.workspace_id = $1
                       AND existing.channel_id = c.channel_id
                       AND existing.excluded_at IS NOT NULL)
           ON CONFLICT (workspace_id, channel_id) DO UPDATE
             SET excluded_at = EXCLUDED.excluded_at,
                 exclusion_reason = EXCLUDED.exclusion_reason,
                 excluded_by = EXCLUDED.excluded_by,
                 updated_at = now()
           RETURNING channel_id`,
          [workspaceId, observed.map((c) => c.id), legacy],
        );
        reconciledExclusions = inserted.rows.length;
        await tx.query(
          `UPDATE brain_slack_ingest_scope
              SET reconciled_at = now(), updated_at = now()
            WHERE workspace_id = $1 AND reconciled_at IS NULL`,
          [workspaceId],
        );
      }
    }
    return { retired, reconciledExclusions, wasPending, reconciledThisPass };
  });

  if (outcome.reconciledThisPass) {
    log.info(
      {
        workspaceId,
        observed: observed.length,
        reconciledExclusions: outcome.reconciledExclusions,
      },
      "brain slack scope: reconciled a pre-#5203 workspace — the channels it had configured stay in scope, every other channel the bot is in was excluded",
    );
  } else if (outcome.wasPending) {
    // Skipped BECAUSE the walk was incomplete — say so where the sync report
    // can carry it, not only in a log line. The workspace keeps its captured
    // allowlist (fail-closed) and the next complete enumeration reconciles.
    warnings.push(
      "This workspace's pre-#5203 channel scope was not reconciled this cycle: the membership enumeration hit its page bound, and reconciling against a partial membership would let channels past the bound into scope unexcluded. The captured channel list remains the scope until a complete enumeration.",
    );
    log.warn(
      { workspaceId, observed: observed.length },
      "brain slack scope: reconcile deferred — membership enumeration was incomplete; the workspace stays legacy-pending",
    );
  }

  // ── 4. The surviving two-probe verification, as a bounded rotation ───────
  const probe = await probeChannelHealth({ workspaceId, token, deps, now });

  return {
    // The mode a CALLER should act on is the post-reconcile one. When this pass
    // reconciled (or the workspace never was pending), that is membership;
    // when the reconcile was deferred on an incomplete walk, the workspace is
    // STILL legacy-pending and reporting membership here would have the caller
    // act on the broadened scope the deferral just refused to stamp.
    mode: outcome.wasPending && !outcome.reconciledThisPass ? "legacy-pending" : "membership",
    observed: observed.length,
    retired: outcome.retired,
    reconciledExclusions: outcome.reconciledExclusions,
    membershipIncomplete,
    probed: probe.probed,
    unhealthy: probe.unhealthy,
    warnings: [...warnings, ...probe.warnings],
  };
}

/**
 * The retired install handler's TWO-PROBE verification, relocated.
 *
 * `conversations.info` answers existence, membership and visibility;
 * `conversations.history` with `limit: 1` answers whether the token can read a
 * single message. The second is NOT redundant with the first — `conversations.info`
 * is gated on `channels:read`/`groups:read`, which the chat adapter's token
 * already holds, so it returns fine for a token that cannot read history at
 * all. That was true when the probe ran at install time and it is true now.
 *
 * What changed is WHERE the answer goes. There is no install to refuse, so a
 * failure is recorded on the channel row and surfaced in admin instead of
 * raised as a field error. The alternative — dropping the probes with the
 * install — would turn three legible failures ("the bot isn't in that channel",
 * "that channel doesn't exist", "the token can't read history") back into
 * per-cycle sync errors nobody reads, which is the exact regression this ticket
 * is about.
 */
async function probeChannelHealth(params: {
  readonly workspaceId: string;
  readonly token: string;
  readonly deps: SlackScopeRefreshDeps;
  readonly now: () => Date;
}): Promise<{ probed: number; unhealthy: number; warnings: readonly string[] }> {
  const { workspaceId, token, deps } = params;
  const probeInfo = deps.getConversationInfo ?? getConversationInfo;
  const probeHistory = deps.fetchConversationHistoryPage ?? fetchConversationHistoryPage;

  // Oldest check first, never-probed channels ahead of everything. Fair
  // rotation on `brain_audience_reverify_attempt`'s model — the ORDER BY is the
  // whole scheduler.
  const due = await internalQuery<{ channel_id: string }>(
    `SELECT channel_id
       FROM brain_slack_channel
      WHERE workspace_id = $1 AND is_member = true AND excluded_at IS NULL
      ORDER BY health_checked_at ASC NULLS FIRST, channel_id ASC
      LIMIT $2`,
    [workspaceId, SLACK_CHANNEL_HEALTH_PROBES_PER_CYCLE],
  );

  const warnings: string[] = [];
  let unhealthy = 0;
  for (const { channel_id: channelId } of due) {
    let status: "ok" | "error" = "ok";
    let error: string | null = null;

    const info = await probeInfo(token, channelId);
    if (!info.ok) {
      status = "error";
      error = channelProbeMessage(channelId, info.error);
    } else if (!info.channel.isMember) {
      status = "error";
      error = `Atlas is not a member of #${info.channel.name} (${channelId}) — invite the Atlas bot to the channel, or exclude it to stop checking.`;
    } else {
      const history = await probeHistory(token, { channel: channelId, limit: 1 });
      if (!history.ok) {
        status = "error";
        error = historyProbeMessage(channelId, history.error);
      }
    }

    if (status === "error") {
      unhealthy++;
      if (error !== null && warnings.length < 5) warnings.push(error);
    }
    try {
      await internalQuery(
        `UPDATE brain_slack_channel
            SET health_status = $3, health_error = $4, health_checked_at = now(), updated_at = now()
          WHERE workspace_id = $1 AND channel_id = $2`,
        [workspaceId, channelId, status, error],
      );
    } catch (err) {
      // Logged, not thrown, and not silent. The health record is diagnostic —
      // failing the whole sync because one channel's verdict could not be
      // persisted would trade a legible warning for an outage. It IS logged
      // because a channel whose `health_checked_at` never advances sits at the
      // head of the rotation forever and starves every other channel's probe,
      // which is a real failure wearing the shape of a quiet one.
      log.warn(
        { workspaceId, channelId, err: errorMessage(err) },
        "brain slack scope: could not record a channel health verdict — this channel stays at the head of the probe rotation",
      );
    }
  }

  return { probed: due.length, unhealthy, warnings };
}

/** Map a `conversations.info` probe error to an actionable admin-facing message. */
function channelProbeMessage(channelId: string, error: string): string {
  switch (error) {
    case "channel_not_found":
      return `Slack no longer recognises the channel id ${channelId} — it was deleted, or the bot lost access to it.`;
    case "missing_scope":
      return `The workspace's Slack connection cannot look this channel up — reconnect Slack under Admin → Integrations to grant the channels:read and groups:read scopes.`;
    case "ratelimited":
      return `Slack is rate limiting this workspace right now — the next cycle re-checks ${channelId}.`;
    default:
      return `Slack rejected the check for channel ${channelId}: ${error}.`;
  }
}

/** Map a `conversations.history` probe error to an actionable admin-facing message. */
function historyProbeMessage(channelId: string, error: string): string {
  switch (error) {
    case "missing_scope":
      return `The workspace's Slack connection cannot read message history — reconnect Slack under Admin → Integrations to grant the channels:history and groups:history scopes. Until then no channel is readable.`;
    case "not_in_channel":
      return `Atlas is not a member of ${channelId} — invite the Atlas bot to the channel, or exclude it to stop checking.`;
    case "ratelimited":
      return `Slack is rate limiting this workspace right now — the next cycle re-checks ${channelId}.`;
    default:
      return `Slack refused to return history for ${channelId}: ${error}.`;
  }
}

// ---------------------------------------------------------------------------
// Admin surface: the exclusion list + the sync verdict
// ---------------------------------------------------------------------------

/** The per-workspace Slack sync's last recorded attempt, for the admin surface. */
export interface SlackEpisodeSyncStatus {
  readonly lastSyncAt: string | null;
  readonly status: "success" | "error";
  readonly error: string | null;
  readonly coverageIncomplete: boolean;
}

/**
 * Read the brain's Slack sync bookkeeping for one workspace — the row the
 * per-workspace dispatch books under {@link SLACK_EPISODE_SYNC_ID}.
 *
 * This reader exists because the retirement removed the surface that used to
 * show it: the `slack-history` install's collection card rendered
 * `knowledge_sync_state` through the admin-knowledge list, and that list
 * enumerates installs, which this source no longer has. Without a reader, a
 * revoked token's carefully-worded "reconnect Slack under Admin →
 * Integrations" error would be RECORDED every cycle and READ by nobody — the
 * green-but-frozen surface this whole ticket exists to end, one layer up.
 *
 * `null` means no attempt has been recorded yet (a fresh workspace before its
 * first cycle) — distinct from an error, and the surface says so.
 */
export async function readSlackEpisodeSyncStatus(
  workspaceId: string,
): Promise<SlackEpisodeSyncStatus | null> {
  const rows = await internalQuery<Record<string, unknown>>(
    `SELECT last_sync_at, status, error, report
       FROM knowledge_sync_state
      WHERE workspace_id = $1 AND collection_id = $2`,
    [workspaceId, SLACK_EPISODE_SYNC_ID],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const report =
    typeof row.report === "object" && row.report !== null
      ? (row.report as Record<string, unknown>)
      : {};
  return {
    lastSyncAt: isoOrNull(row.last_sync_at),
    // Narrowed fail-closed: an unrecognized status renders as an error, never
    // as a green the writer did not record.
    status: row.status === "success" ? "success" : "error",
    error: typeof row.error === "string" && row.error !== "" ? row.error : null,
    coverageIncomplete: report.coverageIncomplete === true,
  };
}

export interface SlackChannelRow {
  readonly channelId: string;
  readonly name: string | null;
  readonly isPrivate: boolean | null;
  readonly isArchived: boolean;
  readonly isMember: boolean;
  readonly excludedAt: string | null;
  readonly exclusionReason: string | null;
  readonly excludedBy: string | null;
  readonly healthStatus: "ok" | "error" | null;
  readonly healthError: string | null;
  readonly healthCheckedAt: string | null;
  readonly lastSeenAt: string | null;
}

/** Every channel Atlas knows about for this workspace — the admin listing. */
export async function listSlackChannels(workspaceId: string): Promise<readonly SlackChannelRow[]> {
  const rows = await internalQuery<Record<string, unknown>>(
    `SELECT channel_id, name, is_private, is_archived, is_member, excluded_at,
            exclusion_reason, excluded_by, health_status, health_error,
            health_checked_at, last_seen_at
       FROM brain_slack_channel
      WHERE workspace_id = $1
      ORDER BY (excluded_at IS NOT NULL) ASC, name ASC NULLS LAST, channel_id ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    channelId: String(r.channel_id),
    name: r.name === null ? null : String(r.name),
    isPrivate: typeof r.is_private === "boolean" ? r.is_private : null,
    isArchived: r.is_archived === true,
    isMember: r.is_member === true,
    excludedAt: isoOrNull(r.excluded_at),
    exclusionReason: r.exclusion_reason === null ? null : String(r.exclusion_reason),
    excludedBy: r.excluded_by === null ? null : String(r.excluded_by),
    healthStatus: r.health_status === "ok" || r.health_status === "error" ? r.health_status : null,
    healthError: r.health_error === null ? null : String(r.health_error),
    healthCheckedAt: isoOrNull(r.health_checked_at),
    lastSeenAt: isoOrNull(r.last_seen_at),
  }));
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

/**
 * A caller handed the scope writers something that is not a Slack channel id.
 * Its own class so the admin route can map it to a 400 by TYPE — matching the
 * message text would silently become a 500 the day the wording changes.
 */
export class InvalidSlackChannelIdError extends Error {
  override readonly name = "InvalidSlackChannelIdError";
}

/**
 * Normalize a caller-supplied channel id, or throw
 * {@link InvalidSlackChannelIdError}. ONE normalizer for both scope verbs and
 * the route, so "exclude validates but include doesn't" cannot recur — the
 * include verb WIDENS retention scope, which makes it the more consequential
 * of the pair to hand a garbage id to.
 */
export function normalizeSlackChannelId(raw: string): string {
  const channelId = raw.trim().toUpperCase();
  if (!SLACK_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new InvalidSlackChannelIdError(
      `"${raw.slice(0, 40)}" is not a Slack channel ID — IDs start with C or G (e.g. C01ABCDEF).`,
    );
  }
  return channelId;
}

/**
 * Exclude a channel from ingest. Idempotent, and it does NOT overwrite an
 * existing exclusion's author or reason — re-excluding an excluded channel is a
 * no-op rather than a silent re-attribution of someone else's decision.
 *
 * A channel the bot has never been seen in may be excluded: the row is created
 * with `is_member = false`, which is out of scope for the poll anyway and
 * becomes the thing that keeps it out when the bot IS eventually invited.
 *
 * Returns whether a NEW exclusion was written — `false` means the channel was
 * already excluded and nothing (author and reason included) changed. The route
 * schema promises exactly that split, and hardcoding `true` there told an
 * admin their re-exclusion took effect while the recorded author stayed
 * someone else's.
 */
export async function excludeSlackChannel(params: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly reason: string | null;
  readonly actor: string;
}): Promise<boolean> {
  const channelId = normalizeSlackChannelId(params.channelId);
  if (params.actor.trim() === "") {
    // The CHECK would reject it, but a constraint violation surfaces as a 500
    // with a Postgres message. An exclusion is a confidentiality decision and
    // its author is not optional; say so where the caller can act on it.
    throw new Error("An exclusion must record who made it.");
  }
  // The pre-statement state is read through a CTE (a CTE sees the snapshot
  // BEFORE the INSERT runs), because RETURNING alone only shows the post-write
  // row and this verb's no-op case — "already excluded" — is defined by what
  // was there before.
  const rows = await internalQuery<{ was_excluded: boolean | null }>(
    `WITH prior AS (
       SELECT excluded_at FROM brain_slack_channel
        WHERE workspace_id = $1 AND channel_id = $2
     )
     INSERT INTO brain_slack_channel
       (workspace_id, channel_id, is_member, excluded_at, exclusion_reason, excluded_by,
        created_at, updated_at)
     VALUES ($1, $2, false, now(), $3, $4, now(), now())
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET excluded_at = COALESCE(brain_slack_channel.excluded_at, EXCLUDED.excluded_at),
           -- Attribution follows the FIRST exclusion. Re-excluding an already
           -- excluded channel must not silently re-author someone else's
           -- decision, and is_member is deliberately untouched: the row may
           -- describe an observed member and this verb says nothing about that.
           exclusion_reason = CASE WHEN brain_slack_channel.excluded_at IS NULL
                                   THEN EXCLUDED.exclusion_reason
                                   ELSE brain_slack_channel.exclusion_reason END,
           excluded_by = CASE WHEN brain_slack_channel.excluded_at IS NULL
                              THEN EXCLUDED.excluded_by
                              ELSE brain_slack_channel.excluded_by END,
           updated_at = now()
     RETURNING (SELECT excluded_at IS NOT NULL FROM prior) AS was_excluded`,
    [params.workspaceId, channelId, params.reason, params.actor.trim()],
  );
  // NULL = no prior row at all (fresh insert) — a change, like a prior
  // unexcluded row. Only a prior row that was ALREADY excluded is the no-op.
  return rows[0]?.was_excluded !== true;
}

/**
 * Return a channel to ingest scope. Clears the whole exclusion, attribution
 * included. Validates through the same normalizer as the exclude verb — this
 * one WIDENS what Atlas retains, so a garbage id answering `changed: false`
 * instead of a 400 would be the laxer half of the pair.
 */
export async function includeSlackChannel(params: {
  readonly workspaceId: string;
  readonly channelId: string;
}): Promise<boolean> {
  const channelId = normalizeSlackChannelId(params.channelId);
  const rows = await internalQuery<{ channel_id: string }>(
    `UPDATE brain_slack_channel
        SET excluded_at = NULL, exclusion_reason = NULL, excluded_by = NULL, updated_at = now()
      WHERE workspace_id = $1 AND channel_id = $2 AND excluded_at IS NOT NULL
      RETURNING channel_id`,
    [params.workspaceId, channelId],
  );
  return rows.length > 0;
}
