import { describe, expect, test } from "bun:test";
import { friendlyError, type FetchError } from "../hooks/use-admin-fetch";

describe("friendlyError", () => {
  test("returns auth message for 401", () => {
    const err: FetchError = { message: "HTTP 401", status: 401 };
    expect(friendlyError(err)).toContain("Not authenticated");
  });

  test("returns access denied for 403", () => {
    const err: FetchError = { message: "HTTP 403", status: 403 };
    expect(friendlyError(err)).toContain("Access denied");
    expect(friendlyError(err)).toContain("Admin role");
  });

  test("returns feature not enabled for 404", () => {
    const err: FetchError = { message: "HTTP 404", status: 404 };
    expect(friendlyError(err)).toContain("not enabled");
  });

  test("returns raw message for other errors", () => {
    const err: FetchError = { message: "Connection refused" };
    expect(friendlyError(err)).toBe("Connection refused");
  });

  test("returns raw message for 500", () => {
    const err: FetchError = { message: "Internal Server Error", status: 500 };
    expect(friendlyError(err)).toBe("Internal Server Error");
  });
});
