/**
 * Unit coverage for brain reader-identity resolution (#4773).
 *
 * This module exists to catch two failures that are invisible from every
 * surface that would suffer them, so the tests are all negatives:
 *
 *   - a member-table FAILURE must refuse the read, not silently strip the
 *     reader's `role:` tokens. The trap is that the obvious guard ("did the
 *     session carry a role we then failed to re-resolve?") does not work:
 *     post-#2890 a plain member's `AtlasUser.role` is frequently ABSENT, and a
 *     session-time lookup failure is exactly what erases it. The first test
 *     below is the one that fails against that guard.
 *   - a role that did NOT come from this workspace's member row must not be
 *     forwarded as if it had. That direction is fail-OPEN — it would mint
 *     `role:` ACL tokens in a workspace the reader is not a member of.
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

  it("DROPS a role that did not come from this workspace's member row", async () => {
    // Fail-open direction. With no member row, `resolveEffectiveRole` returns
    // the session role verbatim; stamping it `orgId: workspaceId` would tell
    // `resolvePrincipalContext` it was resolved here and mint `role:admin`
    // tokens for a workspace this reader is not a member of.
    memberRows = [];
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "admin" }),
    });
    expect(ctx.origin).toBe("authenticated");
    expect(ctx.role).toBeNull();
  });

  it("drops a bare platform_admin — a platform role is not an org grant", async () => {
    const ctx = await resolveBrainReaderContext(audienceDb, {
      workspaceId: WS,
      mode: "managed",
      user: user({ role: "platform_admin" }),
    });
    expect(ctx.role).toBeNull();
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
