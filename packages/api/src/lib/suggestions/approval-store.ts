/**
 * Admin-only moderation mutations over `query_suggestions`.
 *
 * Mirrors the favorite-store design: a 3-way outcome type
 * (ok / not_found / forbidden) keeps cross-org access authoritative —
 * the route layer can map forbidden to 403 without the DELETE-affected-0-rows
 * ambiguity that would otherwise collapse missing and cross-org into 404.
 *
 * # Mode participation (1.2.0)
 *
 * Every mutation also writes the orthogonal `status` axis based on the
 * caller's current mode: `draft` in developer mode, `published` otherwise.
 * That makes `query_suggestions` a full participant in the atomic publish
 * endpoint — admin edits queued in developer mode only surface to non-admins
 * after `/api/v1/admin/publish` flips the drafts to published. The
 * `approval_status` axis is still the moderation lifecycle (pending /
 * approved / hidden) and is independent of `status`.
 */
import crypto from "node:crypto";
import type { QuerySuggestion } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  type QuerySuggestionRow,
} from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";

const log = createLogger("approval-store");

/** Upper bound on admin-authored prompt text. */
export const SUGGESTION_TEXT_MAX_LENGTH = 2000;

const PG_UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Author text failed service-level validation (empty / too long).
 * Route layer maps to 400. Zod at the route boundary is the primary
 * validator; this error exists so non-route callers (SDK / MCP / CLI)
 * get a typed failure instead of a generic 500.
 */
export class InvalidSuggestionTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSuggestionTextError";
  }
}

/**
 * Duplicate author text — a suggestion with the same `normalized_hash`
 * already exists in this org (may be pending / approved / hidden). Route
 * layer maps to 409. The admin is expected to resolve via the queue:
 * approve the pending row, unhide the hidden one, etc.
 */
export class DuplicateSuggestionError extends Error {
  constructor() {
    super(
      "A suggestion with this text already exists. Open the moderation queue to approve or unhide it.",
    );
    this.name = "DuplicateSuggestionError";
  }
}

// ---------------------------------------------------------------------------
// Outcome shapes
// ---------------------------------------------------------------------------

/**
 * 3-way outcome for approve / hide / unhide:
 *   - ok        → 200 with the updated suggestion (wire DTO, camelCase)
 *   - not_found → 404 (no row with that id)
 *   - forbidden → 403 (row exists but belongs to a different org)
 *
 * The `suggestion` field carries the wire-facing `QuerySuggestion` DTO
 * (not the raw `QuerySuggestionRow` snake_case shape) so callers —
 * routes, SDK, MCP — never re-implement the row→DTO mapping.
 */
export type ApprovalResult =
  | { readonly status: "ok"; readonly suggestion: QuerySuggestion }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shared guard SELECT — classifies a row as present-in-org, present-cross-org,
 * or absent before any mutation runs. Splitting the check from the UPDATE
 * means a 404 vs 403 distinction is authoritative; otherwise a 0-rows UPDATE
 * would collapse both into 404 and leak nothing about cross-org existence.
 */
async function classifyAccess(
  id: string,
  orgId: string,
): Promise<"ok" | "not_found" | "forbidden"> {
  const guard = await internalQuery<{ org_id: string | null }>(
    `SELECT org_id FROM query_suggestions WHERE id = $1`,
    [id],
  );
  if (guard.length === 0) return "not_found";
  const rowOrg = guard[0].org_id;
  if (rowOrg !== orgId) {
    log.warn(
      { suggestionId: id, requestingOrg: orgId, rowOrg },
      "Rejected cross-org suggestion mutation",
    );
    return "forbidden";
  }
  return "ok";
}

/**
 * 16-char sha256 prefix over trimmed text. Keeps hashes short for the
 * `(org_id, normalized_hash)` unique index and matches the existing
 * learned-pattern fingerprint length.
 */
function fingerprintText(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Approve a pending suggestion. Idempotent at the DB level — re-approving
 * an already-approved row is a no-op plus a bumped `approved_at`. The
 * route layer does not distinguish first-approve from re-approve; both
 * surface as 200.
 *
 * The mutation always writes `status = 'draft'` regardless of the
 * caller's `atlasMode` (#2177). The pending-changes pill in the admin top
 * bar surfaces the queued approval; the atomic publish endpoint promotes
 * it alongside the other draft content types.
 */
export async function approveSuggestion(input: {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ApprovalResult> {
  if (!hasInternalDB()) {
    log.warn(
      { suggestionId: input.id },
      "approveSuggestion short-circuiting: internal DB not configured",
    );
    return { status: "not_found" };
  }

  const access = await classifyAccess(input.id, input.orgId);
  if (access !== "ok") return { status: access };

  // Belt-and-braces: scope the UPDATE by (id, org_id) as well. The guard
  // SELECT already classified this row as in-org, but carrying org_id on
  // the write means a future refactor that drops the guard still cannot
  // affect another org's row.
  const rows = await internalQuery<QuerySuggestionRow>(
    `UPDATE query_suggestions
     SET approval_status = 'approved',
         status = 'draft',
         approved_by = $2,
         approved_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND org_id = $3
     RETURNING *`,
    [input.id, input.userId, input.orgId],
  );
  if (rows.length === 0) return { status: "not_found" };
  return { status: "ok", suggestion: toQuerySuggestion(rows[0]) };
}

/**
 * Hide a suggestion from the popular tier. Preserves `approved_by` and
 * `approved_at` so the row's review history survives a hide → unhide
 * cycle (per user story 12 — hide is reversible).
 *
 * Always writes `status = 'draft'` (#2177) so the hide participates in
 * the atomic publish flow — non-admins keep seeing the row until publish.
 */
export async function hideSuggestion(input: {
  readonly id: string;
  readonly orgId: string;
}): Promise<ApprovalResult> {
  if (!hasInternalDB()) {
    log.warn(
      { suggestionId: input.id },
      "hideSuggestion short-circuiting: internal DB not configured",
    );
    return { status: "not_found" };
  }

  const access = await classifyAccess(input.id, input.orgId);
  if (access !== "ok") return { status: access };

  const rows = await internalQuery<QuerySuggestionRow>(
    `UPDATE query_suggestions
     SET approval_status = 'hidden',
         status = 'draft',
         updated_at = NOW()
     WHERE id = $1 AND org_id = $2
     RETURNING *`,
    [input.id, input.orgId],
  );
  if (rows.length === 0) return { status: "not_found" };
  return { status: "ok", suggestion: toQuerySuggestion(rows[0]) };
}

/**
 * Return a hidden (or approved) row to the pending queue for re-review.
 * The auto-promote policy (`checkAutoPromote`) will not re-promote it
 * without a fresh click transition — so a hidden row stays out of sight
 * until the admin explicitly approves it again or the click count rises.
 *
 * Always writes `status = 'draft'` (#2177) so the reversal respects the
 * publish gate. Keeps all four moderation mutations symmetric.
 */
export async function unhideSuggestion(input: {
  readonly id: string;
  readonly orgId: string;
}): Promise<ApprovalResult> {
  if (!hasInternalDB()) {
    log.warn(
      { suggestionId: input.id },
      "unhideSuggestion short-circuiting: internal DB not configured",
    );
    return { status: "not_found" };
  }

  const access = await classifyAccess(input.id, input.orgId);
  if (access !== "ok") return { status: access };

  const rows = await internalQuery<QuerySuggestionRow>(
    `UPDATE query_suggestions
     SET approval_status = 'pending',
         status = 'draft',
         updated_at = NOW()
     WHERE id = $1 AND org_id = $2
     RETURNING *`,
    [input.id, input.orgId],
  );
  if (rows.length === 0) return { status: "not_found" };
  return { status: "ok", suggestion: toQuerySuggestion(rows[0]) };
}

/**
 * Admin-authored starter prompt — skips the pending queue entirely.
 * Writes `approval_status = 'approved'` (the admin IS the review) and
 * always writes `status = 'draft'` (#2177) so the author only surfaces to
 * non-admins after publish.
 *
 * @throws InvalidSuggestionTextError on empty / too-long text
 * @throws DuplicateSuggestionError on PG unique-violation (23505)
 */
export async function createApprovedSuggestion(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly text: string;
}): Promise<QuerySuggestion> {
  const trimmed = input.text.trim();
  if (trimmed.length === 0) {
    throw new InvalidSuggestionTextError(
      "Starter prompt text must not be empty.",
    );
  }
  if (trimmed.length > SUGGESTION_TEXT_MAX_LENGTH) {
    throw new InvalidSuggestionTextError(
      `Starter prompt text is too long (${trimmed.length} > ${SUGGESTION_TEXT_MAX_LENGTH} chars).`,
    );
  }
  if (!hasInternalDB()) {
    throw new Error(
      "Cannot author starter prompts: internal database is not configured.",
    );
  }

  const hash = fingerprintText(trimmed);

  try {
    // Admin-authored rows have no underlying SQL pattern — they're a
    // natural-language starter prompt — so `pattern_sql` is an empty
    // string. `tables_involved` is an empty jsonb array and the counters
    // default to zero; organic engagement accumulates after launch.
    const rows = await internalQuery<QuerySuggestionRow>(
      `INSERT INTO query_suggestions (
         org_id, description, pattern_sql, normalized_hash,
         tables_involved, primary_table,
         frequency, clicked_count, distinct_user_clicks, score,
         approval_status, status,
         approved_by, approved_at,
         last_seen_at
       )
       VALUES (
         $1, $2, '', $3,
         '[]'::jsonb, NULL,
         0, 0, 0, 0,
         'approved', 'draft',
         $4, NOW(),
         NOW()
       )
       RETURNING *`,
      [input.orgId, trimmed, hash, input.userId],
    );
    if (rows.length === 0) {
      throw new Error("INSERT RETURNING returned no rows");
    }
    return toQuerySuggestion(rows[0]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === PG_UNIQUE_VIOLATION) {
      throw new DuplicateSuggestionError();
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
