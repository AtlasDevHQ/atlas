import { describe, expect, test } from "bun:test";
import { canSupersede, correctionBody } from "../claim-correction";

/**
 * The verb split behind the review queue's correction dialog (#5426).
 *
 * Unit-level for `tension-state.test.ts`'s reason: this is a domain predicate,
 * and pinning its boundary cases should not require mounting the queue page.
 * `review-honesty.test.tsx` proves the SURFACE renders what this decided.
 *
 * The cases that matter are the ones where the obvious implementation is
 * wrong — a FUTURE `validTo` refusing, and a date-only input never reaching
 * the wire unconverted.
 */

const OPEN = { status: "published", validTo: null } as const;

describe("canSupersede", () => {
  test("a published claim with an open window is the one row state that admits both verbs", () => {
    expect(canSupersede(OPEN)).toBe(true);
  });

  test("a draft does not admit it — a candidate under review was never true", () => {
    // `TARGET_NOT_PUBLISHED` in `lib/brain/correction.ts`. This is the DEFAULT
    // chip, so getting it wrong would put a dead option in front of every
    // reviewer on every row they normally see.
    expect(canSupersede({ status: "draft", validTo: null })).toBe(false);
  });

  test("an archived claim does not admit it", () => {
    expect(canSupersede({ status: "archived", validTo: null })).toBe(false);
  });

  test("a window that has already closed does not admit it", () => {
    expect(canSupersede({ status: "published", validTo: "2026-07-01T00:00:00.000Z" })).toBe(false);
  });

  test("a window closing in the FUTURE does not admit it either", () => {
    // The non-obvious arm, and the reason this predicate is not "is the window
    // open right now". `supersede` refuses ANY decided end date, a future one
    // included, because a second arbitration of the same claim is the thing it
    // must not permit (`VALIDITY_ALREADY_CLOSED`). An implementation comparing
    // `validTo` against the clock would offer the verb here and take a 409.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(canSupersede({ status: "published", validTo: future })).toBe(false);
  });
});

describe("correctionBody", () => {
  test("`never-true` becomes the retract verb and carries no replacement", () => {
    const result = correctionBody({ kind: "never-true" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.verb).toBe("retract");
    expect(result.body.replacement).toBeUndefined();
  });

  test("`changed` becomes the supersede verb carrying the corrected object", () => {
    const result = correctionBody({ kind: "changed", object: "8M", since: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.verb).toBe("supersede");
    expect(result.body.replacement?.object).toBe("8M");
  });

  test("a corrected object is trimmed before it reaches the wire", () => {
    const result = correctionBody({ kind: "changed", object: "  8M  ", since: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.replacement?.object).toBe("8M");
  });

  test("an object that is only whitespace is refused with prose, not sent", () => {
    // `z.string().min(1)` on the API would 400 on this. Refusing here means the
    // human is told what is wrong with their text instead of reading a wire
    // error, and matches the repo's prefer-errors-over-silent-fallbacks rule.
    const result = correctionBody({ kind: "changed", object: "   ", since: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("new value");
  });

  test("omitting `since` omits `validFrom`, so the API stamps the correction time", () => {
    const result = correctionBody({ kind: "changed", object: "8M", since: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.replacement).not.toHaveProperty("validFrom");
  });

  test("a date-only `since` is widened to an ISO-8601 instant the API accepts", () => {
    // The input is `<input type="date">`, which yields `YYYY-MM-DD`;
    // `BrainFactCorrectRequestSchema` requires `z.string().datetime({offset:true})`.
    // Sending the raw value is a 400, and the human's stated temporal boundary
    // is exactly what must not be discarded quietly.
    const result = correctionBody({
      kind: "changed",
      object: "8M",
      since: "2026-08-01",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.replacement?.validFrom).toBe("2026-08-01T00:00:00.000Z");
  });

  test("a malformed `since` is refused with prose rather than widened into a wrong instant", () => {
    const result = correctionBody({
      kind: "changed",
      object: "8M",
      since: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("date");
  });
});
