/**
 * Unit coverage for brain reader-identity resolution (#4773).
 *
 * This module exists to catch two failures that are invisible from every
 * surface that would suffer them, so most of these probe a guard rather than
 * a happy path:
 *
 *   - a member-table FAILURE must refuse the read, not silently strip the
 *     reader's `role:` tokens. The trap is that the obvious guard ("did the
 *     session carry a role we then failed to re-resolve?") does not work:
 *     `AtlasUser.role` can be absent, and a session-time lookup failure is one
 *     of the things that erases it — so the guard is blindest in precisely the
 *     case it exists for. "REFUSES when the
 *     member lookup fails and the session carries no role" is the test that
 *     fails against that guard.
 *   - a role that did NOT come from this workspace's member row must not be
 *     forwarded as if it had. That direction is fail-OPEN — it would mint
 *     `role:` ACL tokens in a workspace the reader is not a member of.
 *
 * Both fall out of the module asking ONE narrow question of the member table
 * with the session role deliberately withheld, which is also why a platform
 * admin who happens to be a real member keeps their grant.
 *
 * `resolveEffectiveRoleStrict` reads through `internalQuery`, so this file
 * mocks `db/internal` (all exports, via the sanctioned helper). The audience
 * expansion takes a structural handle, which is passed as a literal.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const WS = "ws-reader-context";

let memberRows: { role: string }[] = [];
let memberLookupError: Error | null = null;

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async () => {
      if (memberLookupError) throw memberLookupError;
      return memberRows;
    },
    hasInternalDB: () => true,
  }),
  hasInternalDB: () => true,
}));

const {
  BrainReaderIdentityError,
  BrainRoleUnresolvedError,
  resolveBrainReaderContext,
} = await import("@atlas/api/lib/brain/reader-context");

/** Audience expansion only — the member lookup goes through `internalQuery`. */
const audienceDb = { query: async () => ({ rows: [] as unknown[] }) };

function user(overrides: Partial<AtlasUser> = {}): AtlasUser {
  return { id: "user-1", activeOrganizationId: WS, ...overrides } as AtlasUser;
}

beforeEach(() => {
  memberRows = [{ role: "admin" }];
  memberLookupError = null;
});

describe("resolveBrainReaderContext", () => {
  it("mints role tokens from THIS workspace's member row", async () => {
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user(),
    });
    expect(ctx.origin).toBe("authenticated");
    expect(ctx.role).toBe("admin");
  });

  it("REFUSES when the member lookup fails and the session carries no role", async () => {
    // The regression this module was extracted for. `resolveEffectiveRole`
    // catches and returns `undefined`, so a guard keyed on `user.role` never
    // fires here — and the read would come back `authenticated` with no `role:`
    // tokens, quietly missing every `role:`-granted fact.
    memberLookupError = new Error("connection reset by peer");
    await expect(
      resolveBrainReaderContext(audienceDb, {
        workspaceId: WS,
        mode: "managed",
        user: user({ role: undefined }),
      }),
    ).rejects.toBeInstanceOf(BrainRoleUnresolvedError);
  });

  it("refuses on a lookup failure even when the session DOES carry a role", async () => {
    memberLookupError = new Error("statement timeout");
    await expect(
      resolveBrainReaderContext(audienceDb, {
        workspaceId: WS,
        mode: "managed",
        user: user({ role: "member" }),
      }),
    ).rejects.toBeInstanceOf(BrainRoleUnresolvedError);
  });

  it("raises a BrainReaderIdentityError, so one instanceof covers every identity failure", async () => {
    // `searchBrain` maps this base class to a `forbidden` refusal and anything
    // else to a generic "search failed". A subclass that escaped the base would
    // reach an MCP agent as `internal_error`.
    memberLookupError = new Error("boom");
    await expect(
      resolveBrainReaderContext(audienceDb, {
        workspaceId: WS,
        mode: "managed",
        user: user(),
      }),
    ).rejects.toBeInstanceOf(BrainReaderIdentityError);
  });

  it("grants nothing to a reader with NO member row, whatever their session claims", async () => {
    // The fail-open direction, closed STRUCTURALLY rather than by a guard:
    // because this module withholds the session role, `resolveEffectiveRoleStrict`
    // has nothing to fall back to and `fromMemberRow` is the only thing that can
    // produce a role at all. A session `admin` from another workspace therefore
    // cannot mint `role:admin` tokens here — there is no path that carries it.
    memberRows = [];
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "admin" }),
    });
    expect(ctx.origin).toBe("authenticated");
    expect(ctx.role).toBeNull();
  });

  it("grants a BARE platform_admin nothing — a platform role is not an org grant", async () => {
    memberRows = [];
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "platform_admin" }),
    });
    expect(ctx.role).toBeNull();
  });

  it("grants nothing when the member row's role is outside the vocabulary", async () => {
    // Drift on the role column, distinct from "no member row". The reader must
    // still lose its `role:` grants — but `resolveEffectiveRoleStrict` logs the
    // stored value, because at this layer the two are indistinguishable and a
    // reader silently missing every `role:`-granted fact needs a trail.
    memberRows = [{ role: "superuser" }];
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "admin" }),
    });
    expect(ctx.role).toBeNull();
  });

  it("refuses a platform_admin's read too when the member lookup fails", async () => {
    // Behaviour change worth pinning: a `platform_admin` used to short-circuit
    // BEFORE the lookup, so it could not fail. This module asks the member table
    // for everyone, so a blip now refuses their read as well — fail-closed, and
    // deliberate.
    memberLookupError = new Error("connection reset by peer");
    await expect(
      resolveBrainReaderContext(audienceDb, {
        workspaceId: WS,
        mode: "managed",
        user: user({ role: "platform_admin" }),
      }),
    ).rejects.toBeInstanceOf(BrainRoleUnresolvedError);
  });

  it("keeps the member role of a platform_admin who IS a member of this workspace", async () => {
    // `resolveEffectiveRoleStrict` short-circuits on a `platform_admin` session
    // role BEFORE the member lookup, which would report `fromMemberRow: false`
    // and drop a grant this reader demonstrably holds. This module sidesteps
    // that by not passing the session role at all — it asks the member table
    // the one question it actually cares about.
    memberRows = [{ role: "owner" }];
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "platform_admin" }),
    });
    expect(ctx.role).toBe("owner");
  });

  it("resolves `unauthenticated-local` in auth:none WITHOUT touching the member table", async () => {
    // The role is discarded in that mode anyway, so running the lookup could
    // only turn a DB blip into an avoidable refused read.
    memberLookupError = new Error("should never be reached");
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "none",
      user: user({ role: "admin" }),
    });
    expect(ctx.origin).toBe("unauthenticated-local");
    expect(ctx.role).toBeNull();
  });

  it("resolves `unresolved` for an authenticated request carrying no user", async () => {
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: undefined,
    });
    expect(ctx.origin).toBe("unresolved");
  });
});
