/**
 * **Who a brain write is recorded as being BY** (#5635).
 *
 * Two resolvers, one sentinel, three outcomes each. They were one function
 * copied byte-for-byte into three route modules until #5635 needed a fourth
 * consumer; the copies had not yet disagreed, and this file is what makes a
 * future disagreement fail rather than ship.
 *
 * The arms matter individually because each maps a DIFFERENT unknown onto a
 * different answer, and two of them look interchangeable and are not:
 * `local-operator` asserts "a human did this on a deployment with no accounts",
 * while `null` asserts "this request cannot name anyone". Returning the
 * sentinel where null belongs would file one workspace's decision under
 * another's operator — the specific bug the switch shape exists to prevent.
 */

import { describe, expect, it } from "bun:test";

import {
  LOCAL_OPERATOR,
  recordedAdminAuthor,
  recordedAuthor,
} from "@atlas/api/lib/brain/recorded-author";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { AuthResult } from "@atlas/api/lib/auth/types";

/** Only the three fields the resolver reads; the rest of the context is irrelevant to it. */
function ctx(partial: Partial<BrainPrincipalContext>): BrainPrincipalContext {
  return { workspaceId: "ws-1", ...partial } as BrainPrincipalContext;
}

describe("recordedAuthor — from a brain principal context", () => {
  it("names an owner and an admin by their user id", () => {
    expect(recordedAuthor(ctx({ origin: "authenticated", role: "owner", userId: "u-1" }))).toBe("u-1");
    expect(recordedAuthor(ctx({ origin: "authenticated", role: "admin", userId: "u-2" }))).toBe("u-2");
  });

  it("records NULL for a member, rather than naming them", () => {
    // Belt-and-braces behind the route's own authorization. Naming a member
    // would file the decision under someone who was not entitled to make it,
    // which is worse than not naming anyone.
    expect(recordedAuthor(ctx({ origin: "authenticated", role: "member", userId: "u-3" }))).toBeNull();
  });

  // No case for "authenticated with no user id": `BrainPrincipalContext`'s
  // authenticated arm declares `userId: string`, so that state is
  // unrepresentable and a test would have to cast past the type to assert it.
  // The `&& ctx.userId` guard in the resolver is defensive against a shape the
  // type forbids; it is preserved from the three copies this replaced rather
  // than tightened, because loosening or removing a security-relevant guard is
  // not a refactor.

  it("records the sentinel on a no-auth deployment", () => {
    expect(recordedAuthor(ctx({ origin: "unauthenticated-local" }))).toBe(LOCAL_OPERATOR);
  });

  it("records NULL — never the sentinel — for an unresolved principal", () => {
    // ⚠️ The arm this shape exists for. Collapsing it into the sentinel would
    // apply "a human on this deployment" to every origin whose userId happens
    // to be null.
    const resolved = recordedAuthor(ctx({ origin: "unresolved" }));
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(LOCAL_OPERATOR);
  });
});

describe("recordedAdminAuthor — from an AuthResult", () => {
  it("names the authenticated user by id", () => {
    const auth = {
      authenticated: true,
      mode: "managed",
      user: { id: "u-9" },
    } as unknown as AuthResult;
    expect(recordedAdminAuthor(auth)).toBe("u-9");
  });

  it("records the sentinel when auth is not configured", () => {
    // The `mode: "none"` arm of the union carries `user: undefined` by
    // construction, and a human is still the one publishing.
    const auth = { authenticated: true, mode: "none", user: undefined } as AuthResult;
    expect(recordedAdminAuthor(auth)).toBe(LOCAL_OPERATOR);
  });

  it("records NULL when the request is not authenticated", () => {
    // Unreachable behind `requireAdminAuth`, mapped anyway: "unreachable
    // today" is not a property a type should rely on a caller to preserve.
    const auth = {
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "no session",
    } as AuthResult;
    expect(recordedAdminAuthor(auth)).toBeNull();
  });

  it("agrees with recordedAuthor on the sentinel's spelling", () => {
    // One literal, two resolvers, three storage columns. A second spelling
    // would read as a different actor everywhere the value is compared.
    expect(recordedAdminAuthor({ authenticated: true, mode: "none", user: undefined } as AuthResult)).toBe(
      recordedAuthor(ctx({ origin: "unauthenticated-local" })),
    );
  });
});
