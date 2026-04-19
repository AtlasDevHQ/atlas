import { describe, expect, test } from "bun:test";
import { isDemotion } from "../roles";

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
