/**
 * FavoritePromptStore — per-user pinned starter prompts (#1475, PRD #1473).
 *
 * The personal-productivity tier of the adaptive starter-prompt surface.
 * Pins are per-user and per-workspace: always render for the owner, never
 * moderated by the admin queue, never drafted in the 1.2.0 mode system.
 *
 * This module owns:
 *   - list / create / delete / updatePosition against `user_favorite_prompts`
 *   - cap enforcement (configurable, default 10 per user-workspace)
 *   - duplicate detection (unique index catches, we translate to a typed error)
 *   - text trimming + length cap (DB is not the cap; service is, so ops can
 *     raise the default via config without a migration)
 *   - forbidden vs not_found differentiation on cross-user access, so the
 *     route layer can return 403 instead of leaking existence via 404
 */
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";

const log = createLogger("favorite-store");

/**
 * Hard ceiling on pinnable text. The DB index uses md5() so Postgres can
 * always store the row, but keeping text bounded at the service boundary
 * prevents a user from pinning a whole chat transcript by accident and
 * keeps the empty-state grid readable.
 */
export const FAVORITE_TEXT_MAX_LENGTH = 2000;

const PG_UNIQUE_VIOLATION = "23505";

export interface FavoritePromptRow {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly text: string;
  readonly position: number;
  readonly createdAt: Date;
}

/**
 * Cap enforcement failure — surfaced as a user-visible 400 by the route
 * layer. Message is safe to show the user directly.
 */
export class FavoriteCapError extends Error {
  public readonly _tag = "FavoriteCapError" as const;
  constructor(public readonly cap: number) {
    super(
      `You've reached the maximum of ${cap} pinned starter prompts. Unpin one before adding another.`,
    );
    this.name = "FavoriteCapError";
  }
}

/**
 * Duplicate pin — the same user already has this text pinned in this
 * workspace. Route layer surfaces as 409. Message references the existing
 * pin so the UI can explain "already pinned".
 */
export class DuplicateFavoriteError extends Error {
  public readonly _tag = "DuplicateFavoriteError" as const;
  constructor() {
    super("This prompt is already pinned.");
    this.name = "DuplicateFavoriteError";
  }
}

export type DeleteResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "forbidden" };

export type UpdatePositionResult =
  | { status: "ok"; favorite: FavoritePromptRow }
  | { status: "not_found" }
  | { status: "forbidden" };

interface RawRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  org_id: string;
  text: string;
  position: number | string;
  created_at: Date | string;
}

function toRow(row: RawRow): FavoritePromptRow {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    text: row.text,
    position:
      typeof row.position === "string" ? parseFloat(row.position) : row.position,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
  };
}

/**
 * List a user's pins for one workspace, most-recently-pinned first.
 * Returns `[]` when the internal DB is not configured — favorites become
 * a no-op rather than crashing the resolver.
 */
export async function listFavorites(
  userId: string,
  orgId: string,
): Promise<FavoritePromptRow[]> {
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<RawRow>(
    `SELECT id, user_id, org_id, text, position, created_at
     FROM user_favorite_prompts
     WHERE user_id = $1 AND org_id = $2
     ORDER BY position DESC, created_at DESC`,
    [userId, orgId],
  );
  return rows.map(toRow);
}

/**
 * Pin `text` for `(userId, orgId)`. Enforces the cap at the service layer
 * — the DB has no CHECK for this so callers can raise it at runtime.
 *
 * @throws FavoriteCapError     when the user already has `cap` pins.
 * @throws DuplicateFavoriteError when the same text is already pinned.
 */
export async function createFavorite(
  input: { userId: string; orgId: string; text: string },
  cap: number,
): Promise<FavoritePromptRow> {
  const trimmed = input.text.trim();
  if (trimmed.length === 0) {
    throw new Error("Pin text must not be empty");
  }
  if (trimmed.length > FAVORITE_TEXT_MAX_LENGTH) {
    throw new Error(
      `Pin text is too long (${trimmed.length} > ${FAVORITE_TEXT_MAX_LENGTH} chars)`,
    );
  }
  if (!hasInternalDB()) {
    throw new Error(
      "Cannot pin starter prompts: internal database is not configured",
    );
  }

  // Cap check runs before INSERT so we return a clean FavoriteCapError
  // rather than INSERT-then-DELETE on overflow.
  const countRows = await internalQuery<{ count: string | number }>(
    `SELECT COUNT(*)::text AS count
     FROM user_favorite_prompts
     WHERE user_id = $1 AND org_id = $2`,
    [input.userId, input.orgId],
  );
  const existing =
    countRows.length > 0
      ? typeof countRows[0].count === "string"
        ? parseInt(countRows[0].count, 10)
        : countRows[0].count
      : 0;
  if (existing >= cap) {
    throw new FavoriteCapError(cap);
  }

  try {
    const rows = await internalQuery<RawRow>(
      `INSERT INTO user_favorite_prompts (user_id, org_id, text, position)
       VALUES (
         $1, $2, $3,
         (SELECT COALESCE(MAX(position), 0) + 1
          FROM user_favorite_prompts
          WHERE user_id = $1 AND org_id = $2)
       )
       RETURNING id, user_id, org_id, text, position, created_at`,
      [input.userId, input.orgId, trimmed],
    );
    if (rows.length === 0) {
      throw new Error("INSERT RETURNING returned no rows");
    }
    return toRow(rows[0]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === PG_UNIQUE_VIOLATION) {
      throw new DuplicateFavoriteError();
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Unpin a favorite. Returns a 3-way result so the route can map:
 *   - ok        → 200
 *   - not_found → 404
 *   - forbidden → 403 (row exists, belongs to a different user)
 *
 * The guard SELECT runs even when the caller's id is right, so the cross-user
 * vs missing-row distinction is authoritative — not leaked by DELETE affecting
 * 0 rows (which would collapse both cases into 404).
 */
export async function deleteFavorite(input: {
  id: string;
  userId: string;
  orgId: string;
}): Promise<DeleteResult> {
  if (!hasInternalDB()) return { status: "not_found" };

  const guardRows = await internalQuery<{ user_id: string; org_id: string }>(
    `SELECT user_id, org_id FROM user_favorite_prompts WHERE id = $1`,
    [input.id],
  );
  if (guardRows.length === 0) {
    return { status: "not_found" };
  }
  if (
    guardRows[0].user_id !== input.userId ||
    guardRows[0].org_id !== input.orgId
  ) {
    log.warn(
      {
        favoriteId: input.id,
        requestingUserId: input.userId,
        ownerUserId: guardRows[0].user_id,
      },
      "Rejected cross-user favorite delete",
    );
    return { status: "forbidden" };
  }

  // Belt-and-braces: scope the DELETE by (id, user_id, org_id) too. The
  // guard SELECT already classified this row as "ok", but carrying the
  // user_id/org_id predicate on the write means a future refactor that
  // drops the guard still cannot affect a different user's row.
  await internalQuery(
    `DELETE FROM user_favorite_prompts
     WHERE id = $1 AND user_id = $2 AND org_id = $3`,
    [input.id, input.userId, input.orgId],
  );
  return { status: "ok" };
}

/**
 * Reorder a pin. Position is a float so inserts-between are O(1). Same
 * 3-way result as {@link deleteFavorite} — the guard SELECT tells us
 * forbidden vs not_found up front.
 */
export async function updateFavoritePosition(input: {
  id: string;
  userId: string;
  orgId: string;
  position: number;
}): Promise<UpdatePositionResult> {
  if (!Number.isFinite(input.position)) {
    throw new Error(`position must be a finite number, got ${input.position}`);
  }
  if (!hasInternalDB()) return { status: "not_found" };

  const guardRows = await internalQuery<{ user_id: string; org_id: string }>(
    `SELECT user_id, org_id FROM user_favorite_prompts WHERE id = $1`,
    [input.id],
  );
  if (guardRows.length === 0) {
    return { status: "not_found" };
  }
  if (
    guardRows[0].user_id !== input.userId ||
    guardRows[0].org_id !== input.orgId
  ) {
    log.warn(
      {
        favoriteId: input.id,
        requestingUserId: input.userId,
        ownerUserId: guardRows[0].user_id,
      },
      "Rejected cross-user favorite reorder",
    );
    return { status: "forbidden" };
  }

  // See `deleteFavorite` for rationale on the (user_id, org_id) predicate.
  const rows = await internalQuery<RawRow>(
    `UPDATE user_favorite_prompts
     SET position = $4
     WHERE id = $1 AND user_id = $2 AND org_id = $3
     RETURNING id, user_id, org_id, text, position, created_at`,
    [input.id, input.userId, input.orgId, input.position],
  );
  if (rows.length === 0) {
    return { status: "not_found" };
  }
  return { status: "ok", favorite: toRow(rows[0]) };
}
