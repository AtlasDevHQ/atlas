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

  function deps(
    overrides: Partial<ZoomAudienceDeps> & { audiences?: string[]; hasMembers?: boolean } = {},
  ): ZoomAudienceDeps {
    const audiences = overrides.audiences ?? [`audience:meeting:zoom:${UUID}`];
    return {
      isEnabled: () => true,
      resolveToken: async () => "tok",
      query: (async (sql: string) =>
        /workspace_plugins/.test(sql)
          ? [install]
          : audiences.map((token) => ({
              token,
              synced_at: null,
              has_members: overrides.hasMembers ?? false,
            }))) as never,
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
