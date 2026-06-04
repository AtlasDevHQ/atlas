/**
 * #3164 — Better Auth's native org member-mutation endpoints
 * (`POST /organization/update-member-role`, `POST /organization/remove-member`)
 * are reachable through the managed-auth catch-all and would bypass the
 * per-workspace last-admin advisory lock (#3158) that the custom admin routes
 * take. The chosen fix is to BLOCK them via the org-plugin `before*` hooks (see
 * `org-member-guards.ts` for why coordinating under the lock is unsound).
 *
 * The race-safety guarantee is therefore: the native mutation NEVER executes —
 * the hook throws before Better Auth touches the `member` table — so it cannot
 * race a locked demotion at all. These tests assert that block contract.
 */

import { describe, it, expect } from "bun:test";
import { APIError } from "better-auth/api";
import {
  blockNativeMemberRoleUpdate,
  blockNativeMemberRemoval,
  ATLAS_USE_ADMIN_API_CODE,
} from "@atlas/api/lib/auth/org-member-guards";

/**
 * Resolve to the value the guard THREW so the test can assert on the APIError
 * shape. Uses `.then(onFulfilled, onRejected)` rather than try/catch so there's
 * no swallowed-error branch — and it fails loudly if the guard unexpectedly
 * resolves instead of throwing (the whole point of these hooks is that they
 * never fall through).
 */
function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error("expected the guard to throw an APIError, but it resolved");
    },
    (err: unknown) => err,
  );
}

describe("#3164 — native org member-mutation hooks block the unguarded path", () => {
  it("beforeUpdateMemberRole hook refuses with 403 + points at the guarded role route", async () => {
    const err = await captureThrow(blockNativeMemberRoleUpdate);
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as APIError;
    expect(apiErr.status).toBe("FORBIDDEN");
    expect(apiErr.statusCode).toBe(403);
    expect(apiErr.body?.code).toBe(ATLAS_USE_ADMIN_API_CODE);
    expect(apiErr.body?.message).toContain("PATCH /api/v1/admin/users/{id}/role");
  });

  it("beforeRemoveMember hook refuses with 403 + points at the guarded membership route", async () => {
    const err = await captureThrow(blockNativeMemberRemoval);
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as APIError;
    expect(apiErr.status).toBe("FORBIDDEN");
    expect(apiErr.statusCode).toBe(403);
    expect(apiErr.body?.code).toBe(ATLAS_USE_ADMIN_API_CODE);
    expect(apiErr.body?.message).toContain("DELETE /api/v1/admin/users/{id}/membership");
  });

  it("both hooks always throw — they never fall through to a native mutation", async () => {
    // The whole point of the block: there is no input that lets the native path
    // proceed. The hooks take no arguments and unconditionally reject.
    await expect(blockNativeMemberRoleUpdate()).rejects.toBeInstanceOf(APIError);
    await expect(blockNativeMemberRemoval()).rejects.toBeInstanceOf(APIError);
  });
});
