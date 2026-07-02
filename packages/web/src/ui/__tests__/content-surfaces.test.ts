/**
 * Unit tests for the shared content-surface fold — the activity aggregation
 * (freshest `lastEditedAt` across a surface's folded wire keys) and the
 * ordered non-zero segment output the pill popover consumes.
 */

import { describe, expect, test } from "bun:test";
import type { ModeDraftCounts, ModeDraftActivity } from "@useatlas/types/mode";
import { draftSurfaceSegments } from "../lib/content-surfaces";

function counts(over: Partial<ModeDraftCounts> = {}): ModeDraftCounts {
  return {
    connections: 0,
    entities: 0,
    entityEdits: 0,
    entityDeletes: 0,
    prompts: 0,
    starterPrompts: 0,
    knowledgeDocuments: 0,
    ...over,
  };
}

function activity(over: Partial<Record<keyof ModeDraftCounts, string | null>>): ModeDraftActivity {
  const at = (k: keyof ModeDraftCounts) => ({ lastEditedAt: over[k] ?? null });
  return {
    connections: at("connections"),
    entities: at("entities"),
    entityEdits: at("entityEdits"),
    entityDeletes: at("entityDeletes"),
    prompts: at("prompts"),
    starterPrompts: at("starterPrompts"),
    knowledgeDocuments: at("knowledgeDocuments"),
  };
}

describe("draftSurfaceSegments activity fold", () => {
  test("the entities surface folds three slices and keeps the FRESHEST lastEditedAt", () => {
    const segments = draftSurfaceSegments(
      counts({ entities: 1, entityEdits: 2, entityDeletes: 1 }),
      activity({
        entities: "2026-07-01T00:00:00.000Z",
        entityEdits: "2026-07-02T12:00:00.000Z", // freshest
        entityDeletes: "2026-06-30T00:00:00.000Z",
      }),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      key: "entities",
      count: 4,
      label: "Semantic entities",
      lastEditedAt: "2026-07-02T12:00:00.000Z",
    });
  });

  test("segments come out in publish-chain order, zero surfaces skipped, null activity tolerated", () => {
    const segments = draftSurfaceSegments(
      counts({ knowledgeDocuments: 3, connections: 1 }),
      null,
    );
    expect(segments.map((s) => s.key)).toEqual(["connections", "knowledgeDocuments"]);
    expect(segments.map((s) => s.chipLabel)).toEqual(["1 connection", "3 knowledge documents"]);
    expect(segments.every((s) => s.lastEditedAt === null)).toBe(true);
  });

  test("unparseable timestamps are ignored by the freshest-pick", () => {
    const segments = draftSurfaceSegments(
      counts({ prompts: 1 }),
      activity({ prompts: "not-a-date" }),
    );
    expect(segments[0]?.lastEditedAt).toBeNull();
  });
});
