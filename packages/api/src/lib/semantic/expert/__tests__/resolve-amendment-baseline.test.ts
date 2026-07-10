/**
 * Unit tests for `resolveAmendmentBaseline` (#4488) — the single org/group-aware
 * read both the diff preview and the apply write go through. Covers the branches
 * the acceptance criteria name: scoped hit, scoped-miss → unscoped fallback,
 * not-found throw, malformed-YAML throw, and AmbiguousEntityError propagation.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

class AmbiguousEntityError extends Error {
  readonly groups: (string | null)[];
  constructor(opts: { message: string; groups: (string | null)[] }) {
    super(opts.message);
    this.name = "AmbiguousEntityError";
    this.groups = opts.groups;
  }
}

type Row = { id: string; connection_group_id: string | null; yaml_content: string };

// Explicit param signatures so `.mock.calls[n][i]` is well-typed.
const getEntity = mock(
  async (
    _org: string,
    _type: string,
    _name: string,
    _group?: string | null,
  ): Promise<Row | null> => null,
);

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  getEntity,
  AmbiguousEntityError,
}));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { resolveAmendmentBaseline } = await import(`../apply.ts?t=${Date.now()}`);

describe("resolveAmendmentBaseline (#4488)", () => {
  beforeEach(() => {
    getEntity.mockReset();
  });

  it("scoped hit: reads the group-scoped row and returns its own group + parsed YAML", async () => {
    getEntity.mockResolvedValue({
      id: "orders-eu",
      connection_group_id: "eu_prod",
      yaml_content: "name: orders\ndescription: Orders\n",
    });

    const result = await resolveAmendmentBaseline("org-1", "orders", "eu_prod");

    // One scoped read — no unscoped fallback needed.
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "entity", "orders", "eu_prod"]);
    expect(result.targetGroupId).toBe("eu_prod");
    expect(result.parsed).toMatchObject({ name: "orders", description: "Orders" });
  });

  it("scoped miss → unscoped fallback resolves, targetGroupId is the resolved row's OWN group", async () => {
    // First (scoped) read misses; the unscoped fallback resolves the unique row.
    getEntity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "orders-eu",
        connection_group_id: "eu_prod",
        yaml_content: "name: orders\n",
      });

    const result = await resolveAmendmentBaseline("org-1", "orders", "stale_group");

    expect(getEntity).toHaveBeenCalledTimes(2);
    expect(getEntity.mock.calls[0][3]).toBe("stale_group"); // scoped attempt
    expect(getEntity.mock.calls[1][3]).toBeUndefined(); // unscoped fallback
    // Write scope is the row's OWN group, never the stale requested label.
    expect(result.targetGroupId).toBe("eu_prod");
  });

  it("throws when the entity is absent (and names self-hosted global scope for a null org)", async () => {
    getEntity.mockResolvedValue(null);
    await expect(resolveAmendmentBaseline(null, "ghost", "default")).rejects.toThrow(
      /Entity "ghost" not found for org self-hosted \(global\)/,
    );
  });

  it("throws when the stored YAML is not a mapping (scalar/array)", async () => {
    getEntity.mockResolvedValue({
      id: "orders-eu",
      connection_group_id: "eu_prod",
      yaml_content: "- just\n- a\n- list\n",
    });
    await expect(resolveAmendmentBaseline("org-1", "orders", "eu_prod")).rejects.toThrow(
      /expected a mapping/,
    );
  });

  it("propagates AmbiguousEntityError from an unscoped multi-group lookup (never swallowed)", async () => {
    // group=undefined → the primary read is unscoped; getEntity 409s on a name
    // shared across groups. The resolver must let it propagate.
    getEntity.mockImplementation(async (_o, _t, _n, group?: string | null) => {
      if (group === undefined) {
        throw new AmbiguousEntityError({ message: "orders exists in 2 environments", groups: [null, "eu_prod"] });
      }
      return null;
    });
    await expect(resolveAmendmentBaseline("org-1", "orders", undefined)).rejects.toThrow(
      "exists in 2 environments",
    );
  });
});
