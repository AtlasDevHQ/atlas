/**
 * Shared seat-count source for the per-seat token budget.
 *
 * The per-seat token budget (`computeTokenBudget(tier, seatCount)`) is read on
 * three surfaces that must agree, or `/admin/usage` shows a budget the 429
 * threshold doesn't enforce (#3430):
 *
 *  - Enforcement (`checkPlanLimits`) — gates the agent loop; its seat count
 *    decides the actual 429 threshold.
 *  - `GET /billing` — the billing page's "Token Budget" figure.
 *  - `GET /admin/usage/summary` — the usage page's "Token Budget" figure.
 *
 * Before this module, enforcement and `/billing` both counted `member` rows
 * while `/admin/usage` used `Math.max(1, activeUsers)` (distinct login events
 * this month), so a 10-member workspace with 2 active logins advertised a 5×
 * smaller budget on `/admin/usage` than enforcement actually allowed. This is
 * the ONE definition of "seats" all three consume.
 *
 * Seats = the count of Better-Auth `member` rows for the organization. A
 * transient lookup failure does NOT collapse the budget to 1 seat — that would
 * shrink a 10-seat budget 10× and fire spurious "budget exceeded" 429s during a
 * DB blip (CLAUDE.md: "prefer errors over silent fallbacks"). Instead we serve
 * the last-known good value when we have one, and fail explicitly when we don't.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("billing:seat-count");

/**
 * The authoritative seat-count query — `member` rows for the organization.
 * Exported so a real-Postgres test can exercise the exact aggregate the budget
 * decision runs on. `$1` = organization id.
 */
export const SEAT_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM member WHERE "organizationId" = $1`;

/**
 * Thrown when the seat count can't be determined and no last-known value is
 * cached. Callers that gate access (enforcement) should fail the check; callers
 * rendering a read-only page may catch this and degrade transparently rather
 * than silently understate the budget.
 */
export class SeatCountUnavailableError extends Error {
  readonly orgId: string;
  constructor(orgId: string, cause?: unknown) {
    super(`Seat count unavailable for organization ${orgId}`);
    this.name = "SeatCountUnavailableError";
    this.orgId = orgId;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Last-known good seat count per organization. A transient `member`-count query
 * failure serves this instead of collapsing to 1 seat. Unbounded growth is a
 * non-issue: one small integer per organization, and organizations are few
 * relative to requests.
 */
const lastKnownSeatCount = new Map<string, number>();

/**
 * Resolve the seat count for the per-seat token budget.
 *
 * Returns the live `member` count on success, caching it as the last-known
 * value. On a query failure, serves the last-known value if one exists;
 * otherwise throws {@link SeatCountUnavailableError} so the caller decides
 * whether to fail closed (enforcement) or degrade transparently (read pages) —
 * never silently substituting 1 seat.
 *
 * @param orgId - The organization/workspace id.
 * @throws {SeatCountUnavailableError} when the lookup fails and no last-known
 *   value is cached.
 */
export async function getSeatCount(orgId: string): Promise<number> {
  try {
    const rows = await internalQuery<{ count: number }>(SEAT_COUNT_SQL, [orgId]);
    const count = rows[0]?.count;
    if (typeof count === "number" && count > 0) {
      lastKnownSeatCount.set(orgId, count);
      return count;
    }
    // A workspace always has at least its owner as a member; a zero/absent count
    // means the row contract was violated (empty result) rather than a genuine
    // zero. Treat it as a lookup failure so we fall through to last-known /
    // explicit-failure rather than budgeting for 0 seats.
    log.warn(
      { orgId, count },
      "Seat-count query returned no usable count — falling back to last-known value",
    );
    const lastKnown = lastKnownSeatCount.get(orgId);
    if (lastKnown !== undefined) {
      return lastKnown;
    }
    throw new SeatCountUnavailableError(orgId);
  } catch (err) {
    if (err instanceof SeatCountUnavailableError) {
      throw err;
    }
    const lastKnown = lastKnownSeatCount.get(orgId);
    if (lastKnown !== undefined) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orgId, lastKnown },
        "Failed to query seat count — serving last-known value",
      );
      return lastKnown;
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query seat count and no last-known value cached — failing the lookup",
    );
    throw new SeatCountUnavailableError(orgId, err);
  }
}

/** Clear the last-known seat-count cache. Tests only. */
export function _resetSeatCountCache(orgId?: string): void {
  if (orgId) {
    lastKnownSeatCount.delete(orgId);
  } else {
    lastKnownSeatCount.clear();
  }
}
