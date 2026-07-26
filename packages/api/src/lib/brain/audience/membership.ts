/**
 * The `fact_audience_member` write (#4801, ADR-0036 §Access control &
 * residency) — the LIVE half of the grant.
 *
 * ADR-0036 accepted a real cost in deriving grants at ingest: source membership
 * changes do not propagate to already-ingested facts. `audience:` is the escape
 * hatch, and this module is what makes it one. A fact granted to
 * `audience:chat-channel:slack:C123` names a set, not people; `acl.ts` expands
 * that set per request out of this table. So a row deleted here hides the fact
 * on the NEXT READ, with no re-ingest and no rewrite of a single stored row.
 *
 * ## Which is why this reconciles rather than inserts
 *
 * An insert-only sync satisfies the letter of "membership is populated" and
 * none of the point. It grants access and can never take it back: someone
 * removed from a private channel keeps reading its facts forever, and the one
 * mechanism ADR-0036 built for that case silently does nothing. The DELETE is
 * the feature; the INSERT is the part that makes it useful.
 *
 * ## And why the caller must prove the roster is complete first
 *
 * The delete is "everyone in this audience who is not in the set I was handed",
 * so it is only as correct as the set. A truncated vendor read that reached
 * this function would revoke the members it failed to fetch — a partial page
 * would look exactly like a mass removal. {@link reconcileAudienceMembership}
 * therefore takes an already-COMPLETE membership set as a precondition it
 * cannot check, and `sync.ts` is where that precondition is established (and
 * where an incomplete read aborts the audience, touching nothing).
 *
 * ## Idempotence
 *
 * Re-running against unchanged source membership grants and revokes nothing:
 * the INSERT is `ON CONFLICT DO NOTHING` on the natural key, and the DELETE's
 * `<> ALL` set is the full roster. Both counts come back zero, which is what a
 * steady-state cycle should report — it re-stamps `synced_at` and changes
 * nothing else.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB } from "@atlas/api/lib/db/internal";

const log = createLogger("brain.audience.membership");

/**
 * Add the members this pass resolved.
 *
 * `ON CONFLICT DO NOTHING` on `(workspace_id, audience_id, user_id)` — the
 * table's PK — so a re-sync is a no-op rather than a churn of `created_at`.
 * Keeping the original `created_at` is deliberate: it answers "since when has
 * this person been able to see this?", which a rewrite on every cycle would
 * turn into "since the last cycle", i.e. into nothing.
 *
 * `source` is written on insert only. An audience belongs to exactly one source
 * by construction (the id is source-namespaced by `chatChannelAudienceId`), so
 * there is no case where an existing row's source should change; a conflicting
 * source would mean the audience id itself collided, which the namespace exists
 * to prevent.
 *
 * Exported so the real-Postgres test executes this exact string.
 */
export const INSERT_AUDIENCE_MEMBERS_SQL = `INSERT INTO fact_audience_member
              (workspace_id, audience_id, user_id, source)
       SELECT $1, $2, unnest($3::text[]), $4
  ON CONFLICT (workspace_id, audience_id, user_id) DO NOTHING
    RETURNING user_id`;

/**
 * Revoke everyone no longer in the source roster.
 *
 * `$3 = '{}'` deletes the whole audience, which is the correct read of "the
 * channel resolved to nobody" — NOT a reason to skip the delete. A private
 * channel whose entire roster left Atlas should grant nobody, and a guard that
 * treated the empty set as "probably a bug, keep the rows" would preserve
 * exactly the stale access this table exists to drop. The protection against a
 * spurious empty set lives upstream, in the completeness check — the layer that
 * can actually tell "nobody is in the channel" from "the read failed".
 *
 * Scoped by `source` as well as by audience: 0180's comment notes `source` is
 * not part of the key because an audience belongs to one source, but scoping
 * the DELETE by it anyway means a future second writer into the same audience
 * cannot reconcile away rows it did not create.
 */
export const DELETE_STALE_AUDIENCE_MEMBERS_SQL = `DELETE FROM fact_audience_member
        WHERE workspace_id = $1
          AND audience_id = $2
          AND source = $4
          AND user_id <> ALL($3::text[])
    RETURNING user_id`;

/**
 * Stamp "verified now" on the surviving roster (#4808).
 *
 * A SEPARATE STATEMENT, and that is the whole design. The natural way to
 * refresh `synced_at` on a re-sync is to turn the INSERT's `ON CONFLICT DO
 * NOTHING` into `DO UPDATE SET synced_at = now()` — and it is a trap. `DO
 * UPDATE` makes `RETURNING user_id` emit the WHOLE roster on every cycle, not
 * just the genuinely-inserted rows, so {@link AudienceReconcileResult.added} —
 * which is `rows.length` — silently stops meaning "newly granted" and starts
 * meaning "everyone". The "membership granted" log line then fires every 30
 * minutes and `atlas.brain.audience.members_added` stops meaning anything.
 * Nothing errors; every existing assertion still passes. Hence the extra
 * round trip: `added` keeps its meaning by construction rather than by a
 * `WHERE xmax = 0` incantation someone later "simplifies" away.
 *
 * Runs AFTER the delete, so it stamps exactly the rows that survived
 * reconciliation and does no work on ones about to be removed. Rows inserted
 * by this same pass already carry the column default, and `now()` is
 * transaction time, so all three statements agree on the instant.
 *
 * Scoped by `source` like the DELETE: a future second writer into the same
 * audience must not have its rows marked verified by this one's read.
 */
export const TOUCH_AUDIENCE_MEMBERS_SQL = `UPDATE fact_audience_member
           SET synced_at = now()
         WHERE workspace_id = $1
           AND audience_id = $2
           AND source = $3`;

/** How many revoked user ids a single log line carries. A bound, not a policy. */
const REVOKED_SAMPLE_CAP = 50;

/** What one audience's reconcile changed. Zero/zero is a healthy steady state. */
export interface AudienceReconcileResult {
  readonly added: number;
  readonly revoked: number;
}

/** The transaction surface this module needs — injectable for tests. */
export interface MembershipExecutor {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

export type MembershipTransactionRunner = <T>(
  fn: (tx: MembershipExecutor) => Promise<T>,
) => Promise<T>;

/**
 * Run both statements in ONE transaction.
 *
 * Not for atomicity of the pair against a reader — `acl.ts` reads committed
 * membership and either state is legal — but so a failure between them cannot
 * leave the audience half-reconciled. The dangerous ordering is delete-commits,
 * insert-fails: everyone is revoked, the next cycle re-adds them, and in between
 * the workspace's private facts are invisible to their own authors.
 */
export const withMembershipTransaction: MembershipTransactionRunner = async <T>(
  fn: (tx: MembershipExecutor) => Promise<T>,
): Promise<T> => {
  const client = await getInternalDB().connect();
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: async (sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as readonly unknown[] };
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        // Only `.message`, never the error object: a pg error can carry a
        // credentialed connection URL on its properties.
        { err: rollbackErr.message },
        "brain audience: ROLLBACK failed — the client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
};

export interface ReconcileAudienceInput {
  readonly workspaceId: string;
  /** Audience id WITHOUT the `audience:` prefix — the prefix is grant grammar. */
  readonly audienceId: string;
  readonly source: string;
  /**
   * The COMPLETE set of Atlas user ids the source says are in this audience.
   *
   * Complete is a precondition this function cannot verify and does not try to:
   * see the module header. Duplicates are harmless (the insert conflicts, the
   * delete's `<> ALL` is a set test) but are removed anyway so the counts read
   * as people rather than as rows.
   */
  readonly userIds: readonly string[];
}

/**
 * Reconcile one audience's membership to the source's roster.
 *
 * Returns what changed. Throws on a DB failure — the caller counts the audience
 * as failed and leaves the previous membership in place, which is the direction
 * that neither grants nor revokes on a fault.
 */
export async function reconcileAudienceMembership(
  input: ReconcileAudienceInput,
  deps: { readonly withTransaction?: MembershipTransactionRunner } = {},
): Promise<AudienceReconcileResult> {
  const { workspaceId, audienceId, source } = input;
  // An empty or blank id would be legally storable (0180 adds no non-empty
  // CHECK on `audience_id`) and is precisely the "writer stored an empty id"
  // defect `acl.ts`'s membership expansion warns about by name. Refuse at the
  // writer, where the fault is attributable.
  if (workspaceId.trim() === "" || audienceId.trim() === "" || source.trim() === "") {
    throw new Error(
      "brain audience: refusing to write membership with a blank workspace, audience, or source id",
    );
  }
  const userIds = [...new Set(input.userIds.map((id) => id.trim()).filter((id) => id !== ""))];

  const withTransaction = deps.withTransaction ?? withMembershipTransaction;
  return withTransaction(async (tx) => {
    const inserted = await tx.query(INSERT_AUDIENCE_MEMBERS_SQL, [
      workspaceId,
      audienceId,
      userIds,
      source,
    ]);
    const deleted = await tx.query(DELETE_STALE_AUDIENCE_MEMBERS_SQL, [
      workspaceId,
      audienceId,
      userIds,
      source,
    ]);
    // Inside the transaction, so "verified" is committed with the reconcile it
    // attests to and can never outlive a rolled-back one. Reaching this line at
    // all is the proof the caller established a COMPLETE roster — every
    // incomplete read aborts in `sync.ts` without calling this function, which
    // is what makes the column mean "last verified" rather than "last touched".
    await tx.query(TOUCH_AUDIENCE_MEMBERS_SQL, [workspaceId, audienceId, source]);
    const result = { added: inserted.rows.length, revoked: deleted.rows.length };
    if (result.revoked > 0) {
      // A revocation is the security-relevant event in this subsystem and must
      // be reconstructible from logs ALONE — by the time anyone asks, the row
      // it removed is gone. So the ids come with it, not just the count:
      // "revoked: 3" cannot answer "why did this person lose access?", which is
      // the only question anybody brings to this log line. Bounded, because a
      // whole-audience revoke is exactly when the count is largest.
      //
      // `warn`, unlike the grant path below: losing access is the direction a
      // human investigates.
      log.warn(
        {
          workspaceId,
          audienceId,
          source,
          ...result,
          roster: userIds.length,
          revokedUserIds: deleted.rows
            .map((row) =>
              typeof row === "object" && row !== null && "user_id" in row
                ? String(row.user_id)
                : "(unreadable)",
            )
            .slice(0, REVOKED_SAMPLE_CAP),
          revokedSampleTruncated: result.revoked > REVOKED_SAMPLE_CAP,
        },
        "brain audience: membership revoked",
      );
    }
    if (result.added > 0) {
      log.info(
        { workspaceId, audienceId, source, ...result, roster: userIds.length },
        "brain audience: membership granted",
      );
    }
    return result;
  });
}
