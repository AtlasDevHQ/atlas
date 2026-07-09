/**
 * Fail-closed coverage for {@link isDisposableEmail} (#3803 milestone review).
 *
 * The real `validateEmail` (mailchecker corpus) never throws on a string, so
 * the fail-closed catch in `isDisposableEmail` is unreachable with the genuine
 * dependency. We stub `better-auth-harmony/email` so `validateEmail` THROWS,
 * proving the abuse-control denies (returns `true`) rather than letting an
 * unclassified throw escape `assertBusinessEmail` as an opaque 500.
 *
 * Lives in its own file: the module-level `mock.module` below would otherwise
 * poison the corpus-based assertions in `business-email.test.ts`. The isolated
 * per-file runner keeps the stub scoped to this process.
 */

import { describe, it, expect, mock } from "bun:test";

// Mock ALL runtime exports of `better-auth-harmony/email` (CLAUDE.md rule):
// `validateEmail` (the throwing stub under test) + `default` (the
// `emailHarmony` plugin factory). The type-only exports are erased at runtime.
void mock.module("better-auth-harmony/email", () => ({
  default: () => ({}),
  validateEmail: () => {
    throw new Error("validator boom");
  },
}));

const { isDisposableEmail } = await import("../business-email");

describe("isDisposableEmail — fail closed", () => {
  it("denies (returns true) when validateEmail throws", () => {
    // A throwing validator must be treated as disposable/deny, never admitted.
    expect(isDisposableEmail("attacker@some-domain.example")).toBe(true);
  });

  it("still short-circuits empty input before reaching the validator", () => {
    // The empty guard returns false BEFORE calling validateEmail, so a throwing
    // validator can't flip empty into a deny (Better Auth owns required-field).
    expect(isDisposableEmail("")).toBe(false);
  });
});
