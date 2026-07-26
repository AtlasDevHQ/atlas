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
  MAX_ROSTER_PAGES,
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
      fetchUsersListPage: () => ok({ users: DIRECTORY, nextCursor: null }),
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
    expect(result.status).toBe("success");
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
