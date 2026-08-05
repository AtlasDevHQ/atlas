import { describe, expect, test } from "bun:test";
import {
  buildBrainFactsPath,
  hasBrainFactFilters,
  type BrainFactsFilters,
} from "../list-query";

const DEFAULTS: BrainFactsFilters = {
  status: "draft",
  provisional: false,
  tension: false,
  q: "",
};

function query(path: string): URLSearchParams {
  return new URL(path, "http://x").searchParams;
}

describe("buildBrainFactsPath", () => {
  test("always carries limit + offset from the binding", () => {
    const qs = query(buildBrainFactsPath({ offset: 100, perPage: 50 }, DEFAULTS));
    expect(qs.get("limit")).toBe("50");
    expect(qs.get("offset")).toBe("100");
  });

  test("omits the narrowing filters when they are off", () => {
    const qs = query(buildBrainFactsPath({ offset: 0, perPage: 50 }, DEFAULTS));
    expect(qs.has("provisional")).toBe(false);
    expect(qs.has("tension")).toBe(false);
    expect(qs.has("q")).toBe(false);
  });

  test("sends the status even at its default, so the URL is unambiguous", () => {
    // A shared link must resolve to the same queue no matter what the route's
    // default happens to be at the time it is opened.
    expect(query(buildBrainFactsPath({ offset: 0, perPage: 50 }, DEFAULTS)).get("status")).toBe(
      "draft",
    );
  });

  test("threads the quality-queue filters", () => {
    const qs = query(
      buildBrainFactsPath(
        { offset: 0, perPage: 50 },
        { status: "all", provisional: true, tension: true, q: "Acme" },
      ),
    );
    expect(qs.get("status")).toBe("all");
    expect(qs.get("provisional")).toBe("true");
    expect(qs.get("tension")).toBe("true");
    expect(qs.get("q")).toBe("Acme");
  });

  test("drops a whitespace-only search rather than sending it", () => {
    expect(query(buildBrainFactsPath({ offset: 0, perPage: 50 }, { ...DEFAULTS, q: "   " })).has("q")).toBe(
      false,
    );
  });

  test("never emits a sort — ordering by conflict would be an arbitration", () => {
    const qs = query(buildBrainFactsPath({ offset: 0, perPage: 50 }, DEFAULTS));
    expect(qs.has("sort")).toBe(false);
    expect(qs.has("dir")).toBe(false);
  });
});

describe("hasBrainFactFilters", () => {
  test("the bare draft queue is not a filtered view", () => {
    // Offering "Clear" on the landing state would suggest the reviewer had
    // applied something they hadn't.
    expect(hasBrainFactFilters(DEFAULTS)).toBe(false);
  });

  test("each narrowing knob counts", () => {
    expect(hasBrainFactFilters({ ...DEFAULTS, status: "published" })).toBe(true);
    expect(hasBrainFactFilters({ ...DEFAULTS, provisional: true })).toBe(true);
    expect(hasBrainFactFilters({ ...DEFAULTS, tension: true })).toBe(true);
    expect(hasBrainFactFilters({ ...DEFAULTS, q: "Acme" })).toBe(true);
  });

  test("a whitespace-only search is not a filter", () => {
    expect(hasBrainFactFilters({ ...DEFAULTS, q: "  " })).toBe(false);
  });
});
