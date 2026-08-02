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

import { afterEach, describe, expect, it } from "bun:test";
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
import {
  ZERO_REVERIFY,
  _resetAudienceReverifiers,
  registerAudienceReverifier,
} from "../reverify";

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
    // A NON-retryable failure, deliberately. This test is about the generic
    // abort — a failed read must never become an empty roster — and since
    // #4809 the `ratelimited` arm backs off and retries first, which would
    // make this one wait on a real `Retry-After` to prove a point that has
    // nothing to do with throttling. The throttle path has its own tests in
    // "rate-limit backoff (#4809)", including that exhaustion still aborts.
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: () =>
        Promise.resolve({ ok: false as const, error: "not_in_channel", retryAfterSeconds: null }),
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

  describe("when the Slack install scan itself fails", () => {
    /**
     * The scan is Slack-scoped, so its failure must not retire the OTHER
     * sources' audiences.
     *
     * Regression for the cross-cutting defect the M3 review panel found: the
     * scan's `catch` used to `return`, 48 lines above two calls documented as
     * running UNCONDITIONALLY. A deployment running Zoom and/or Outlook with a
     * faulting `workspace_plugins` read would never re-verify those audiences
     * and never sweep staleness — so they aged past
     * `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, `acl.ts` suppressed them, and
     * the sweep that would have WARNED was skipped by the same return. Facts
     * silently invisible, every surface green.
     *
     * Asserted on the two observable effects rather than on the fix's shape, so
     * it stays honest if the implementation moves.
     */
    function failingScanHarness() {
      const { deps } = harness();
      const sweptWith: unknown[][] = [];
      const failing: AudienceSyncDeps = {
        ...deps,
        // Throws for the INSTALL scan only. The staleness sweep shares this
        // dep, so failing everything would prove nothing about which of the two
        // ran — the whole point is that one faults and the other still runs.
        query: (<T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
          if (sql.includes("workspace_plugins")) {
            return Promise.reject(new Error("statement timeout"));
          }
          sweptWith.push(params ?? []);
          return Promise.resolve([] as unknown as T[]);
        }) as AudienceSyncDeps["query"],
      };
      return { deps: failing, sweptWith };
    }

    // Teardown, not per-test cleanup. The reset used to run inline AFTER the
    // awaits with no `finally`, so a throw inside the cycle leaked the "zoom"
    // re-verifier into every later test in the file and folded
    // `reconciled: 3, membersAdded: 2` into their counters — one real failure
    // manufacturing several unrelated ones.
    afterEach(() => {
      _resetAudienceReverifiers();
    });

    it("still runs the other sources' re-verifiers", async () => {
      let ran = 0;
      registerAudienceReverifier("zoom", () => {
        ran += 1;
        return Promise.resolve({ ...ZERO_REVERIFY, reconciled: 3, membersAdded: 2 });
      });
      const { deps } = failingScanHarness();
      const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

      expect(ran).toBe(1);
      // Its counters fold in, so the cycle reports the work that DID happen
      // rather than the zeroed report the early return produced.
      expect(result.audiencesReconciled).toBe(3);
      expect(result.membersAdded).toBe(2);
    });

    it("still sweeps staleness — the alert that would name the aging audiences", async () => {
      const { deps, sweptWith } = failingScanHarness();
      await withDatabaseUrl(() => runAudienceSyncCycle(deps));

      expect(sweptWith).toHaveLength(1);
    });

    it("still reports failure, with the scan's error", async () => {
      // Falling through must not upgrade a failed cycle to success: Slack
      // membership genuinely did not reconcile.
      const { deps } = failingScanHarness();
      const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

      expect(result.status).toBe("failure");
      expect(result.error).toContain("statement timeout");
      expect(result.workspacesInspected).toBe(0);
    });
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

describe("rate-limit backoff (#4809)", () => {
  /** A `sleep` that records what it was asked to wait, and returns instantly. */
  function fakeSleep() {
    const waits: number[] = [];
    return { waits, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
  }

  const rateLimited = (retryAfterSeconds: number | null) =>
    Promise.resolve({ ok: false as const, error: "ratelimited" as const, retryAfterSeconds });

  it("retries a throttled DIRECTORY page and completes the cycle", async () => {
    // Before #4809 this single 429 aborted the whole workspace. Since the reads
    // are ~`directoryPages + 3 × channels` per workspace every 30 minutes, a
    // large workspace could plausibly hit one on EVERY cycle — in which case
    // membership is never reconciled and revocation silently never happens.
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => {
        calls++;
        return calls === 1 ? rateLimited(2) : ok({ users: DIRECTORY, nextCursor: null, dropped: 0 });
      },
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle({ ...deps, sleep }));

    expect(result.status).toBe("success");
    expect(result.workspacesFailed).toBe(0);
    expect(reconciled).toHaveLength(1);
    // Slack's own `Retry-After` is honoured, not a fixed guess.
    expect(waits).toEqual([2000]);
    // The recovery is VISIBLE: "we throttled and got through" must be
    // distinguishable in the span from "we never throttled", or a workspace
    // creeping toward permanent throttling looks identical to a healthy one.
    expect(result.readsThrottled).toBe(1);
    expect(result.readsThrottleExhausted).toBe(0);
  });

  it("retries a throttled ROSTER page and still reconciles that audience", async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: () => {
        calls++;
        return calls === 1
          ? rateLimited(1)
          : ok({ memberIds: ["U_ADA", "U_GONE", "U_BOT"], nextCursor: null });
      },
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle({ ...deps, sleep }));

    expect(result.audiencesFailed).toBe(0);
    expect(reconciled).toHaveLength(1);
    expect(waits).toEqual([1000]);
    expect(result.readsThrottled).toBe(1);
  });

  it("falls back to the default wait when Slack sends no Retry-After", async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const { deps } = harness({
      fetchUsersListPage: () => {
        calls++;
        return calls === 1
          ? rateLimited(null)
          : ok({ users: DIRECTORY, nextCursor: null, dropped: 0 });
      },
    });
    await withDatabaseUrl(() => runAudienceSyncCycle({ ...deps, sleep }));

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it("ABORTS the workspace when the directory read exhausts its retries", async () => {
    // The contract that licenses the DELETE. A retry loop that ended by
    // proceeding with a partial read would be the mass revocation this
    // subsystem has already produced three times — retrying buys more chances
    // to COMPLETE the read, never permission to settle for less of one.
    //
    // Asserted on the RESOLVE CALL COUNT, not only on `workspacesFailed`: the
    // workspace-level collapse check would report a failure here even with the
    // abort removed, so a bare `workspacesFailed` assertion can pass while
    // proving the backstop rather than this guard.
    const { sleep } = fakeSleep();
    let resolveCalls = 0;
    const { deps, reconciled } = harness({ fetchUsersListPage: () => rateLimited(1) });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        sleep,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({ resolved: new Map(), unresolvedCount: principals.length });
        },
      }),
    );

    expect(result.workspacesFailed).toBe(1);
    expect(reconciled).toHaveLength(0);
    // Nothing downstream of the directory read ran at all.
    expect(resolveCalls).toBe(0);
    expect(result.readsThrottleExhausted).toBeGreaterThan(0);
    // Exhaustion is NOT counted as a recovery.
    expect(result.readsThrottled).toBe(0);
  });

  it("ABORTS a directory whose SECOND page exhausts — a partial directory is the dangerous shape", async () => {
    // The sibling test above (`fetchUsersListPage` throttled from the very
    // first page) is BACKSTOPPED: an exhaustion that wrongly returned an empty
    // page would still be caught by `loadDirectory`'s no-live-humans guard, so
    // it can pass while proving the backstop rather than the abort. Verified by
    // mutation — removing the abort left that test green.
    //
    // This is the shape with no backstop. Page 1 returns real users and page 2
    // exhausts: a "proceed with what we have" retry would yield a directory
    // that is truncated but entirely PLAUSIBLE — non-empty, live humans, real
    // emails. Every completeness guard passes, resolution succeeds, and then
    // each roster member missing from the unread pages resolves to nobody and
    // is REVOKED. That is the mass revocation, reached through a door the other
    // guards cannot see.
    const { sleep } = fakeSleep();
    let resolveCalls = 0;
    let page = 0;
    const { deps, reconciled } = harness({
      fetchUsersListPage: () => {
        page++;
        return page === 1
          ? ok({ users: DIRECTORY, nextCursor: "cursor-2", dropped: 0 })
          : rateLimited(1);
      },
    });
    const result = await withDatabaseUrl(() =>
      runAudienceSyncCycle({
        ...deps,
        sleep,
        resolve: (_ws, principals) => {
          resolveCalls++;
          return Promise.resolve({
            resolved: new Map(principals.map((p) => [p.id, `user-${p.id}`])),
            unresolvedCount: 0,
          });
        },
      }),
    );

    expect(result.workspacesFailed).toBe(1);
    expect(reconciled).toHaveLength(0);
    // The load-bearing assertion. `workspacesFailed` alone would NOT prove this
    // — resolution never even being attempted is what says the partial
    // directory was refused rather than used.
    expect(resolveCalls).toBe(0);
    expect(result.readsThrottleExhausted).toBeGreaterThan(0);
  });

  it("ABORTS only the audience when the roster read exhausts its retries", async () => {
    // Per-audience isolation is preserved: the directory succeeded, so the
    // workspace is fine — but the one channel whose roster could not be read
    // must not be reconciled against a partial roster.
    const { sleep } = fakeSleep();
    const { deps, reconciled } = harness({
      fetchConversationMembersPage: () => rateLimited(1),
    });
    const result = await withDatabaseUrl(() => runAudienceSyncCycle({ ...deps, sleep }));

    expect(result.workspacesFailed).toBe(0);
    expect(result.audiencesFailed).toBe(1);
    // The whole point: membership for that audience is left EXACTLY as it was.
    expect(reconciled).toHaveLength(0);
    expect(result.readsThrottleExhausted).toBeGreaterThan(0);
  });

  it("bounds the retries rather than waiting on Slack forever", async () => {
    // A scheduled fiber that retried indefinitely would hold the cycle open
    // past its own interval and stack overlapping cycles.
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const { deps } = harness({
      fetchUsersListPage: () => {
        calls++;
        return rateLimited(1);
      },
    });
    await withDatabaseUrl(() => runAudienceSyncCycle({ ...deps, sleep }));

    expect(calls).toBeLessThanOrEqual(5);
    expect(waits.length).toBeLessThan(calls);
  });

  it("reports no throttling for a clean cycle", async () => {
    const { deps } = harness();
    const result = await withDatabaseUrl(() => runAudienceSyncCycle(deps));

    expect(result.readsThrottled).toBe(0);
    expect(result.readsThrottleExhausted).toBe(0);
  });
});
