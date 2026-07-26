/**
 * The membership reconcile's write contract (#4801, ADR-0036 §Access control).
 *
 * The DELETE is the feature — an insert-only sync satisfies "membership is
 * populated" and none of the point, because it can never take access back. So
 * these pin the revocation half hardest: that the delete runs, that it runs
 * scoped, that an empty roster revokes rather than being second-guessed, and
 * that both statements share one transaction so a fault cannot leave the
 * audience revoked-but-not-re-added.
 */

import { describe, expect, it } from "bun:test";
import {
  DELETE_STALE_AUDIENCE_MEMBERS_SQL,
  INSERT_AUDIENCE_MEMBERS_SQL,
  TOUCH_AUDIENCE_MEMBERS_SQL,
  reconcileAudienceMembership,
  type MembershipExecutor,
} from "../membership";

const BASE = { workspaceId: "ws-1", audienceId: "chat-channel:slack:C1", source: "slack" };

/** Records the statements a reconcile issued, in order, with their params. */
function recorder(rowsFor: (sql: string) => readonly unknown[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let began = 0;
  const withTransaction = async <T>(fn: (tx: MembershipExecutor) => Promise<T>): Promise<T> => {
    began++;
    return fn({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: rowsFor(sql) };
      },
    });
  };
  return { withTransaction, calls, transactions: () => began };
}

describe("reconcileAudienceMembership", () => {
  it("inserts the roster and deletes everyone outside it, in one transaction", async () => {
    const { withTransaction, calls, transactions } = recorder((sql) =>
      sql === INSERT_AUDIENCE_MEMBERS_SQL ? [{ user_id: "u1" }] : [{ user_id: "u9" }],
    );
    const result = await reconcileAudienceMembership(
      { ...BASE, userIds: ["u1", "u2"] },
      { withTransaction },
    );

    expect(result).toEqual({ added: 1, revoked: 1 });
    // The touch runs LAST, so it stamps the survivors rather than rows the
    // delete is about to remove.
    expect(calls.map((c) => c.sql)).toEqual([
      INSERT_AUDIENCE_MEMBERS_SQL,
      DELETE_STALE_AUDIENCE_MEMBERS_SQL,
      TOUCH_AUDIENCE_MEMBERS_SQL,
    ]);
    // ONE transaction for the pair. The dangerous split is delete-commits /
    // insert-fails: everyone revoked, re-added only next cycle, and in between
    // the workspace's private facts are invisible to their own authors.
    expect(transactions()).toBe(1);
  });

  it("REVOKES the whole audience when the roster resolves to nobody", async () => {
    // The tempting guard — "empty roster looks like a bug, keep the rows" —
    // would preserve exactly the stale access this table exists to drop. The
    // protection against a spurious empty set lives upstream, in the
    // completeness check, which can tell a failed read from an empty channel.
    const { withTransaction, calls } = recorder((sql) =>
      sql === DELETE_STALE_AUDIENCE_MEMBERS_SQL ? [{ user_id: "u1" }, { user_id: "u2" }] : [],
    );
    const result = await reconcileAudienceMembership({ ...BASE, userIds: [] }, { withTransaction });

    expect(result).toEqual({ added: 0, revoked: 2 });
    const del = calls.find((c) => c.sql === DELETE_STALE_AUDIENCE_MEMBERS_SQL);
    expect(del?.params[2]).toEqual([]);
  });

  it("stamps synced_at on a NO-OP reconcile — unchanged is still verified", async () => {
    // The column means "last VERIFIED", not "last touched". If the steady-state
    // pass (nothing added, nothing revoked) skipped the stamp, `synced_at`
    // would age on every healthy audience and stay fresh only where membership
    // happened to churn — i.e. it would read healthiest for the workspaces
    // whose rosters are most static, and the read-time bound in `acl.ts` would
    // start denying correct grants.
    const { withTransaction, calls } = recorder(() => []);
    const result = await reconcileAudienceMembership(
      { ...BASE, userIds: ["u1", "u2"] },
      { withTransaction },
    );

    expect(result).toEqual({ added: 0, revoked: 0 });
    const touch = calls.find((c) => c.sql === TOUCH_AUDIENCE_MEMBERS_SQL);
    expect(touch).toBeDefined();
    expect(touch?.params).toEqual(["ws-1", "chat-channel:slack:C1", "slack"]);
  });

  it("keeps `added` meaning NEWLY GRANTED even when the touch reports the whole roster", async () => {
    // The trap this shape exists to avoid. Stamping `synced_at` by turning the
    // INSERT's `ON CONFLICT DO NOTHING` into `DO UPDATE SET synced_at = now()`
    // is the natural move — and it makes `RETURNING user_id` emit the WHOLE
    // roster every cycle, so `added` (which is `rows.length`) silently becomes
    // "everyone", the "membership granted" log fires every 30 minutes, and
    // `atlas.brain.audience.members_added` stops meaning anything. Nothing
    // errors; every other assertion in this file still passes.
    //
    // Here the touch is made to return a full roster. `added` must ignore it.
    const { withTransaction } = recorder((sql) =>
      sql === TOUCH_AUDIENCE_MEMBERS_SQL ? [{ user_id: "u1" }, { user_id: "u2" }] : [],
    );
    const result = await reconcileAudienceMembership(
      { ...BASE, userIds: ["u1", "u2"] },
      { withTransaction },
    );

    expect(result).toEqual({ added: 0, revoked: 0 });
  });

  it("keeps the insert non-destructive — `created_at` survives a re-sync", () => {
    // Pinned on the SQL itself, because the failure mode is a one-word edit
    // (`DO NOTHING` → `DO UPDATE`) whose damage — a rewritten `created_at`, so
    // "since when has this person been able to see this?" becomes "since the
    // last cycle" — is invisible to every behavioural assertion above.
    expect(INSERT_AUDIENCE_MEMBERS_SQL).toContain("DO NOTHING");
    expect(INSERT_AUDIENCE_MEMBERS_SQL).not.toContain("DO UPDATE");
  });

  it("scopes the touch by source, like the delete", async () => {
    // Same reasoning as the DELETE's source scoping: a future second writer
    // into the same audience must not have its rows marked verified by this
    // one's read.
    const { withTransaction, calls } = recorder();
    await reconcileAudienceMembership({ ...BASE, userIds: ["u1"] }, { withTransaction });

    const touch = calls.find((c) => c.sql === TOUCH_AUDIENCE_MEMBERS_SQL);
    expect(touch?.params[2]).toBe("slack");
  });

  it("scopes the delete by source as well as by audience", async () => {
    // 0180 keeps `source` out of the key because an audience belongs to one
    // source — but scoping the DELETE by it anyway means a future second writer
    // into the same audience cannot reconcile away rows it did not create.
    const { withTransaction, calls } = recorder();
    await reconcileAudienceMembership({ ...BASE, userIds: ["u1"] }, { withTransaction });

    const del = calls.find((c) => c.sql === DELETE_STALE_AUDIENCE_MEMBERS_SQL);
    expect(del?.params).toEqual(["ws-1", "chat-channel:slack:C1", ["u1"], "slack"]);
  });

  it("is idempotent in its inputs — duplicates and blanks collapse", async () => {
    const { withTransaction, calls } = recorder();
    await reconcileAudienceMembership(
      { ...BASE, userIds: ["u1", "u1", " u1 ", "", "  "] },
      { withTransaction },
    );
    // Both ROSTER-carrying statements see the same de-duplicated set, so
    // `added`/`revoked` read as PEOPLE rather than as rows. The touch takes no
    // roster (it stamps whatever survived), hence the filter rather than a
    // loop over every call.
    const rosterCarrying = calls.filter(
      (c) => c.sql === INSERT_AUDIENCE_MEMBERS_SQL || c.sql === DELETE_STALE_AUDIENCE_MEMBERS_SQL,
    );
    expect(rosterCarrying).toHaveLength(2);
    for (const call of rosterCarrying) expect(call.params[2]).toEqual(["u1"]);
  });

  it("refuses a blank audience id at the writer", async () => {
    // `audience_id` is `text NOT NULL` with no non-empty CHECK, so `''` is
    // legally storable — and `acl.ts` names this writer as the thing to
    // investigate when a membership row carries an unusable id. Refusing here
    // is what makes that pointer true.
    const { withTransaction, calls } = recorder();
    await expect(
      reconcileAudienceMembership({ ...BASE, audienceId: "   ", userIds: ["u1"] }, { withTransaction }),
    ).rejects.toThrow(/blank workspace, audience, or source id/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a blank workspace or source id for the same reason", async () => {
    const { withTransaction } = recorder();
    await expect(
      reconcileAudienceMembership({ ...BASE, workspaceId: "", userIds: [] }, { withTransaction }),
    ).rejects.toThrow();
    await expect(
      reconcileAudienceMembership({ ...BASE, source: "", userIds: [] }, { withTransaction }),
    ).rejects.toThrow();
  });

  it("propagates a write failure rather than reporting a partial reconcile", async () => {
    // The caller counts the audience as failed and leaves the previous
    // membership in place — the direction that neither grants nor revokes.
    const withTransaction = async <T>(fn: (tx: MembershipExecutor) => Promise<T>): Promise<T> =>
      fn({
        query: () => Promise.reject(new Error("deadlock detected")),
      });
    await expect(
      reconcileAudienceMembership({ ...BASE, userIds: ["u1"] }, { withTransaction }),
    ).rejects.toThrow("deadlock detected");
  });
});
