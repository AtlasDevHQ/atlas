/**
 * Tests for the proactive identity-brand chokepoints (#2641).
 *
 * Pins:
 *  - Each `assert*Id` returns the input string when non-empty (the
 *    brand is purely nominal — runtime value passes through unchanged).
 *  - Each helper throws `InvalidProactiveIdentityError` on empty input
 *    AND on non-string input. Empty is the silent-failure mode that
 *    routed every asker to a "global" tenant pre-#2641; failing fast at
 *    the boundary is the contract.
 *  - The thrown error carries the field name so a host's catch can
 *    distinguish workspace-id misconfig from user-id misconfig in logs.
 *  - Type-level: the returned brand is NOT assignable across brands —
 *    a `WorkspaceId` can't be passed where an `AtlasUserId` is expected.
 *    Asserted via `// @ts-expect-error` lines so a regression on the
 *    brand `__brand` tag would fail the type-check step in `/ci`.
 */

import { describe, expect, it } from "bun:test";
import type {
  AtlasUserId,
  ExternalUserId,
  WorkspaceId,
} from "@useatlas/types/proactive";
import {
  InvalidProactiveIdentityError,
  assertAtlasUserId,
  assertExternalUserId,
  assertWorkspaceId,
} from "../identity";

describe("assertWorkspaceId", () => {
  it("promotes a non-empty string into a WorkspaceId at runtime (passthrough)", () => {
    const id = assertWorkspaceId("org-abc-123");
    expect(id).toBe("org-abc-123" as WorkspaceId);
  });

  it("throws InvalidProactiveIdentityError on the empty string", () => {
    expect(() => assertWorkspaceId("")).toThrow(InvalidProactiveIdentityError);
  });

  it("throws and tags the field name on empty so host catches can distinguish", () => {
    try {
      assertWorkspaceId("");
      throw new Error("unreachable — assertWorkspaceId(\"\") should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProactiveIdentityError);
      expect((err as InvalidProactiveIdentityError).field).toBe("WorkspaceId");
    }
  });

  it("throws on a non-string runtime value (defensive against JS callers)", () => {
    // The TS signature rejects this, but plain-JS hosts can still call
    // with `null` / `undefined` / a number. The helper must reject
    // before casting — silently branding `undefined as WorkspaceId`
    // would re-introduce the silent-global-tenant footgun.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertWorkspaceId(undefined as unknown as string),
    ).toThrow(InvalidProactiveIdentityError);
  });
});

describe("assertAtlasUserId", () => {
  it("promotes a non-empty string into an AtlasUserId at runtime (passthrough)", () => {
    const id = assertAtlasUserId("user-abc");
    expect(id).toBe("user-abc" as AtlasUserId);
  });

  it("throws on empty with the AtlasUserId field tag", () => {
    try {
      assertAtlasUserId("");
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProactiveIdentityError);
      expect((err as InvalidProactiveIdentityError).field).toBe("AtlasUserId");
    }
  });
});

describe("assertExternalUserId", () => {
  it("promotes a non-empty string into an ExternalUserId at runtime (passthrough)", () => {
    const id = assertExternalUserId("U999");
    expect(id).toBe("U999" as ExternalUserId);
  });

  it("throws on empty with the ExternalUserId field tag", () => {
    try {
      assertExternalUserId("");
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProactiveIdentityError);
      expect((err as InvalidProactiveIdentityError).field).toBe(
        "ExternalUserId",
      );
    }
  });
});

describe("brand types are not assignable across brands (type-level)", () => {
  it("forbids passing a WorkspaceId where an AtlasUserId is expected", () => {
    const ws = assertWorkspaceId("org-1");
    function takesAtlasUserId(_id: AtlasUserId): void {}
    // @ts-expect-error — WorkspaceId is not assignable to AtlasUserId
    takesAtlasUserId(ws);
    // Runtime sanity (the underlying string still passes through).
    expect(ws).toBe("org-1" as WorkspaceId);
  });

  it("forbids passing an ExternalUserId where a WorkspaceId is expected", () => {
    const ext = assertExternalUserId("U999");
    function takesWorkspaceId(_id: WorkspaceId): void {}
    // @ts-expect-error — ExternalUserId is not assignable to WorkspaceId
    takesWorkspaceId(ext);
    expect(ext).toBe("U999" as ExternalUserId);
  });

  it("forbids passing a bare string where a brand is expected", () => {
    function takesWorkspaceId(_id: WorkspaceId): void {}
    // @ts-expect-error — bare string is not assignable to WorkspaceId
    takesWorkspaceId("not-branded");
  });
});
