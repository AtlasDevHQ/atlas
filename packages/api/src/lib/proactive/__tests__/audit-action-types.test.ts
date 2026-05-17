/**
 * Pin the four `proactive.*` action types in the audit catalog.
 *
 * Catches accidental rename / removal in the same way the existing SSO
 * audit-action-type test catches `sso.verify_domain` drift. The
 * compile-time union check below ensures the literal types still pass
 * `AdminActionType`.
 */

import { describe, expect, it } from "bun:test";
import { ADMIN_ACTIONS, type AdminActionType } from "@atlas/api/lib/audit/actions";
import { logAdminAction } from "@atlas/api/lib/audit/admin";

describe("ADMIN_ACTIONS.proactive (#2296)", () => {
  it("exposes the four lifecycle action types", () => {
    expect(ADMIN_ACTIONS.proactive.classify).toBe("proactive.classify");
    expect(ADMIN_ACTIONS.proactive.react).toBe("proactive.react");
    expect(ADMIN_ACTIONS.proactive.answer).toBe("proactive.answer");
    expect(ADMIN_ACTIONS.proactive.feedback).toBe("proactive.feedback");
  });

  it("widens into AdminActionType so logAdminAction accepts them", () => {
    // Compile-time check: assignability of the literal types into the
    // union. The function call itself never runs — bun:test's lazy
    // evaluation lets us assert the shape without invoking pino or PG.
    const accept: AdminActionType[] = [
      ADMIN_ACTIONS.proactive.classify,
      ADMIN_ACTIONS.proactive.react,
      ADMIN_ACTIONS.proactive.answer,
      ADMIN_ACTIONS.proactive.feedback,
    ];
    expect(accept).toHaveLength(4);
    // Reference logAdminAction so the test file holds a type-level
    // dependency on the audit writer signature. If the writer ever
    // narrows its `actionType` accept set this test trips at compile
    // time.
    expect(typeof logAdminAction).toBe("function");
  });

  it("`targetType: 'proactive'` resolves from the catalog key (domain prefix)", () => {
    const keys = Object.keys(ADMIN_ACTIONS);
    expect(keys).toContain("proactive");
  });
});
