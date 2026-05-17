/**
 * Pause registry (#2295, PRD #2291).
 *
 * Reads + writes the `proactive_pauses` table that backs the proactive
 * chat three-layer kill switch + per-user opt-out.
 *
 * Four layers, four shapes:
 *   workspace-kill   one row per workspace (channel_id NULL, user_id NULL,
 *                    indefinite). Admin "pause all proactive".
 *   admin-channel    per-channel admin deny (channel_id NOT NULL,
 *                    user_id NULL, indefinite).
 *   user-optout      DM `unsubscribe` (channel_id NULL, user_id NOT NULL,
 *                    indefinite).
 *   channel-24h      In-channel `@atlas pause` (channel_id NOT NULL,
 *                    user_id NULL, expires_at = now() + 24h).
 *
 * Precedence (resolved in `decidePauseFromRows`):
 *   workspace-kill > admin-channel > user-optout > channel-24h
 *
 * Routes that mutate pauses must enforce `requireEnterpriseEffect`
 * outside this module — the registry stays gate-agnostic so tests +
 * the plugin host can both consume it without dragging in `@atlas/ee`.
 *
 * The pure `decidePauseFromRows` function is exported separately so
 * unit tests can exercise the precedence + expiry truth table without
 * a database.
 */
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("proactive:pause-registry");

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Layer values stored in `proactive_pauses.layer`. */
export type PauseLayer =
  | "workspace-kill"
  | "admin-channel"
  | "user-optout"
  | "channel-24h";

/** Outcome of a pause lookup. */
export interface PauseDecision {
  paused: boolean;
  /** Epoch ms when the pause expires; undefined for indefinite pauses. */
  until?: number;
  /** Highest-precedence matching layer. Undefined when `paused === false`. */
  layer?: PauseLayer;
}

/** Row shape read from `proactive_pauses`. */
export interface PauseRow {
  id: string;
  workspaceId: string;
  channelId: string | null;
  userId: string | null;
  layer: PauseLayer;
  /** Epoch ms when the row expires; `null` = indefinite. */
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Pure precedence resolver
// ---------------------------------------------------------------------------

/**
 * Precedence (highest → lowest):
 *
 *   workspace-kill   silences every channel in the workspace, indefinite.
 *   admin-channel    silences a specific channel, indefinite.
 *   user-optout      silences a specific user across the workspace.
 *   channel-24h      silences a specific channel for 24h.
 *
 * Rationale: admin actions trump user actions trump time-bound mutes.
 * The user-optout row must out-rank the channel-24h row because an
 * opted-out user shouldn't see Atlas un-mute itself when a channel-24h
 * row in a different channel expires.
 */
const LAYER_PRIORITY: Record<PauseLayer, number> = {
  "workspace-kill": 4,
  "admin-channel": 3,
  "user-optout": 2,
  "channel-24h": 1,
};

/**
 * Pure precedence-aware reducer over a candidate row set.
 *
 * Caller is responsible for pre-filtering to rows that match the
 * `(workspace, channel, user)` tuple under inspection — this function
 * does not check `channelId === input.channelId` etc., so passing in
 * unrelated rows would mis-attribute the pause. Production callers
 * pass exactly the filtered rows returned by the SQL lookup.
 *
 * Rows whose `expiresAt` is non-null and `<= now` are ignored — they
 * have functionally expired even if the sweeper hasn't pruned them
 * yet. Rows whose `expiresAt` is null are treated as indefinite.
 */
export function decidePauseFromRows(
  rows: ReadonlyArray<PauseRow>,
  now: number,
): PauseDecision {
  let winner: PauseRow | null = null;
  for (const row of rows) {
    if (row.expiresAt !== null && row.expiresAt <= now) continue;
    if (!winner) {
      winner = row;
      continue;
    }
    if (LAYER_PRIORITY[row.layer] > LAYER_PRIORITY[winner.layer]) {
      winner = row;
    }
  }
  if (!winner) return { paused: false };
  return {
    paused: true,
    layer: winner.layer,
    ...(winner.expiresAt !== null ? { until: winner.expiresAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// DB-backed registry
// ---------------------------------------------------------------------------

interface RawPauseRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  user_id: string | null;
  layer: PauseLayer;
  expires_at: Date | string | null;
  created_at: Date | string;
}

function toPauseRow(raw: RawPauseRow): PauseRow {
  return {
    id: raw.id,
    workspaceId: raw.workspace_id,
    channelId: raw.channel_id,
    userId: raw.user_id,
    layer: raw.layer,
    expiresAt:
      raw.expires_at === null
        ? null
        : typeof raw.expires_at === "string"
          ? new Date(raw.expires_at).getTime()
          : raw.expires_at.getTime(),
  };
}

/**
 * Read every non-expired pause row that could match the supplied
 * `(workspaceId, channelId, userId?)` tuple.
 *
 * Matched shapes:
 *   - workspace-kill: workspace_id = $1, channel_id IS NULL, user_id IS NULL
 *   - admin-channel:  workspace_id = $1, channel_id = $2,    user_id IS NULL
 *   - user-optout:    workspace_id = $1, channel_id IS NULL, user_id = $3
 *   - channel-24h:    workspace_id = $1, channel_id = $2,    user_id IS NULL
 *
 * One SQL round-trip; `decidePauseFromRows` resolves precedence in
 * application code so the test surface stays pure.
 */
async function fetchCandidateRows(input: {
  workspaceId: string;
  channelId: string | null;
  userId?: string;
}): Promise<PauseRow[]> {
  if (!hasInternalDB()) return [];
  const { workspaceId, channelId, userId } = input;
  const rows = await internalQuery<RawPauseRow>(
    `
    SELECT id, workspace_id, channel_id, user_id, layer, expires_at, created_at
    FROM proactive_pauses
    WHERE workspace_id = $1
      AND (
        -- workspace-kill: scoped to workspace
        (channel_id IS NULL AND user_id IS NULL)
        -- admin-channel + channel-24h: scoped to channel
        OR ($2::text IS NOT NULL AND channel_id = $2 AND user_id IS NULL)
        -- user-optout: scoped to user
        OR ($3::text IS NOT NULL AND user_id = $3 AND channel_id IS NULL)
      )
      AND (expires_at IS NULL OR expires_at > NOW())
    `,
    [workspaceId, channelId, userId ?? null],
  );
  return rows.map(toPauseRow);
}

/**
 * Resolve a pause decision for `(workspaceId, channelId, userId?)`.
 *
 * Fails CLOSED on DB errors — returning `{ paused: true, layer:
 * "workspace-kill" }` keeps Atlas silent when the registry hiccups.
 * The kill switch's product contract is "when an admin or user wanted
 * silence, deliver silence" — degrading to "keep answering" on a DB
 * blip defeats every layer (workspace-kill, admin-channel deny,
 * user-optout, channel-24h). CLAUDE.md §Error Handling: "`catch
 * { return false }` on a security check is a bug. Return 500, not a
 * false negative." This is the catch.
 *
 * Logs at `error` (not `warn`) so on-call alerting surfaces the
 * outage — a sustained read failure now produces user-visible silence
 * AND an error log, both of which beat silent fail-open.
 */
export async function isPaused(input: {
  workspaceId: string;
  channelId: string;
  userId?: string;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}): Promise<PauseDecision> {
  const now = input.now ? input.now() : Date.now();
  try {
    const rows = await fetchCandidateRows({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      userId: input.userId,
    });
    return decidePauseFromRows(rows, now);
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        userId: input.userId,
      },
      "PauseRegistry read failed — failing CLOSED (Atlas silenced until registry recovers)",
    );
    return { paused: true, layer: "workspace-kill" };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface PauseWriteInput {
  workspaceId: string;
  /** Required for channel-scoped layers; null for workspace/user. */
  channelId: string | null;
  /** Required for `user-optout`; null otherwise. */
  userId: string | null;
  layer: PauseLayer;
  /** ms from `requestedAt`; null means indefinite. */
  durationMs: number | null;
  /** Epoch ms baseline for `expires_at`. */
  requestedAt: number;
}

/**
 * Insert a pause row.
 *
 * Validates the (layer, channelId, userId) tuple at runtime to keep
 * malformed rows out of the table. We could push these into the
 * migration with a richer CHECK, but a runtime guard gives clearer
 * test failures + a single error surface for the route + plugin host.
 */
export async function persistPause(input: PauseWriteInput): Promise<void> {
  validateShape(input);
  const expiresAt =
    input.durationMs === null ? null : new Date(input.requestedAt + input.durationMs);
  await internalQuery(
    `
    INSERT INTO proactive_pauses (workspace_id, channel_id, user_id, layer, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [input.workspaceId, input.channelId, input.userId, input.layer, expiresAt],
  );
}

/**
 * Expire every non-expired row matching the supplied scope.
 *
 * Used by:
 *   - `DELETE /api/v1/admin/proactive/pause` (workspace-kill clear)
 *   - future admin "lift a channel pause" surface
 *
 * Sets `expires_at = NOW()` rather than DELETEing so a forensic query
 * later can see "this row was lifted at T2" without joining a separate
 * audit table.
 */
export async function expirePauses(input: {
  workspaceId: string;
  layer: PauseLayer;
  channelId?: string | null;
  userId?: string | null;
}): Promise<void> {
  await internalQuery(
    `
    UPDATE proactive_pauses
    SET expires_at = NOW()
    WHERE workspace_id = $1
      AND layer = $2
      AND ($3::text IS NULL OR channel_id = $3)
      AND ($4::text IS NULL OR user_id = $4)
      AND (expires_at IS NULL OR expires_at > NOW())
    `,
    [
      input.workspaceId,
      input.layer,
      input.channelId ?? null,
      input.userId ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

function validateShape(input: PauseWriteInput): void {
  switch (input.layer) {
    case "workspace-kill":
      if (input.channelId !== null || input.userId !== null) {
        throw new Error(
          "workspace-kill rows must carry channel_id IS NULL AND user_id IS NULL",
        );
      }
      if (input.durationMs !== null) {
        throw new Error("workspace-kill rows must be indefinite (durationMs = null)");
      }
      return;
    case "admin-channel":
      if (input.channelId === null) {
        throw new Error("admin-channel rows must carry channel_id");
      }
      if (input.userId !== null) {
        throw new Error("admin-channel rows must carry user_id IS NULL");
      }
      return;
    case "user-optout":
      if (input.userId === null) {
        throw new Error("user-optout rows must carry user_id");
      }
      if (input.channelId !== null) {
        throw new Error("user-optout rows are workspace-scoped (channel_id IS NULL)");
      }
      return;
    case "channel-24h":
      if (input.channelId === null) {
        throw new Error("channel-24h rows must carry channel_id");
      }
      if (input.userId !== null) {
        throw new Error("channel-24h rows must carry user_id IS NULL");
      }
      if (input.durationMs === null) {
        throw new Error("channel-24h rows must carry a positive durationMs");
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Plugin-host adapter
// ---------------------------------------------------------------------------

/**
 * Translate the chat plugin's `onPauseRequest` shape into a registry write.
 *
 * The plugin builds an opaque request `{ workspaceId, channelId, userId,
 * layer, durationMs, requestedAt }` and hands it to the host; this
 * function is the host-side bridge. Kept here (not in the plugin) so
 * the plugin remains free of `@atlas/api` imports.
 */
export async function handlePluginPauseRequest(request: {
  workspaceId: string;
  channelId: string | null;
  userId: string;
  layer: PauseLayer;
  durationMs: number | null;
  requestedAt: number;
}): Promise<void> {
  // The plugin's `user-optout` always carries channelId from the message
  // event, but the registry stores user-optout as workspace-scoped, so
  // drop the channelId before persisting.
  const channelId = request.layer === "user-optout" ? null : request.channelId;
  // user-optout is the only layer that actually persists user_id; the
  // other layers must carry user_id IS NULL.
  const userId = request.layer === "user-optout" ? request.userId : null;
  await persistPause({
    workspaceId: request.workspaceId,
    channelId,
    userId,
    layer: request.layer,
    durationMs: request.durationMs,
    requestedAt: request.requestedAt,
  });
  log.info(
    {
      workspaceId: request.workspaceId,
      channelId,
      userId,
      layer: request.layer,
      durationMs: request.durationMs,
    },
    "Proactive: pause row persisted",
  );
}
