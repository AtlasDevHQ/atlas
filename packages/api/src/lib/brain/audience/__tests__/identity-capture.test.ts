/**
 * The capture pass — which authors get a name, and which name (#5440,
 * ADR-0036 §T5's `Amendment (2026-08-25, #5440)`).
 *
 * Two properties carry this module, and both are the kind that pass a naive
 * test and fail the design:
 *
 *   1. **The bound is AUTHORSHIP.** The directory it is handed is the WHOLE
 *      workspace; what it persists is the intersection with the principals
 *      whose episodes Atlas actually ingested. Persisting the directory would
 *      be a copy of the customer's roster, which the ADR refuses by name — and
 *      it would look identical from every surface that only reads back what it
 *      wrote.
 *   2. **`atlas` beats `directory`.** A live join stays current; a snapshot
 *      goes stale with no re-derivation path. The reverse precedence would
 *      freeze a colleague's name at the moment they were ingested, and would
 *      still render a name, so nothing but this test would notice.
 */

import { describe, expect, it } from "bun:test";
import type { SlackDirectoryUser } from "@atlas/api/lib/slack/api";
import {
  captureAuthoringIdentities,
  decideIdentity,
} from "@atlas/api/lib/brain/audience/identity-capture";
import { AUTHORING_PRINCIPALS_SQL, type ActorIdentityReader } from "@atlas/api/lib/brain/actor-identity";

const WS = "ws-capture";

function user(partial: Partial<SlackDirectoryUser> & { id: string }): SlackDirectoryUser {
  return {
    email: null,
    displayName: null,
    realName: null,
    deleted: false,
    isBot: false,
    ...partial,
  };
}

/**
 * A reader that answers the authoring-principals query from a fixed list and
 * records every capture write.
 */
function harness(authors: readonly { actor: string; source: string; vendor_user_id: string }[]) {
  const writes: unknown[][] = [];
  const db: ActorIdentityReader = {
    query: async (sql, params) => {
      if (sql === AUTHORING_PRINCIPALS_SQL) return { rows: authors };
      writes.push(params ?? []);
      return { rows: [{ actor: (params ?? [])[1] }] };
    },
  };
  return { db, writes };
}

describe("decideIdentity — the three-state decision", () => {
  it("prefers the LIVE Atlas join over a directory snapshot when both exist", () => {
    // Order matters. A snapshot here would be strictly worse: it goes stale
    // with no re-derivation path, and renaming the account would stop changing
    // the surface — which is the acceptance criterion.
    const capture = decideIdentity(
      "slack:U1",
      "slack",
      "U1",
      "user-1",
      user({ id: "U1", displayName: "ada", email: "ada@corp.test" }),
    );
    expect(capture).toEqual({
      actor: "slack:U1",
      source: "slack",
      vendorUserId: "U1",
      state: "atlas",
      userId: "user-1",
    });
    // And it carries NO name — the row stores a pointer.
    expect("displayName" in capture).toBe(false);
  });

  it("snapshots the directory when there is no Atlas account", () => {
    // The majority case, and the whole reason `actorUserId` was rejected:
    // contractors, guests and people who have left all speak in ingested
    // channels, and the resolver REFUSES to guess for them.
    expect(
      decideIdentity(
        "slack:U2",
        "slack",
        "U2",
        undefined,
        user({ id: "U2", displayName: "dana", realName: "Dana Okafor", email: "d@x.test" }),
      ),
    ).toEqual({
      actor: "slack:U2",
      source: "slack",
      vendorUserId: "U2",
      state: "directory",
      displayName: "dana",
      realName: "Dana Okafor",
      email: "d@x.test",
    });
  });

  it("snapshots on ANY one naming field, since the vendor leaves them unset freely", () => {
    expect(decideIdentity("slack:U3", "slack", "U3", undefined, user({ id: "U3", realName: "Q" })))
      .toMatchObject({ state: "directory", displayName: null, realName: "Q", email: null });
    expect(decideIdentity("slack:U4", "slack", "U4", undefined, user({ id: "U4", email: "e@x" })))
      .toMatchObject({ state: "directory", email: "e@x" });
  });

  it("falls to `opaque` when the directory has no entry, or names nobody", () => {
    // A Slack Connect guest from another workspace, or a token without
    // `users:read.email` against a profile with no display or real name.
    // `opaque` is a POSITIVE record of that — the surface says "cannot name
    // this person" rather than rendering a blank or the handle.
    expect(decideIdentity("slack:U5", "slack", "U5", undefined, undefined)).toEqual({
      actor: "slack:U5",
      source: "slack",
      vendorUserId: "U5",
      state: "opaque",
    });
    expect(
      decideIdentity("slack:U6", "slack", "U6", undefined, user({ id: "U6" })),
    ).toMatchObject({ state: "opaque" });
  });

  it("treats an empty resolved user id as unresolved rather than as an atlas row", () => {
    // `ck_brain_actor_identity_atlas_shape` requires `user_id <> ''`, so an
    // empty string would abort the write. Falling through to the snapshot is
    // both writable and more useful.
    expect(
      decideIdentity("slack:U7", "slack", "U7", "", user({ id: "U7", displayName: "z" })),
    ).toMatchObject({ state: "directory" });
  });
});

describe("captureAuthoringIdentities — the bound is authorship", () => {
  it("writes ONLY for principals who authored an ingested episode", async () => {
    // ⚠️ THE property. The directory below holds three people; one of them has
    // spoken into the Atlas. Persisting the other two would be a directory copy
    // and the ADR refuses it by name.
    const { db, writes } = harness([
      { actor: "slack:U1", source: "slack", vendor_user_id: "U1" },
    ]);
    const directory = new Map<string, SlackDirectoryUser>([
      ["U1", user({ id: "U1", displayName: "ada" })],
      ["U2", user({ id: "U2", displayName: "never-spoke" })],
      ["U3", user({ id: "U3", displayName: "also-never-spoke" })],
    ]);

    const out = await captureAuthoringIdentities({
      workspaceId: WS,
      source: "slack",
      directory,
      resolved: new Map(),
      db,
    });

    expect(out).toEqual({ authors: 1, atlas: 0, directory: 1, opaque: 0, erasureHeld: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toBe("slack:U1");
    // Named explicitly, because "we wrote one row" would also hold if the
    // implementation wrote the WRONG one.
    expect(JSON.stringify(writes)).not.toContain("never-spoke");
  });

  it("names a DEACTIVATED author and a BOT, unlike the membership half", async () => {
    // `sync.ts` filters `liveHumans` before resolving audience membership,
    // because neither should hold a grant. Naming inverts both: a deactivated
    // author is exactly the case the dated snapshot exists for (nobody else
    // will ever be able to name them), and a bot's name is not personal data at
    // all. Naming confers no membership, so the revocation argument does not
    // reach here.
    const { db, writes } = harness([
      { actor: "slack:U_GONE", source: "slack", vendor_user_id: "U_GONE" },
      { actor: "slack:U_BOT", source: "slack", vendor_user_id: "U_BOT" },
    ]);
    const out = await captureAuthoringIdentities({
      workspaceId: WS,
      source: "slack",
      directory: new Map([
        ["U_GONE", user({ id: "U_GONE", realName: "Sam Who Left", deleted: true })],
        ["U_BOT", user({ id: "U_BOT", displayName: "Zapier", isBot: true })],
      ]),
      resolved: new Map(),
      db,
    });
    expect(out.directory).toBe(2);
    expect(JSON.stringify(writes)).toContain("Sam Who Left");
    expect(JSON.stringify(writes)).toContain("Zapier");
  });

  it("counts an erasure that held, and does not report it as a failure", async () => {
    // The capture SQL's `WHERE erased_at IS NULL` returns no row. That is a
    // normal outcome — the operator's decision standing — not an error, and
    // reporting it as one would train an operator to ignore the counter.
    const db: ActorIdentityReader = {
      query: async (sql) =>
        sql === AUTHORING_PRINCIPALS_SQL
          ? { rows: [{ actor: "slack:U1", source: "slack", vendor_user_id: "U1" }] }
          : { rows: [] },
    };
    const out = await captureAuthoringIdentities({
      workspaceId: WS,
      source: "slack",
      directory: new Map([["U1", user({ id: "U1", displayName: "ada" })]]),
      resolved: new Map(),
      db,
    });
    expect(out).toEqual({ authors: 1, atlas: 0, directory: 0, opaque: 0, erasureHeld: 1 });
  });

  it("isolates a per-author write failure instead of aborting the pass", async () => {
    // One unwritable row must not cost the whole cycle — the OTHER half of
    // which keeps `audience:` grants from aging past the staleness bound.
    let seen = 0;
    const db: ActorIdentityReader = {
      query: async (sql, params) => {
        if (sql === AUTHORING_PRINCIPALS_SQL) {
          return {
            rows: [
              { actor: "slack:U1", source: "slack", vendor_user_id: "U1" },
              { actor: "slack:U2", source: "slack", vendor_user_id: "U2" },
            ],
          };
        }
        seen++;
        if (seen === 1) throw new Error("deadlock detected");
        return { rows: [{ actor: (params ?? [])[1] }] };
      },
    };
    const out = await captureAuthoringIdentities({
      workspaceId: WS,
      source: "slack",
      directory: new Map([
        ["U1", user({ id: "U1", displayName: "a" })],
        ["U2", user({ id: "U2", displayName: "b" })],
      ]),
      resolved: new Map(),
      db,
    });
    expect(out.authors).toBe(2);
    expect(out.directory).toBe(1);
  });

  it("does nothing at all for a workspace with no ingested authors", async () => {
    const { db, writes } = harness([]);
    const out = await captureAuthoringIdentities({
      workspaceId: WS,
      source: "slack",
      directory: new Map([["U1", user({ id: "U1", displayName: "ada" })]]),
      resolved: new Map(),
      db,
    });
    expect(out.authors).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("composes the handle the same way `resolvedPrincipal` does", () => {
    // A claim whose `provenance.actor` does not match a captured row renders
    // `opaque` SILENTLY, which is the hardest failure here to notice. So the
    // separator lives in one place — this SQL — rather than being re-spelled in
    // TypeScript beside it.
    expect(AUTHORING_PRINCIPALS_SQL).toContain("e.source || ':' || e.source_actor AS actor");
    expect(AUTHORING_PRINCIPALS_SQL).toContain("FROM brain_episodes e");
  });
});
