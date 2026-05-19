/**
 * Tests for `createSlackProactiveUserResolver` (#2624).
 *
 * The factory is the SaaS implementation of the chat plugin's
 * `ProactiveUserResolver`. Pin behaviour:
 *
 *  - Non-Slack platforms → `{ atlasUserId: undefined }` (no Slack-bot
 *    handling, no throw).
 *  - Missing/empty workspaceId → `{ atlasUserId: undefined }` (defensive
 *    — the listener short-circuits on empty workspaceIds before
 *    invoking the resolver, but the resolver must not collapse all
 *    tenants onto a single global path if a future caller bypasses
 *    the listener).
 *  - Unknown workspaceId (verifier returns false) → `{ atlasUserId:
 *    undefined }`.
 *  - Known workspaceId → `{ atlasUserId: undefined }` (no Slack-user
 *    link table exists yet — the hook point is documented in the
 *    factory; once the link table lands the resolver returns the
 *    Atlas user id for matches).
 *  - Verifier throws → `{ atlasUserId: undefined }` (registry hiccup
 *    falls through to the public-dataset gate; the resolver MUST NOT
 *    surface as `kind: "errored"` for this case because that would
 *    block every asker behind an apology copy during a DB blip).
 *
 * No `mock.module()` here — the factory exposes its DB lookup via the
 * `verifyWorkspace` option for exactly this reason. The default-path
 * test (no override) drops to `hasInternalDB() === false` (no
 * `DATABASE_URL` in the test env) which returns false from the
 * default verifier — assertable without touching Postgres.
 */

import { describe, it, expect, mock } from "bun:test";

import { createSlackProactiveUserResolver } from "../user-resolver";

const slackAsker = {
  platform: "slack",
  externalUserId: "U-asker",
  userName: "alice",
};

describe("createSlackProactiveUserResolver", () => {
  it("returns unlinked for non-Slack platforms without invoking verifyWorkspace", async () => {
    const verifyWorkspace = mock(async () => true);
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const out = await resolver(
      { platform: "teams", externalUserId: "T-1", userName: "bob" },
      { workspaceId: "ws-1" },
    );

    expect(out).toEqual({ atlasUserId: undefined });
    expect(verifyWorkspace).not.toHaveBeenCalled();
  });

  it("returns unlinked when workspaceId is empty (defensive — listener should not reach this)", async () => {
    const verifyWorkspace = mock(async () => true);
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const out = await resolver(slackAsker, { workspaceId: "" });

    expect(out).toEqual({ atlasUserId: undefined });
    // The empty-workspaceId short-circuit MUST run before the DB
    // lookup — a global lookup with empty `WHERE org_id = ''` would
    // match nothing but still hit the DB unnecessarily.
    expect(verifyWorkspace).not.toHaveBeenCalled();
  });

  it("returns unlinked when verifyWorkspace returns false (unknown tenant)", async () => {
    const verifyWorkspace = mock(async (_id: string) => false);
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const out = await resolver(slackAsker, { workspaceId: "ws-unknown" });

    expect(out).toEqual({ atlasUserId: undefined });
    expect(verifyWorkspace).toHaveBeenCalledWith("ws-unknown");
  });

  it("returns unlinked even when verifyWorkspace returns true — no Slack-user link table yet", async () => {
    // Today's pragmatic behaviour: every asker takes the unlinked
    // path because no `slack_user_links` table exists in core. The
    // hook point is documented in the resolver — when the link
    // table lands, replace the inner branch with a real lookup.
    const verifyWorkspace = mock(async (_id: string) => true);
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const out = await resolver(slackAsker, { workspaceId: "ws-known" });

    expect(out).toEqual({ atlasUserId: undefined });
    expect(verifyWorkspace).toHaveBeenCalledWith("ws-known");
  });

  it("falls back to unlinked when verifyWorkspace throws (registry hiccup, not control-path failure)", async () => {
    // Reasoning the comment in `user-resolver.ts` pins: a DB outage
    // here should NOT throw out of the resolver (which would surface
    // as `kind: "errored"` in the listener → apology copy → no answer
    // at all). The listener's public-dataset gate IS the refuse-safe
    // branch; collapsing the hiccup onto "unlinked" routes the asker
    // through that gate.
    const verifyWorkspace = mock(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const out = await resolver(slackAsker, { workspaceId: "ws-troubled" });

    expect(out).toEqual({ atlasUserId: undefined });
    expect(verifyWorkspace).toHaveBeenCalled();
  });

  it("passes the workspaceId straight through to verifyWorkspace (no normalization)", async () => {
    // Multi-tenant correctness: a future code path that pre-normalizes
    // the workspaceId (case-fold, trim) MUST happen at the listener's
    // resolver, not silently inside this factory. Pin the pass-through.
    const verifyWorkspace = mock(async (_id: string) => true);
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    await resolver(slackAsker, { workspaceId: "WS-MixedCase-42" });

    expect(verifyWorkspace).toHaveBeenCalledTimes(1);
    expect(verifyWorkspace.mock.calls[0]![0]).toBe("WS-MixedCase-42");
  });

  it("isolates two tenants seeing the same Slack externalUserId (#2624 collision case)", async () => {
    // The point of #2624: a single Slack user-id may appear in
    // multiple tenants on SaaS. The resolver MUST query the verifier
    // with each per-event workspaceId distinctly — no global lookup,
    // no caching keyed on asker.externalUserId. This test reproduces
    // the collision scenario the issue body called out and pins that
    // both invocations hit the verifier separately.
    const observed: string[] = [];
    const verifyWorkspace = mock(async (id: string) => {
      observed.push(id);
      return id === "ws-A"; // pretend only ws-A is installed
    });
    const resolver = createSlackProactiveUserResolver({ verifyWorkspace });

    const sharedAsker = {
      platform: "slack",
      externalUserId: "U-shared",
      userName: "shared",
    };

    const outA = await resolver(sharedAsker, { workspaceId: "ws-A" });
    const outB = await resolver(sharedAsker, { workspaceId: "ws-B" });

    // Both tenants are evaluated independently — no collision, no
    // caching by asker identity. Until a link table lands both
    // return unlinked, but the verifier received both ids.
    expect(observed).toEqual(["ws-A", "ws-B"]);
    expect(outA).toEqual({ atlasUserId: undefined });
    expect(outB).toEqual({ atlasUserId: undefined });
  });

  it("default verifier returns false without an internal DB (self-hosted / no DATABASE_URL)", async () => {
    // Drop-the-override path: when no `verifyWorkspace` is supplied,
    // the factory uses `defaultVerifyWorkspace` which short-circuits
    // on `hasInternalDB() === false`. The test runner doesn't expose
    // an internal DB (no DATABASE_URL set), so the verifier resolves
    // to false → unlinked. This pins the self-hosted/no-DB posture.
    const resolver = createSlackProactiveUserResolver();
    const out = await resolver(slackAsker, { workspaceId: "ws-any" });
    expect(out).toEqual({ atlasUserId: undefined });
  });
});
