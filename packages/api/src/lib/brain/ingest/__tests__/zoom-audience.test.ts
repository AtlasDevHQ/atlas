/**
 * Meeting-audience membership (#4965) — the LIVE half of a transcript grant.
 *
 * Two properties carry this module, and both are about REVOCATION rather than
 * about granting:
 *
 *   1. **complete-or-abort.** `reconcileAudienceMembership` deletes everyone
 *      outside the roster it is handed, so a partial read revokes what it
 *      failed to fetch — and because episodes are gated rather than deleted,
 *      the damage looks exactly like correct fail-closed behaviour from every
 *      surface. Nothing downstream can catch it, so it has to be impossible
 *      here.
 *   2. **re-verification actually happens.** A meeting audience that nothing
 *      re-stamps is suppressed by `acl.ts` past
 *      `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, silently, with every sync
 *      green.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_PARTICIPANT_PAGES,
  readMeetingRoster,
  reconcileMeetingAudience,
  reverifyZoomMeetingAudiences,
  type ZoomAudienceDeps,
} from "@atlas/api/lib/brain/ingest/zoom/audience";
import {
  REVERIFY_CANDIDATES_SQL,
  TOUCH_REVERIFY_ATTEMPT_SQL,
  ZERO_REVERIFY,
  _resetAudienceReverifiers,
  listAudienceReverifierSources,
  registerAudienceReverifier,
  runRegisteredAudienceReverifiers,
} from "@atlas/api/lib/brain/audience/reverify";

const UUID = "4kd8sZTiSHagYbwYtLpMRA==";

describe("readMeetingRoster — complete or nothing", () => {
  it("pages to the end and reports the whole roster", async () => {
    let call = 0;
    const roster = await readMeetingRoster("tok", UUID, {
      fetchParticipantsPage: async () => {
        call++;
        return call === 1
          ? { ok: true as const, participants: [p("a@x.example")], nextPageToken: "more" }
          : { ok: true as const, participants: [p("b@x.example")], nextPageToken: null };
      },
    });
    expect(roster.complete).toBe(true);
    if (roster.complete) expect(roster.participants).toHaveLength(2);
  });

  it("reports INCOMPLETE on a vendor error, discarding what it already had", async () => {
    // The partial state is unrepresentable in the return type on purpose: there
    // is no "here is some of the roster" value for a caller to consume by
    // mistake.
    const roster = await readMeetingRoster("tok", UUID, {
      fetchParticipantsPage: async () => ({
        ok: false as const,
        error: "ratelimited",
        retryAfterSeconds: 30,
      }),
    });
    expect(roster.complete).toBe(false);
    expect("participants" in roster).toBe(false);
  });

  it("reports INCOMPLETE when paging never terminates, rather than truncating", async () => {
    let calls = 0;
    const roster = await readMeetingRoster("tok", UUID, {
      fetchParticipantsPage: async () => {
        calls++;
        return { ok: true as const, participants: [p("a@x.example")], nextPageToken: "always" };
      },
    });
    expect(roster.complete).toBe(false);
    // Bounded, so a non-terminating vendor cannot hang the cycle.
    expect(calls).toBe(MAX_PARTICIPANT_PAGES);
  });
});

describe("reconcileMeetingAudience", () => {
  it("reconciles to the resolved users, deduped", async () => {
    const seen: { userIds: readonly string[]; source: string }[] = [];
    const result = await reconcileMeetingAudience(
      {
        workspaceId: "ws1",
        audienceId: `meeting:zoom:${UUID}`,
        participants: [p("a@x.example", "z1"), p("b@x.example", "z2")],
      },
      {
        resolve: async () => ({
          // Two source principals resolving to ONE Atlas user is normal (they
          // dialled in twice) and must not double-count.
          resolved: new Map([
            ["z1", "user-1"],
            ["z2", "user-1"],
          ]),
          unresolvedCount: 0,
        }),
        reconcile: async (input) => {
          seen.push({ userIds: input.userIds, source: input.source });
          return { added: input.userIds.length, revoked: 0 };
        },
      },
    );
    expect(seen).toEqual([{ userIds: ["user-1"], source: "zoom" }]);
    expect(result.added).toBe(1);
  });

  it("reconciles a roster that resolves to NOBODY to an empty audience", async () => {
    // The FLAG side, from the membership end. "The meeting resolved to nobody"
    // is a real answer, and a guard that treated the empty set as "probably a
    // bug, keep the rows" would preserve exactly the stale access this table
    // exists to drop.
    //
    // MUTATION THIS CATCHES: an early return when `userIds.length === 0`.
    let called = false;
    await reconcileMeetingAudience(
      { workspaceId: "ws1", audienceId: `meeting:zoom:${UUID}`, participants: [p("g@acme.example")] },
      {
        resolve: async () => ({ resolved: new Map(), unresolvedCount: 1 }),
        reconcile: async (input) => {
          called = true;
          expect(input.userIds).toEqual([]);
          return { added: 0, revoked: 3 };
        },
      },
    );
    expect(called).toBe(true);
  });

  it("gives every participant a distinct principal id, including the email-less", async () => {
    // Dial-in guests have no email and no Zoom user id. Collapsing them onto
    // one principal id would make the resolver's unresolved COUNT wrong, which
    // is the number an operator acts on.
    let principalCount = 0;
    await reconcileMeetingAudience(
      {
        workspaceId: "ws1",
        audienceId: `meeting:zoom:${UUID}`,
        participants: [p(null, null), p(null, null), p(null, null)],
      },
      {
        resolve: async (_ws, principals) => {
          principalCount = new Set(principals.map((entry) => entry.id)).size;
          return { resolved: new Map(), unresolvedCount: principals.length };
        },
        reconcile: async () => ({ added: 0, revoked: 0 }),
      },
    );
    expect(principalCount).toBe(3);
  });

  it("gives a REJOINING participant two principal ids — the case the suffix fix is for", async () => {
    // The neighbouring test passes three email-less participants, which the OLD
    // code already handled via its `participant-${index}` fallback. Zoom emits
    // one entry per JOIN, so the real case is a participant who dropped and
    // rejoined: SAME `user_id`, two entries. Those collapsed in
    // `resolvePrincipals`' map and `unresolvedCount = length - resolved.size`
    // counted the duplicate as unresolved, over-reporting "matched no Atlas
    // user" on every recurring meeting where anyone reconnected.
    //
    // MUTATION THIS CATCHES: reverting to
    // `participant.userId ?? participant.email ?? \`participant-${index}\``.
    let ids: string[] = [];
    await reconcileMeetingAudience(
      {
        workspaceId: "ws1",
        audienceId: `meeting:zoom:${UUID}`,
        participants: [p("a@x.example", "z1"), p("a@x.example", "z1")],
      },
      {
        resolve: async (_ws, principals) => {
          ids = principals.map((entry) => entry.id);
          return { resolved: new Map(), unresolvedCount: 0 };
        },
        reconcile: async () => ({ added: 0, revoked: 0 }),
      },
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("PROPAGATES a resolver fault rather than reconciling to empty", async () => {
    // Swallowing here would hand the reconcile an empty set —
    // indistinguishable from "everyone left" — and revoke the whole audience
    // during an incident. The caller counts the audience as failed instead.
    await expect(
      reconcileMeetingAudience(
        { workspaceId: "ws1", audienceId: `meeting:zoom:${UUID}`, participants: [p("a@x.example")] },
        {
          resolve: async () => {
            throw new Error("directory read failed");
          },
          reconcile: async () => ({ added: 0, revoked: 99 }),
        },
      ),
    ).rejects.toThrow(/directory read failed/);
  });
});

describe("reverifyZoomMeetingAudiences", () => {
  const install = { workspace_id: "ws1", install_id: "zoom-transcripts", config: { accountId: "acc1" } };

  /**
   * A `query` double routed by STATEMENT and typed to the real dependency.
   *
   * Not `as never`, which is what this fixture used to be: `query` is GENERIC
   * (`<T extends Record<string, unknown>>`) so an inline `async (sql: string)`
   * does not satisfy it, and the cast made the whole fixture invisible to the
   * type gate. Routing by identity also means an unrecognised statement is a
   * fixture that has drifted from the code, not something to answer with canned
   * rows — the old form answered the attempt stamp with candidate rows.
   */
  function deps(
    overrides: Partial<ZoomAudienceDeps> & { audiences?: string[]; hasMembers?: boolean } = {},
  ): ZoomAudienceDeps {
    const audiences = overrides.audiences ?? [`audience:meeting:zoom:${UUID}`];
    const query: NonNullable<ZoomAudienceDeps["query"]> = async <
      T extends Record<string, unknown>,
    >(
      sql: string,
    ): Promise<T[]> => {
      if (/workspace_plugins/.test(sql)) return [install] as unknown as T[];
      if (sql === TOUCH_REVERIFY_ATTEMPT_SQL) return [] as T[];
      if (sql !== REVERIFY_CANDIDATES_SQL) {
        throw new Error(`unexpected statement in the Zoom re-verify fixture: ${sql}`);
      }
      return audiences.map((token) => ({
        token,
        has_members: overrides.hasMembers ?? false,
      })) as unknown as T[];
    };
    return {
      isEnabled: () => true,
      resolveToken: async () => "tok",
      query,
      fetchParticipantsPage: async () => ({
        ok: true as const,
        participants: [p("a@x.example", "z1")],
        nextPageToken: null,
      }),
      resolve: async () => ({ resolved: new Map([["z1", "user-1"]]), unresolvedCount: 0 }),
      reconcile: async () => ({ added: 1, revoked: 0 }),
      ...overrides,
    };
  }

  it("re-reconciles a meeting audience — the repair that keeps it fresh", async () => {
    const out = await reverifyZoomMeetingAudiences(deps());
    expect(out.reconciled).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.membersAdded).toBe(1);
  });

  it("reconciles the audience id WITHOUT the grant prefix, and the source kind", async () => {
    // The panel's finding: the earlier test discarded the reconcile's input, so
    // two mutations stayed green — passing `parts.meetingId` (drops the
    // `meeting:zoom:` namespace) or `row.token` (keeps the `audience:` prefix).
    // Either writes membership under a key `acl.ts` never matches, so every
    // transcript fact is stored, gated, and invisible with the cycle reporting
    // `reconciled: 1, failed: 0` — the exact #4801 state this module cites as
    // its reason to exist.
    const seen: { audienceId: string; source: string; userIds: readonly string[] }[] = [];
    await reverifyZoomMeetingAudiences(
      deps({
        reconcile: async (input) => {
          seen.push({
            audienceId: input.audienceId,
            source: input.source,
            userIds: input.userIds,
          });
          return { added: 1, revoked: 0 };
        },
      }),
    );
    expect(seen).toEqual([
      { audienceId: `meeting:zoom:${UUID}`, source: "zoom", userIds: ["user-1"] },
    ]);
  });

  it("REVOKES a participant who left the org — the whole reason this exists", async () => {
    // A meeting's participant list is frozen, but its resolution to Atlas users
    // is not. This is the path that takes access away, and it is the argument
    // against freezing `user:` tokens into the grant at ingest.
    const out = await reverifyZoomMeetingAudiences(
      deps({
        resolve: async () => ({ resolved: new Map(), unresolvedCount: 1 }),
        reconcile: async () => ({ added: 0, revoked: 1 }),
      }),
    );
    expect(out.membersRevoked).toBe(1);
    expect(out.reconciled).toBe(1);
  });

  it("ABORTS an audience whose roster read is incomplete, touching nothing", async () => {
    let reconciled = false;
    const out = await reverifyZoomMeetingAudiences(
      deps({
        fetchParticipantsPage: async () => ({
          ok: false as const,
          error: "transport",
          retryAfterSeconds: null,
        }),
        reconcile: async () => {
          reconciled = true;
          return { added: 0, revoked: 0 };
        },
      }),
    );
    expect(reconciled).toBe(false);
    expect(out.failed).toBe(1);
    expect(out.reconciled).toBe(0);
  });

  it("REFUSES to reconcile an empty roster for an audience that HAS members", async () => {
    // A past meeting's roster cannot shrink — nobody un-attends a meeting — so
    // an empty roster here is an unreadable report (Zoom's past-meeting data
    // ages out of retention) wearing the shape of a mass removal. Reconciling
    // it would revoke everyone, and from /admin that is indistinguishable from
    // correct fail-closed behaviour.
    let reconciled = false;
    const out = await reverifyZoomMeetingAudiences(
      deps({
        hasMembers: true,
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [],
          nextPageToken: null,
        }),
        reconcile: async () => {
          reconciled = true;
          return { added: 0, revoked: 40 };
        },
      }),
    );
    expect(reconciled).toBe(false);
    expect(out.failed).toBe(1);
  });

  it("DOES reconcile an empty roster for an audience with no members — that is the flag side", async () => {
    // The guard must not become "never write an empty audience", or the
    // all-external meeting never picks up its later repair.
    const seen: (readonly string[])[] = [];
    const out = await reverifyZoomMeetingAudiences(
      deps({
        hasMembers: false,
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [],
          nextPageToken: null,
        }),
        // Overridden because the shared fixture resolves unconditionally; an
        // empty roster must resolve to nobody for this assertion to mean
        // anything.
        resolve: async () => ({ resolved: new Map(), unresolvedCount: 0 }),
        reconcile: async (input) => {
          seen.push(input.userIds);
          return { added: 0, revoked: 0 };
        },
      }),
    );
    expect(seen).toEqual([[]]);
    expect(out.reconciled).toBe(1);
  });

  it("skips a token that is not THIS source's meeting, without failing the pass", async () => {
    // The scan's `LIKE` is coarser than the parser. A chat-channel audience or
    // another vendor's meeting is not this re-verifier's to touch — and
    // touching it would reconcile it against a Zoom roster.
    const out = await reverifyZoomMeetingAudiences(
      deps({
        audiences: [
          "audience:meeting:meet:abc",
          "audience:meeting:",
          "audience:chat-channel:slack:C01",
        ],
      }),
    );
    expect(out).toEqual(ZERO_REVERIFY);
  });

  it("isolates one audience's failure from the next", async () => {
    let call = 0;
    const out = await reverifyZoomMeetingAudiences(
      deps({
        audiences: [`audience:meeting:zoom:${UUID}`, "audience:meeting:zoom:9xY2bQpLTz6aHcWvNmKdRg=="],
        reconcile: async () => {
          call++;
          if (call === 1) throw new Error("db blip");
          return { added: 1, revoked: 0 };
        },
      }),
    );
    expect([out.failed, out.reconciled]).toEqual([1, 1]);
  });

  it("reports a MISSING token resolver loudly instead of doing nothing", async () => {
    // A re-verifier that quietly no-ops lets every meeting audience age past
    // the staleness bound while the cycle reports success — the exact failure
    // this module exists to prevent.
    const out = await reverifyZoomMeetingAudiences({ ...deps(), resolveToken: undefined });
    expect(out.failed).toBe(1);
  });
});

describe("rotation — this source inherits the shared attempt stamp (#4971)", () => {
  interface Call {
    readonly sql: string;
    readonly params: readonly unknown[];
  }

  /**
   * Run one re-verification pass and hand back every statement it issued.
   *
   * The `query` double is typed to the real dependency signature: a stub typed
   * `async (sql: string) => …` is green under `bun test` and red only in the
   * separate type gate.
   */
  async function runAndRecord(
    overrides: Partial<ZoomAudienceDeps> & { audiences?: string[]; hasMembers?: boolean },
  ): Promise<Call[]> {
    const calls: Call[] = [];
    const audiences = overrides.audiences ?? [`audience:meeting:zoom:${UUID}`];
    const query: NonNullable<ZoomAudienceDeps["query"]> = async <
      T extends Record<string, unknown>,
    >(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      calls.push({ sql, params: params ?? [] });
      if (/workspace_plugins/.test(sql)) {
        return [
          { workspace_id: "ws1", install_id: "zoom-transcripts", config: { accountId: "acc1" } },
        ] as unknown as T[];
      }
      if (sql === REVERIFY_CANDIDATES_SQL) {
        return audiences.map((token) => ({
          token,
          has_members: overrides.hasMembers ?? false,
        })) as unknown as T[];
      }
      return [] as T[];
    };
    await reverifyZoomMeetingAudiences({
      isEnabled: () => true,
      resolveToken: async () => "tok",
      fetchParticipantsPage: async () => ({
        ok: true as const,
        participants: [p("a@x.example", "z1")],
        nextPageToken: null,
      }),
      resolve: async () => ({ resolved: new Map([["z1", "user-1"]]), unresolvedCount: 0 }),
      reconcile: async () => ({ added: 1, revoked: 0 }),
      ...overrides,
      query,
    });
    return calls;
  }

  function touchedAudienceIds(calls: readonly Call[]): readonly string[] {
    const touch = calls.find((call) => call.sql === TOUCH_REVERIFY_ATTEMPT_SQL);
    return (touch?.params[1] as string[] | undefined) ?? [];
  }

  // The ORDER BY that makes rotation work is executed against a real schema in
  // `audience/__tests__/audience-sync-pg.test.ts`, and the scan/stamp coupling
  // is pinned in `audience/__tests__/reverify-scan.test.ts`. What is source-
  // specific — and what this connector could regress on its own — is whether
  // Zoom's own abort paths still go through that seam. They are the paths a
  // stale meeting takes on EVERY cycle, because Zoom's past-meeting participant
  // report ages out of its retention window.

  it("stamps an attempt for a meeting whose roster read FAILS every cycle", async () => {
    // The starvation itself. Before #4971 this audience advanced no column the
    // scan ordered on, so it held a slot at the front forever and everything
    // behind it aged past the staleness bound with `acl.ts` suppressing it.
    //
    // MUTATION THIS CATCHES: reverting `reverifyWorkspace` to its own scan SQL,
    // or moving the stamp into the success branch.
    const touched = touchedAudienceIds(
      await runAndRecord({
        fetchParticipantsPage: async () => ({
          ok: false as const,
          error: "not_found",
          retryAfterSeconds: null,
        }),
      }),
    );
    expect(touched).toEqual([`meeting:zoom:${UUID}`]);
  });

  it("stamps an attempt for the EMPTY-ROSTER refusal too", async () => {
    // The second permanent-failure path, and the one #4965 noted makes the
    // starvation MORE likely rather than less: before that guard an empty roster
    // reconciled (wrongly) and at least stamped `synced_at`. Choosing safety
    // over rotation was right — this is what pays for it.
    //
    // MUTATION THIS CATCHES: stamping only the audiences that reach the
    // reconcile.
    const calls = await runAndRecord({
      hasMembers: true,
      fetchParticipantsPage: async () => ({
        ok: true as const,
        participants: [],
        nextPageToken: null,
      }),
      reconcile: async () => {
        throw new Error("must not reconcile an empty roster over members");
      },
    });
    expect(touchedAudienceIds(calls)).toEqual([`meeting:zoom:${UUID}`]);
  });

  it("stamps an attempt for a token that does not parse as this source's", async () => {
    // A token nothing can ever reconcile is the worst possible thing to leave
    // unstamped: it would sit on a NULL attempt time forever and pin the front
    // of every future scan — #4971's starvation rebuilt out of its one
    // irreparable case.
    //
    // MUTATION THIS CATCHES: stamping inside the loop, after the parse check.
    const calls = await runAndRecord({ audiences: ["audience:meeting:not-a-zoom-token"] });
    expect(touchedAudienceIds(calls)).toEqual(["meeting:not-a-zoom-token"]);
  });

  it("counts a FAILED scan or stamp as a workspace failure, doing no vendor work", async () => {
    // The other half of `selectReverifyCandidates`'s contract: it throws, and
    // the caller counts. Only the throw was covered — this pins the catch.
    //
    // Untested, a `catch { return ZERO_REVERIFY }` around the call restores
    // #4971's exact signature: a source that re-verifies nothing while the cycle
    // reports `success`, because "scan failed" and "nothing to do" are the same
    // empty result. Reachable in production from an unapplied migration, a
    // statement timeout, or a saturated pool.
    //
    // MUTATION THIS CATCHES: swallowing the throw, or dropping the `failed + 1`
    // in the per-workspace catch.
    for (const failing of [REVERIFY_CANDIDATES_SQL, TOUCH_REVERIFY_ATTEMPT_SQL]) {
      let vendorCalls = 0;
      const query: NonNullable<ZoomAudienceDeps["query"]> = async <
        T extends Record<string, unknown>,
      >(
        sql: string,
      ): Promise<T[]> => {
        if (/workspace_plugins/.test(sql)) {
          return [
            { workspace_id: "ws1", install_id: "zoom-transcripts", config: { accountId: "acc1" } },
          ] as unknown as T[];
        }
        if (sql === failing) throw new Error("relation does not exist");
        return [{ token: `audience:meeting:zoom:${UUID}`, has_members: true }] as unknown as T[];
      };
      const out = await reverifyZoomMeetingAudiences({
        isEnabled: () => true,
        resolveToken: async () => "tok",
        query,
        fetchParticipantsPage: async () => {
          vendorCalls++;
          return { ok: true as const, participants: [], nextPageToken: null };
        },
        resolve: async () => ({ resolved: new Map(), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 0, revoked: 0 }),
      });
      expect([out.failed, out.reconciled]).toEqual([1, 0]);
      // A page that could not be stamped must not be WORKED — working it without
      // rotating is the starvation this whole change removes.
      expect(vendorCalls).toBe(0);
    }
  });

  it("scans with the NAMESPACE prefix, not the vendor-narrowed one", async () => {
    // `audience:meeting:` rather than `audience:meeting:zoom:`, deliberately: the
    // scan is coarser than the parser so another vendor's meeting token comes
    // back and gets LOGGED by the parse check above. Narrowing it here would
    // turn that diagnostic into a silent skip.
    //
    // MUTATION THIS CATCHES: passing `audience:meeting:zoom:` as the prefix.
    const calls = await runAndRecord({});
    const scan = calls.find((call) => call.sql === REVERIFY_CANDIDATES_SQL);
    expect(scan?.params.slice(0, 3)).toEqual(["ws1", "zoom", "audience:meeting:"]);
  });
});

describe("the re-verifier registry", () => {
  it("refuses a duplicate registration for one source", () => {
    _resetAudienceReverifiers();
    registerAudienceReverifier("zoom", async () => ZERO_REVERIFY);
    // Two re-verifiers for one source would each reconcile against their own
    // roster, and the loser's members would be revoked every cycle.
    expect(() => registerAudienceReverifier("zoom", async () => ZERO_REVERIFY)).toThrow(
      /already registered/,
    );
    expect(listAudienceReverifierSources()).toEqual(["zoom"]);
    _resetAudienceReverifiers();
  });

  it("counts a re-verifier that throws as a FAILURE, so the cycle reports degraded", async () => {
    // Swallowing it would leave the cycle looking clean while a source's
    // audiences quietly age out.
    _resetAudienceReverifiers();
    registerAudienceReverifier("boom", async () => {
      throw new Error("kaboom");
    });
    const out = await runRegisteredAudienceReverifiers();
    expect(out.failed).toBe(1);
    _resetAudienceReverifiers();
  });

  it("sums across sources and isolates each", async () => {
    _resetAudienceReverifiers();
    registerAudienceReverifier("a", async () => ({ ...ZERO_REVERIFY, reconciled: 2, membersAdded: 5 }));
    registerAudienceReverifier("b", async () => ({ ...ZERO_REVERIFY, reconciled: 1, membersRevoked: 3 }));
    const out = await runRegisteredAudienceReverifiers();
    expect(out).toEqual({
      reconciled: 3,
      failed: 0,
      membersAdded: 5,
      membersRevoked: 3,
      principalsUnresolved: 0,
    });
    _resetAudienceReverifiers();
  });
});

function p(email: string | null, userId: string | null = null) {
  return { email, name: email, userId };
}
