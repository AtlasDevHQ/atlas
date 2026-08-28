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
 * NOTE: until issue 5194's step 4 lands, `packages/api/src/lib/auth/
 * permissions.ts` carries the copy of this tuple the monorepo actually
 * consumes, and the two must stay identical. That equality cannot be asserted
 * from here (`@useatlas/types` must not depend on `@atlas/api`); step 4
 * replaces the api copy with a re-export, which retires the risk.
 */

import { describe, test, expect } from "bun:test";
import { PERMISSIONS, isValidPermission } from "../auth";

describe("isValidPermission — accepts exactly the known flags", () => {
  for (const flag of PERMISSIONS) {
    test(`accepts "${flag}"`, () => {
      expect(isValidPermission(flag)).toBe(true);
    });
  }
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
