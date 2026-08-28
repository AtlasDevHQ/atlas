/**
 * `PERMISSIONS` / `isValidPermission` guard tests (#5194 step 1).
 *
 * `isValidPermission` is the narrowing guard consumers use to turn an
 * untrusted string (a stored `custom_roles` row, a request body) into a
 * `Permission` without a cast. Like `isDeployRegion`, its whole job is
 * exactness: only the flags in the tuple pass, and near-misses — wrong case,
 * whitespace, a plausible-but-unknown flag — must return `false` so callers
 * fail closed instead of persisting a flag no enforcement site checks.
 *
 * These cases pin that exactness, plus two shape invariants of the tuple
 * itself (no duplicates, no accidental whitespace) that a hand-edit could
 * silently break.
 *
 * NOTE: between step 1 and step 4 of issue 5194, `packages/api/src/lib/auth/
 * permissions.ts` carried its own copy of this tuple, which had to stay
 * identical to this one — an equality that could not be asserted from here
 * (`@useatlas/types` must not depend on `@atlas/api`). Step 4 replaced the
 * api copy with a re-export from this package, which retired that risk: this
 * tuple is now the only definition.
 */

import { describe, test, expect } from "bun:test";
import { PERMISSIONS, isValidPermission, type Permission } from "../auth";

// Hand-listed, like deploy.test.ts's region list — NOT derived from
// PERMISSIONS, so removing or renaming a flag in the tuple reddens this
// suite instead of silently shrinking it. That is the point: flag ids are
// published npm contract, and a removal must be a conscious, breaking edit.
const EXPECTED_FLAGS = [
  "query",
  "query:raw_data",
  "dashboards:read",
  "dashboards:write",
  "dashboards:share",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
] as const;

describe("isValidPermission — accepts exactly the known flags", () => {
  for (const flag of EXPECTED_FLAGS) {
    test(`accepts "${flag}"`, () => {
      expect(isValidPermission(flag)).toBe(true);
    });
  }

  test("the tuple holds exactly the expected flags, in order", () => {
    expect([...PERMISSIONS]).toEqual([...EXPECTED_FLAGS]);
  });
});

describe("isValidPermission — rejects everything else (fail-closed inputs)", () => {
  test("rejects the empty string", () => {
    expect(isValidPermission("")).toBe(false);
  });

  test("rejects wrong case", () => {
    expect(isValidPermission("Admin:Users")).toBe(false);
  });

  test("rejects surrounding whitespace", () => {
    expect(isValidPermission(" query")).toBe(false);
    expect(isValidPermission("query ")).toBe(false);
  });

  test("rejects a plausible unknown flag", () => {
    expect(isValidPermission("dashboards:admin")).toBe(false);
    expect(isValidPermission("query:rawdata")).toBe(false);
  });

  test("rejects a role — roles and permissions are different vocabularies", () => {
    expect(isValidPermission("admin")).toBe(false);
    expect(isValidPermission("platform_admin")).toBe(false);
  });
});

describe("isValidPermission — narrows the type for the compiler", () => {
  // The guard's value is the static narrowing it gives call sites (a stored
  // custom_roles flag, a request body). This asserts the predicate flows:
  // inside the `true` branch, `value` is a `Permission` and is assignable to
  // one with no cast.
  test("narrows string to Permission in the true branch", () => {
    const value: string = "dashboards:share";
    if (isValidPermission(value)) {
      const narrowed: Permission = value;
      expect(narrowed).toBe("dashboards:share");
    } else {
      throw new Error("expected isValidPermission to narrow 'dashboards:share'");
    }
  });
});

describe("PERMISSIONS tuple shape", () => {
  test("has no duplicate flags", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  test("every flag is trimmed and non-empty", () => {
    for (const flag of PERMISSIONS) {
      expect(flag.trim()).toBe(flag);
      expect(flag.length).toBeGreaterThan(0);
    }
  });
});
