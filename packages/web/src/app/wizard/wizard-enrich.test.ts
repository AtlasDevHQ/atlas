import { describe, expect, it } from "bun:test";
import type { WizardEntityResult } from "@/ui/lib/types";
import {
  seedIgnoredTables,
  enrichableTables,
  excludeIgnored,
  runWithConcurrency,
} from "./wizard-enrich";

function entity(tableName: string, opts: { abandoned?: boolean } = {}): WizardEntityResult {
  return {
    tableName,
    objectType: "table",
    rowCount: 100,
    columnCount: 3,
    yaml: `table: ${tableName}\n`,
    profile: {
      columns: [],
      primaryKeys: [],
      foreignKeys: [],
      inferredForeignKeys: [],
      flags: { possiblyAbandoned: opts.abandoned ?? false, possiblyDenormalized: false },
      notes: [],
    },
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("wizard-enrich", () => {
  describe("seedIgnoredTables (ignore pre-fill)", () => {
    it("pre-ignores exactly the possibly-abandoned tables", () => {
      const entities = [
        entity("orders"),
        entity("legacy_audit", { abandoned: true }),
        entity("cache_sessions", { abandoned: true }),
      ];
      expect(seedIgnoredTables(entities).sort()).toEqual(["cache_sessions", "legacy_audit"]);
    });

    it("returns an empty list when nothing is flagged", () => {
      expect(seedIgnoredTables([entity("orders"), entity("users")])).toEqual([]);
    });
  });

  describe("enrichableTables (Enrich-all target == save set)", () => {
    it("is every table minus the ignored set", () => {
      const entities = [entity("a"), entity("b"), entity("c")];
      expect(enrichableTables(entities, new Set(["b"]))).toEqual(["a", "c"]);
    });

    it("is empty when every table is ignored", () => {
      const entities = [entity("a"), entity("b")];
      expect(enrichableTables(entities, new Set(["a", "b"]))).toEqual([]);
    });
  });

  describe("excludeIgnored (Enrich-selected guard)", () => {
    it("drops names that have since been ignored", () => {
      expect(excludeIgnored(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
    });

    it("returns everything when nothing is ignored", () => {
      expect(excludeIgnored(["a", "b"], new Set())).toEqual(["a", "b"]);
    });
  });

  describe("runWithConcurrency (per-table streaming + partial safety)", () => {
    it("settles every item with its result", async () => {
      const results: Array<[string, string | undefined, unknown]> = [];
      await runWithConcurrency(
        ["a", "b", "c"],
        2,
        async (x) => `R:${x}`,
        (item, result, error) => results.push([item, result, error]),
      );
      expect(results).toHaveLength(3);
      const byItem = new Map(results.map(([item, result]) => [item, result]));
      expect(byItem.get("a")).toBe("R:a");
      expect(byItem.get("b")).toBe("R:b");
      expect(byItem.get("c")).toBe("R:c");
    });

    it("surfaces a thrown task as an error outcome and still processes the rest", async () => {
      const ok: string[] = [];
      const errored: string[] = [];
      await runWithConcurrency(
        ["a", "boom", "c"],
        2,
        async (x) => {
          if (x === "boom") throw new Error("nope");
          return x;
        },
        (item, result, error) => {
          if (error) errored.push(item);
          else ok.push(item);
        },
      );
      // Partial completion is safe: one failure never blocks its siblings.
      expect(ok.sort()).toEqual(["a", "c"]);
      expect(errored).toEqual(["boom"]);
    });

    it("never exceeds the concurrency limit but does parallelize", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      await runWithConcurrency(
        ["a", "b", "c", "d", "e"],
        2,
        async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(5);
          inFlight--;
        },
        () => {},
      );
      expect(maxInFlight).toBe(2);
    });

    it("is a no-op for an empty item list", async () => {
      let calls = 0;
      await runWithConcurrency(
        [],
        4,
        async () => {
          calls++;
        },
        () => {
          calls++;
        },
      );
      expect(calls).toBe(0);
    });
  });
});
