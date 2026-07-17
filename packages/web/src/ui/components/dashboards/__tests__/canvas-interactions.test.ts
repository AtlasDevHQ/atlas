import { describe, expect, test } from "bun:test";
import {
  withRefreshing,
  withoutRefreshing,
  attachSuggestionIds,
  dropSuggestion,
  makeClientId,
  type SuggestionItem,
} from "../canvas-interactions";
import type { DashboardSuggestion } from "@/ui/lib/types";

const rawSuggestion = (title: string): DashboardSuggestion => ({
  title,
  sql: `SELECT '${title}'`,
  chartConfig: { type: "bar" } as DashboardSuggestion["chartConfig"],
  reason: `because ${title}`,
});

describe("per-tile refresh tracking (#4567 L3)", () => {
  test("two concurrent refreshes converge to a set of BOTH ids", () => {
    let set: ReadonlySet<string> = new Set();
    set = withRefreshing(set, "c1");
    set = withRefreshing(set, "c2");
    expect([...set].sort()).toEqual(["c1", "c2"]);
  });

  test("the SLOWER refresh settling first leaves the other's spinner intact", () => {
    // c1 and c2 both in flight; c1 settles first — c2 must stay refreshing.
    let set: ReadonlySet<string> = new Set(["c1", "c2"]);
    set = withoutRefreshing(set, "c1");
    expect(set.has("c1")).toBe(false);
    expect(set.has("c2")).toBe(true); // <- the bug a single `refreshingId` had
  });

  test("add is idempotent and copy-on-write (no in-place mutation)", () => {
    const start: ReadonlySet<string> = new Set(["c1"]);
    const same = withRefreshing(start, "c1");
    expect(same).toBe(start); // already present → same reference
    const grown = withRefreshing(start, "c2");
    expect(grown).not.toBe(start);
    expect(start.has("c2")).toBe(false); // original untouched
  });

  test("removing an absent id is a no-op returning the same reference", () => {
    const start: ReadonlySet<string> = new Set(["c1"]);
    expect(withoutRefreshing(start, "nope")).toBe(start);
  });
});

describe("stable-id suggestions (#4567 L4)", () => {
  test("attachSuggestionIds mints one id per suggestion", () => {
    const items = attachSuggestionIds([rawSuggestion("A"), rawSuggestion("B")]);
    expect(items).toHaveLength(2);
    expect(items[0].clientId).not.toBe(items[1].clientId);
    expect(items[0].title).toBe("A");
  });

  test("an injected id factory drives the ids (deterministic in tests)", () => {
    let n = 0;
    const items = attachSuggestionIds([rawSuggestion("A"), rawSuggestion("B")], () => `id-${n++}`);
    expect(items.map((s) => s.clientId)).toEqual(["id-0", "id-1"]);
  });

  test("dropSuggestion removes the CLICKED item by identity, never by index", () => {
    // The regression: dismiss the middle item; index-keying would drop the wrong
    // one after any prior reindex. Identity keying always hits the target.
    const items: SuggestionItem[] = attachSuggestionIds(
      [rawSuggestion("A"), rawSuggestion("B"), rawSuggestion("C")],
      (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    );
    const afterDismissB = dropSuggestion(items, "id-1");
    expect(afterDismissB.map((s) => s.title)).toEqual(["A", "C"]);
  });

  test("dismissing while another add is in flight acts on each clicked item after reindex", () => {
    // Simulate: [A,B,C]; accept A removes it (reindex → [B,C]); now the pending
    // "Adding…" was keyed on B's id — dismissing B still hits B, not the new index-1.
    let n = 0;
    const items = attachSuggestionIds(
      [rawSuggestion("A"), rawSuggestion("B"), rawSuggestion("C")],
      () => `id-${n++}`,
    );
    const [idA, idB] = [items[0].clientId, items[1].clientId];
    const afterAcceptA = dropSuggestion(items, idA); // [B, C]
    const afterDismissB = dropSuggestion(afterAcceptA, idB); // must be [C]
    expect(afterDismissB.map((s) => s.title)).toEqual(["C"]);
  });

  test("makeClientId returns distinct non-empty ids", () => {
    const a = makeClientId();
    const b = makeClientId();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test("makeClientId falls back when crypto.randomUUID is unavailable (non-secure context)", () => {
    const realCrypto = globalThis.crypto;
    try {
      // Simulate an insecure context: randomUUID absent. Suggestions must still
      // get an id rather than the whole list failing.
      Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
      const id = makeClientId();
      expect(id).toMatch(/^sug-/);
      expect(makeClientId()).not.toBe(id); // still distinct via the counter
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }
  });

  test("makeClientId falls back when crypto.randomUUID throws", () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: {
          randomUUID: () => {
            throw new Error("insecure context");
          },
        },
        configurable: true,
      });
      expect(makeClientId()).toMatch(/^sug-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }
  });
});
