/**
 * The sync cycle's completeness discipline (#4801, ADR-0036 §T6).
 *
 * `membership.ts` deletes everyone outside the roster it is handed, so this
 * module's job is to never hand it a roster it cannot vouch for. Every test
 * below is a way the vendor read can come up short — an error, a page cap, a
 * missing scope wearing the costume of an empty result — and the assertion is
 * always the same shape: the reconcile did NOT run for that audience, so
 * membership is unchanged.
 *
 * The other half is that the audience id comes from `deriveChatChannelGrant`
 * rather than a second derivation, which is what keeps the set being synced
 * identical to the set the facts were granted to.
 */

import { describe, expect, it } from "bun:test";
import { AUDIENCE_PREFIX, parseGrant } from "@atlas/api/lib/brain/acl";
import { deriveChatChannelGrant } from "@atlas/api/lib/brain/ingest/grant";
import { SLACK_HISTORY_SOURCE } from "@atlas/api/lib/brain/ingest/slack/config";
import {
  DEFAULT_AUDIENCE_SYNC_INTERVAL_MS,
  MAX_DIRECTORY_PAGES,
  MAX_ROSTER_PAGES,
  getAudienceSyncIntervalMs,
  isAudienceSyncEnabled,
  runAudienceSyncCycle,
  type AudienceSyncDeps,
} from "../sync";
import type { SlackDirectoryUser } from "@atlas/api/lib/slack/api";

const WORKSPACE = "ws-1";
const PRIVATE_CHANNEL = "C0PRIV";
const PUBLIC_CHANNEL = "C0PUB";

const DIRECTORY: readonly SlackDirectoryUser[] = [
  { id: "U_ADA", email: "ada@corp.test", deleted: false, isBot: false },
  { id: "U_GONE", email: "gone@corp.test", deleted: true, isBot: false },
  { id: "U_BOT", email: null, deleted: false, isBot: true },
];

const ok = <T>(value: T) => Promise.resolve({ ok: true as const, ...value });

interface Recorded {
  readonly workspaceId: string;
  readonly audienceId: string;
  readonly source: string;
  readonly userIds: readonly string[];
}

/**
 * A cycle wired to fixtures. `overrides` shadows individual vendor reads so a
 * test can break exactly one of them and assert the blast radius.
 */
function harness(overrides: Partial<AudienceSyncDeps["api"]> = {}, channels = [PRIVATE_CHANNEL]) {
  const reconciled: Recorded[] = [];
  const deps: AudienceSyncDeps = {
    api: {
      getConversationInfo: (_t, channelId) =>
        ok({
          channel: {
            id: channelId,
            name: channelId,
            isPrivate: channelId !== PUBLIC_CHANNEL,
            isMember: true,
            isArchived: false,
          },
        }),
      fetchConversationMembersPage: () =>
        ok({ memberIds: ["U_ADA", "U_GONE", "U_BOT"], nextCursor: null }),
      fetchUsersListPage: () => ok({ users: DIRECTORY, nextCursor: null, dropped: 0 }),
      ...overrides,
    } as NonNullable<AudienceSyncDeps["api"]>,
    query: (<T extends Record<string, unknown>>() =>
      Promise.resolve([
        { workspace_id: WORKSPACE, install_id: "i1", config: { channels } },
      ] as unknown as T[])) as AudienceSyncDeps["query"],
    resolveToken: () => Promise.resolve("xoxb-test"),
    resolve: (_ws, principals) =>
      Promise.resolve({
        // Every principal with an email resolves — the resolver's own
        // exclusions are its tests' business, not this module's.
        resolved: new Map(
          principals.filter((p) => p.email !== null).map((p) => [p.id, `user-${p.id}`]),
        ),
        unresolvedCount: principals.filter((p) => p.email === null).length,
      }),
    reconcile: (input) => {
      reconciled.push(input);
      return Promise.resolve({ added: input.userIds.length, revoked: 0 });
    },
  };
  return { deps, reconciled };
}

/** `hasInternalDB()` reads DATABASE_URL; set inside tests, never at top level. */
function withDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://stub/stub";
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });
}

describe("runAudienceSyncCycle", () => {
  it("syncs the audience the GRANT names, not a re-derived one", async () => {
    const { deps, reconciled } = harness();
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(result.status).toBe("success");
    expect(reconciled).toHaveLength(1);
    // Derived independently HERE through the production grant path: if the two
    // ever disagree, membership is written for an audience no fact names and
    // every private fact silently returns to invisible.
    const grant = deriveChatChannelGrant({
      source: SLACK_HISTORY_SOURCE,
      channelId: PRIVATE_CHANNEL,
      isPrivate: true,
    });
    const expected = parseGrant(grant ?? []).principals.find((p) => p.kind === "audience");
    expect(reconciled[0]?.audienceId).toBe(expected?.audienceId ?? "(none)");
    expect(`${AUDIENCE_PREFIX}${reconciled[0]?.audienceId}`).toBe((grant ?? [])[0]);
  });

  it("excludes bots and deactivated accounts from the audience", async () => {
    // A deactivated Slack user is someone the workspace already revoked at the
    // source; carrying them in would make Atlas the one system that kept their
    // access.
    const { deps, reconciled } = harness();
    await withDatabaseUrl(() => runAudienceSyncCycle(deps));
    expect(reconciled[0]?.userIds).toEqual(["user-U_ADA"]);
  });

  it("skips a public channel — its grant is [org], so there is no audience", async () => {
    const { deps, reconciled } = harness({}, [PUBLIC_CHANNEL]);
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(0);
    // Counted rather than silently passed over: "12 channels, 0 audiences"
    // must read as "they are all public", not as a broken cycle.
    expect(result.audiencesSkippedPublic).toBe(1);
    expect(result.audiencesFailed).toBe(0);
  });

  it("does NOT reconcile when the roster read fails", async () => {
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: () =>
        Promise.resolve({ ok: false as const, error: "ratelimited", retryAfterSeconds: 30 }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    // The whole point: a failed roster read must not become an empty roster,
    // which would revoke the entire audience.
    expect(reconciled).toHaveLength(0);
    expect(result.audiencesFailed).toBe(1);
    // `degraded`, not `success`: an operator alerting on `status` must be able
    // to fire on "a workspace's membership silently stopped being reconciled".
    expect(result.status).toBe("degraded");
  });

  it("does NOT reconcile when the roster exceeds the page cap", async () => {
    // A truncation is indistinguishable from a roster that ends there, so it is
    // treated as a fault rather than as a complete short roster.
    let pages = 0;
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: () => {
        pages++;
        return ok({ memberIds: ["U_ADA"], nextCursor: "more" });
      },
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(pages).toBe(MAX_ROSTER_PAGES);
    expect(reconciled).toHaveLength(0);
    expect(result.audiencesFailed).toBe(1);
  });

  it("skips the whole workspace when the directory read fails", async () => {
    // Every channel's resolution depends on the directory, so the blast radius
    // is the workspace rather than one audience.
    const { deps, reconciled } = harness({
      fetchUsersListPage: () =>
        Promise.resolve({ ok: false as const, error: "missing_scope", retryAfterSeconds: null }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
    expect(result.audiencesFailed).toBe(0);
  });

  it("treats a directory with no emails at all as a missing scope, not as nobody matching", async () => {
    // `users:read` WITHOUT `users:read.email` returns 200 with every email
    // absent. Read naively that is "no member matched an Atlas account", which
    // reconciles to a full revocation of every audience — while the cycle
    // reports success. The quietest possible catastrophe, so it is detected
    // explicitly.
    const { deps, reconciled } = harness({
      fetchUsersListPage: () =>
        ok({
          users: DIRECTORY.map((u) => ({ ...u, email: null })),
          nextCursor: null,
          dropped: 0,
        }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
  });

  it("isolates a per-channel failure from the workspace's other channels", async () => {
    const { deps, reconciled } = harness(
      {
        fetchConversationMembersPage: (_t, params) =>
          params.channel === "C0BAD"
            ? Promise.resolve({
                ok: false as const,
                error: "not_in_channel",
                retryAfterSeconds: null,
              })
            : ok({ memberIds: ["U_ADA"], nextCursor: null }),
      },
      ["C0BAD", PRIVATE_CHANNEL],
    );
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(result.audiencesFailed).toBe(1);
    expect(result.audiencesReconciled).toBe(1);
    expect(reconciled.map((r) => r.audienceId)).toEqual([
      `chat-channel:${SLACK_HISTORY_SOURCE}:${PRIVATE_CHANNEL}`,
    ]);
  });

  it("forwards the cursor and concatenates pages on BOTH paginated reads", async () => {
    // Without this, deleting the cursor spread from either loop is a GREEN
    // mutation: every page-1 refetch walks to the page cap, the read aborts,
    // and every workspace over 200 users — i.e. most real ones — is skipped
    // forever while the cycle reports success.
    const rosterCursors: (string | undefined)[] = [];
    const directoryCursors: (string | undefined)[] = [];
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: (_t, params) => {
        rosterCursors.push(params.cursor);
        return params.cursor === undefined
          ? ok({ memberIds: ["U_ADA"], nextCursor: "roster-p2" })
          : ok({ memberIds: ["U_TWO"], nextCursor: null });
      },
      fetchUsersListPage: (_t, params) => {
        directoryCursors.push(params.cursor);
        return params.cursor === undefined
          ? ok({ users: [DIRECTORY[0]!], nextCursor: "dir-p2", dropped: 0 })
          : ok({
              users: [{ id: "U_TWO", email: "two@corp.test", deleted: false, isBot: false }],
              nextCursor: null,
              dropped: 0,
            });
      },
    });
    await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(rosterCursors).toEqual([undefined, "roster-p2"]);
    expect(directoryCursors).toEqual([undefined, "dir-p2"]);
    // Both members resolve, so both pages of BOTH reads reached the reconcile —
    // a dropped page would show up as a missing user here, which is a
    // revocation.
    expect(reconciled[0]?.userIds.toSorted()).toEqual(["user-U_ADA", "user-U_TWO"]);
  });

  it("skips the workspace when the directory exceeds the page cap", async () => {
    // Larger blast radius than the roster cap: every channel's resolution
    // depends on the directory.
    let pages = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => {
        pages++;
        return ok({ users: DIRECTORY, nextCursor: "more", dropped: 0 });
      },
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(pages).toBe(MAX_DIRECTORY_PAGES);
    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
  });

  it("skips the workspace when a directory page dropped entries", async () => {
    // An entry Atlas could not identify is a roster member it cannot resolve,
    // and an unresolved member is REVOKED — so a lossy page is a read fault,
    // not a smaller directory.
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => ok({ users: DIRECTORY, nextCursor: null, dropped: 2 }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
  });

  it("treats an EMPTY directory as a read failure, not a workspace with no people", async () => {
    // The sharpest hole the review panel found in the first cut: the all-null-
    // email tripwire could not fire on an empty set, so every roster member
    // missed the lookup, resolved to nobody, and the reconcile deleted the
    // entire audience — reported as success.
    let resolveCalls = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => ok({ users: [], nextCursor: null, dropped: 0 }),
    });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({ resolved: new Map(), unresolvedCount: principals.length });
        },
      }),
    );

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
    expect(resolveCalls).toBe(0);
  });

  it("treats a directory with no LIVE HUMANS as a read failure", async () => {
    // The same mass revocation as the empty-directory case, through a third
    // door — and the one an earlier cut left open, because every guard was
    // keyed on `byId.size` or gated on `humans.length > 0`. A directory of only
    // bots and deactivated accounts has size > 0, so it passed all of them,
    // resolved nobody, and wiped every audience while reporting success.
    //
    // The realistic trigger is not "a workspace of only bots": it is any drift
    // in the `deleted`/`is_bot` mapping in `slack/api.ts`. The parser tests pin
    // that mapping per entry; this pins its directory-wide consequence.
    let resolveCalls = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () =>
        ok({
          users: [
            { id: "U_BOT", email: null, deleted: false, isBot: true },
            { id: "U_GONE", email: "gone@corp.test", deleted: true, isBot: false },
          ],
          nextCursor: null,
          dropped: 0,
        }),
    });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({ resolved: new Map(), unresolvedCount: principals.length });
        },
      }),
    );

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
    expect(result.membersRevoked).toBe(0);
    // Asserted on the CALL COUNT, not just the outcome. `syncInstall`'s
    // collapse check would reach the same verdict one step later, so a bare
    // `workspacesFailed` assertion passes with this guard deleted — it would be
    // a test that proves the backstop, while claiming to prove the guard.
    expect(resolveCalls).toBe(0);
  });

  it("does not let a bot's email mask an otherwise email-less directory", async () => {
    // The tripwire is computed over the population resolution CONSUMES. Counted
    // over every entry, one app user with an address would wave a full
    // revocation through on a token missing users:read.email.
    let resolveCalls = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () =>
        ok({
          users: [
            { id: "U_ADA", email: null, deleted: false, isBot: false },
            { id: "U_APP", email: "app@corp.test", deleted: false, isBot: true },
          ],
          nextCursor: null,
          dropped: 0,
        }),
    });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({ resolved: new Map(), unresolvedCount: principals.length });
        },
      }),
    );

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
    // Same reasoning as the no-live-humans case: the count is what pins the
    // early exit rather than the downstream collapse check.
    expect(resolveCalls).toBe(0);
  });

  it("skips the WORKSPACE when nobody in the directory resolves — resolution collapse", async () => {
    // The realistic cause is a verified SSO domain of `acme.com` against
    // profile emails at `eng.acme.com`, or an SSO provider added after
    // membership was populated. Reconciling would delete every audience in the
    // workspace on the strength of an unrelated admin action.
    const { deps, reconciled } = harness();
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        resolve: (_ws, principals) =>
          Promise.resolve({ resolved: new Map(), unresolvedCount: principals.length }),
      }),
    );

    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
    expect(result.membersRevoked).toBe(0);
  });

  it("STILL revokes when the last resolvable member leaves one channel", async () => {
    // The false positive the collapse check must not have, and the reason it is
    // workspace-level rather than per-audience. Somebody leaving a channel and
    // an SSO domain typo look identical from inside one audience — but only the
    // typo makes the whole DIRECTORY stop resolving. Checking per-audience
    // would block this legitimate revocation, preserving exactly the stale
    // access the subsystem exists to drop.
    const { deps, reconciled } = harness({
      // The directory still resolves U_ADA; this channel's roster simply no
      // longer contains anyone resolvable.
      fetchConversationMembersPage: () => ok({ memberIds: ["U_BOT", "U_GONE"], nextCursor: null }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.userIds).toEqual([]);
    expect(result.audiencesFailed).toBe(0);
    expect(result.workspacesFailed).toBe(0);
  });

  it("does not count bots or deactivated members as unresolved principals", async () => {
    // `principals_unresolved` is an operator metric meaning "people who could
    // not be matched". A bot is not a person; counting it would inflate the
    // number in every channel Atlas is invited to and bury the real signal.
    const { deps } = harness({
      fetchConversationMembersPage: () =>
        ok({ memberIds: ["U_ADA", "U_BOT", "U_GONE"], nextCursor: null }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));
    expect(result.principalsUnresolved).toBe(0);
  });

  it("resolves the directory ONCE per workspace, not once per channel", async () => {
    // The directory is workspace-scoped, so a per-channel resolve would re-run
    // the same query for identical data — and, more importantly, would make the
    // collapse check per-audience, which is the false positive above.
    let resolveCalls = 0;
    const { deps } = harness({}, [PRIVATE_CHANNEL, "C0PRIV2", "C0PRIV3"]);
    await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({
            resolved: new Map(
              principals.filter((p) => p.email !== null).map((p) => [p.id, `user-${p.id}`]),
            ),
            unresolvedCount: 0,
          });
        },
      }),
    );
    expect(resolveCalls).toBe(1);
  });

  it("counts a roster member missing from the directory as unresolved, not as absent", async () => {
    // A Slack Connect guest from another workspace. "Logged, never guessed" has
    // a counting half — an uncounted exclusion is indistinguishable from a
    // roster that never contained them.
    const { deps } = harness({
      fetchConversationMembersPage: () => ok({ memberIds: ["U_ADA", "U_STRANGER"], nextCursor: null }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(result.principalsUnresolved).toBe(1);
    expect(result.audiencesReconciled).toBe(1);
  });

  it("propagates reconcile counts into the cycle result", async () => {
    // `members_revoked` is the span attribute an operator alerts on; nothing
    // else pins that a nonzero reconcile survives the two accumulator spreads.
    const { deps } = harness();
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        reconcile: () => Promise.resolve({ added: 2, revoked: 3 }),
      }),
    );
    expect(result.membersAdded).toBe(2);
    expect(result.membersRevoked).toBe(3);
  });

  it("counts a failed channel-visibility read as a failed audience", async () => {
    const { deps, reconciled } = harness({
      getConversationInfo: () =>
        Promise.resolve({ ok: false as const, error: "channel_not_found", retryAfterSeconds: null }),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(reconciled).toHaveLength(0);
    expect(result.audiencesFailed).toBe(1);
  });

  it("counts an unusable install config as a workspace failure", async () => {
    const { deps, reconciled } = harness();
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        query: (<T extends Record<string, unknown>>() =>
          Promise.resolve([
            { workspace_id: WORKSPACE, install_id: "i1", config: { channels: [] } },
          ] as unknown as T[])) as AudienceSyncDeps["query"],
      }),
    );
    expect(reconciled).toHaveLength(0);
    expect(result.workspacesFailed).toBe(1);
  });

  it("reports a scan failure as failure rather than as an empty successful cycle", async () => {
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        query: (() => Promise.reject(new Error("relation does not exist"))) as AudienceSyncDeps["query"],
      }),
    );
    expect(result.status).toBe("failure");
    expect(result.error).toContain("relation does not exist");
  });

  it("returns a zeroed success with no internal database", async () => {
    const prior = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = await runAudienceSyncCycle({});
      expect(result).toMatchObject({ status: "success", workspacesInspected: 0 });
    } finally {
      if (prior !== undefined) process.env.DATABASE_URL = prior;
    }
  });
});

describe("gating and cadence", () => {
  it("skips a workspace that opted out, without reading Slack at all", async () => {
    // The tenant consent switch. An inverted predicate or a typo'd key fails in
    // the PERMISSIVE direction — Atlas reads the directory of a workspace that
    // said no, and the cycle reports success — so nothing else here would catch
    // it.
    let slackReads = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => {
        slackReads++;
        return ok({ users: DIRECTORY, nextCursor: null, dropped: 0 });
      },
    });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({ ...deps, isEnabled: () => false }),
    );

    expect(result.workspacesSkippedDisabled).toBe(1);
    expect(result.workspacesInspected).toBe(0);
    expect(reconciled).toHaveLength(0);
    expect(slackReads).toBe(0);
    // A skip is not a failure — it is the workspace's decision, honoured.
    expect(result.status).toBe("success");
  });

  it("is enabled by default and disabled only by an explicit 'false'", async () => {
    // Deliberately `!== "false"`, unlike the sibling extraction knob's
    // `=== "true"` — this one defaults ON. The asymmetry is intentional and
    // documented, and this is what stops someone "normalising" the two.
    expect(isAudienceSyncEnabled("ws-unset")).toBe(true);
  });

  it("falls back to the default interval on a non-positive or unparseable value", () => {
    // The setting's user-facing description promises this fallback.
    expect(getAudienceSyncIntervalMs()).toBe(DEFAULT_AUDIENCE_SYNC_INTERVAL_MS);
  });
});
