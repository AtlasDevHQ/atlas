import { describe, expect, test } from "bun:test";
import { isDemotion, removeEndpointForRole } from "../roles";

describe("isDemotion", () => {
  test("promotions are not demotions", () => {
    expect(isDemotion("member", "admin")).toBe(false);
    expect(isDemotion("member", "owner")).toBe(false);
    expect(isDemotion("admin", "owner")).toBe(false);
  });

  test("strict rank drops are demotions", () => {
    expect(isDemotion("owner", "admin")).toBe(true);
    expect(isDemotion("owner", "member")).toBe(true);
    expect(isDemotion("admin", "member")).toBe(true);
  });

  test("unknown `from` role fails closed — always a demotion", () => {
    // If the server returns a role Atlas doesn't know about (legacy "guest",
    // future "billing-admin", DB drift, a platform-only role leaking into
    // the workspace API), we route every change through the confirm
    // AlertDialog. Silently bucketing unknown as `member` would let an
    // operator strip privileges with a single click — exactly the class
    // of accidental-demote the dialog exists to prevent.
    expect(isDemotion("guest", "member")).toBe(true);
    expect(isDemotion("platform_admin", "admin")).toBe(true);
    expect(isDemotion("", "owner")).toBe(true);
  });
});

// Security invariant for F-14: the UI must route workspace admins to
// DELETE /membership and platform admins to POST /ban. If a refactor
// inverts the branch or routes workspace admins to /ban, the server-side
// 403 is the only line of defence — these tests pin the UI contract.

describe("removeEndpointForRole (F-14)", () => {
  test("workspace admin → DELETE /membership with workspace-removal label", () => {
    const endpoint = removeEndpointForRole(false);
    expect(endpoint.method).toBe("DELETE");
    expect(endpoint.path("u-123")).toBe("/api/v1/admin/users/u-123/membership");
    expect(endpoint.label).toBe("Remove from workspace");
  });

  test("platform admin → POST /ban with global-ban label", () => {
    const endpoint = removeEndpointForRole(true);
    expect(endpoint.method).toBe("POST");
    expect(endpoint.path("u-456")).toBe("/api/v1/admin/users/u-456/ban");
    expect(endpoint.label).toBe("Ban user");
  });

  test("path templating escapes the userId position correctly", () => {
    // Guard against accidental interpolation drift if the helper ever
    // switches to a builder that mutates the userId. Simple string id
    // must map 1:1 into the URL.
    expect(removeEndpointForRole(false).path("abc-123")).toContain("/abc-123/");
    expect(removeEndpointForRole(true).path("abc-123")).toContain("/abc-123/");
  });
});
