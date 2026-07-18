import { describe, expect, spyOn, test } from "bun:test";
import {
  isAuthWallReason,
  mapSharedDashboardResponse,
  resolveAuthReason,
  type FailReason,
} from "../share-result";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// #4718 — `isAuthWallReason` is the gate that decides which SSR failures hand
// off to the client resolver. Pin it exhaustively: widening it would turn
// public-share failures (e.g. server-error) into silent client re-fetches;
// narrowing it would dead-end SaaS org viewers on the SSR false negative —
// the exact bug #4718 fixes.
describe("isAuthWallReason (#4718)", () => {
  const expected: Record<FailReason, boolean> = {
    "login-required": true,
    "membership-required": true,
    "not-found": false,
    expired: false,
    "server-error": false,
    "network-error": false,
  };

  for (const [reason, isWall] of Object.entries(expected) as [FailReason, boolean][]) {
    test(`${reason} → ${isWall}`, () => {
      expect(isAuthWallReason(reason)).toBe(isWall);
    });
  }
});

// #4690 — direct pins of the auth-reason split (also exercised end-to-end via
// fetch.test.ts and org-share-client.test.ts through the shared mapper).
describe("resolveAuthReason (#4690)", () => {
  test("401 is login-required regardless of body", async () => {
    expect(await resolveAuthReason(response(401, { error: "forbidden" }))).toBe("login-required");
  });

  test("403 with error:forbidden is membership-required", async () => {
    expect(await resolveAuthReason(response(403, { error: "forbidden" }))).toBe(
      "membership-required",
    );
  });

  test("403 with error:auth_required — or any unrecognized body — is login-required", async () => {
    expect(await resolveAuthReason(response(403, { error: "auth_required" }))).toBe(
      "login-required",
    );
    expect(await resolveAuthReason(response(403, { unexpected: true }))).toBe("login-required");
  });
});

describe("mapSharedDashboardResponse totality (#4718)", () => {
  test("a 200 whose body isn't JSON maps to server-error — never a rejection", async () => {
    // The mapper is documented TOTAL: `OrgShareResolver`'s two-state model and
    // the #4719 adopter rely on it never rejecting for any Response shape.
    const res = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await expect(mapSharedDashboardResponse(res, "deadbeefdeadbeef")).resolves.toEqual({
      ok: false,
      reason: "server-error",
    });
    errSpy.mockRestore();
  });

  test("schema-shape failures log issue paths, never response values", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await mapSharedDashboardResponse(
      response(200, { title: 42, secretValue: "do-not-log" }),
      "deadbeefdeadbeef",
    );

    expect(result).toEqual({ ok: false, reason: "server-error" });
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join(" ");
    expect(logged).toContain("title");
    expect(logged).not.toContain("do-not-log");
    errSpy.mockRestore();
  });
});
