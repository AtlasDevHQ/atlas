/**
 * The entity store's pure half — entry construction, the fail-closed rule, the
 * resolver's exact-match contract, and the entity-edge producer (#5043).
 *
 * ⚠️ **Every negative here sits beside a POSITIVE control from the same call.**
 * ADR-0039 states the reason at the milestone level: an empty store and a
 * correctly-working store are indistinguishable from inside the code, so a suite
 * that only asserted "this abstains" would pass against a store that abstains at
 * everything — including one whose lookup was deleted. Each `abstains` assertion
 * therefore comes with a surface in the same batch that RESOLVES.
 */

import { describe, expect, it } from "bun:test";
import {
  ENTITY_EDGE_CONFIDENCE,
  ENTITY_EDGE_POSITIONS,
  ENTITY_EDGE_PRODUCER,
  buildEntityEntry,
  entityEdgeProposals,
  entityStoreResolver,
  resolvableIds,
  type EntityStoreEntry,
} from "@atlas/api/lib/brain/entity-store";
import type { WarehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";

const id = (s: string) => s as WarehouseRowId;

/** One entry, built through the real constructor so norms are never hand-written. */
function entry(params: {
  entityId: string;
  entity?: string;
  keySurface: string;
  canonicalSurface: string;
}): EntityStoreEntry {
  const built = buildEntityEntry({
    entityId: id(params.entityId),
    entity: params.entity ?? "accounts",
    keySurface: params.keySurface,
    canonicalSurface: params.canonicalSurface,
  });
  if (built === null) throw new Error("fixture did not build an entry");
  return built;
}

// ---------------------------------------------------------------------------

describe("buildEntityEntry", () => {
  it("norms both surfaces and keeps both verbatim", () => {
    const built = entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme  Corp" });
    expect(built).toEqual({
      entityId: id("wh_a"),
      entity: "accounts",
      keySurface: "42",
      keyNorm: "42",
      // The SURFACE keeps its double space and its casing; the NORM does not.
      // Asserting both is what distinguishes "normed" from "copied", which a
      // fixture whose surface is already in normal form cannot do.
      canonicalSurface: "Acme  Corp",
      canonicalNorm: "acme corp",
    });
  });

  it("refuses a surface that normalizes away — either side, and the other side is the control", () => {
    // `---` norms to `""`. A stored empty norm is migration 0187's `DEFAULT ''`
    // hazard through the front door: the one key value that joins every other
    // degenerate row, so two unrelated placeholder entities resolve to one id.
    expect(
      buildEntityEntry({
        entityId: id("wh_a"),
        entity: "accounts",
        keySurface: "---",
        canonicalSurface: "Acme Corp",
      }),
    ).toBeNull();
    expect(
      buildEntityEntry({
        entityId: id("wh_a"),
        entity: "accounts",
        keySurface: "42",
        canonicalSurface: "___",
      }),
    ).toBeNull();
    // The control: same call, both sides usable.
    expect(
      buildEntityEntry({
        entityId: id("wh_a"),
        entity: "accounts",
        keySurface: "42",
        canonicalSurface: "Acme Corp",
      }),
    ).not.toBeNull();
  });

  it("refuses an empty id, entity or surface", () => {
    const base = { entity: "accounts", keySurface: "42", canonicalSurface: "Acme Corp" } as const;
    expect(buildEntityEntry({ ...base, entityId: id("") })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("wh_a"), entity: "" })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("wh_a"), keySurface: "" })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("wh_a"), canonicalSurface: "" })).toBeNull();
  });
});

describe("resolvableIds — the fail-closed rule", () => {
  it("answers for both handles of an unambiguous entity", () => {
    const ids = resolvableIds([entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme Corp" })]);
    expect(ids.get("42")).toBe(id("wh_a"));
    expect(ids.get("acme corp")).toBe(id("wh_a"));
  });

  it("ABSTAINS on a canonical norm two entities share — and still answers for their keys", () => {
    const ids = resolvableIds([
      entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "43", canonicalSurface: "acme" }),
    ]);
    // The shared name resolves to NOTHING. Picking either would attach a claim
    // to the wrong entity; at the edge producer it would merge the two.
    expect(ids.has("acme")).toBe(false);
    // ⚠️ The controls, and they are what make the assertion above mean
    // "abstained on ambiguity" rather than "returned an empty map". Both keys
    // still resolve, to DIFFERENT ids.
    expect(ids.get("42")).toBe(id("wh_a"));
    expect(ids.get("43")).toBe(id("wh_b"));
  });

  it("ABSTAINS when one entity's key is another's name", () => {
    // The composition hazard: an edge `1 → acme` beside `acme → beta` composes
    // in the closure to `1 → beta`, merging two entities nobody merged.
    const ids = resolvableIds([
      entry({ entityId: "wh_a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "Acme", canonicalSurface: "Beta" }),
    ]);
    expect(ids.has("acme")).toBe(false);
    expect(ids.get("1")).toBe(id("wh_a"));
    expect(ids.get("beta")).toBe(id("wh_b"));
  });

  it("stays poisoned when a THIRD entry repeats an already-ambiguous norm", () => {
    // Deleting the key on collision instead of marking it would let this third
    // entry re-insert the norm as unambiguous — a rule whose answer depends on
    // arrival order.
    const ids = resolvableIds([
      entry({ entityId: "wh_a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "2", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_c", keySurface: "3", canonicalSurface: "Acme" }),
    ]);
    expect(ids.has("acme")).toBe(false);
    expect(ids.get("3")).toBe(id("wh_c"));
  });

  it("does not poison an entry whose two norms are equal — a natural key", () => {
    const ids = resolvableIds([
      entry({ entityId: "wh_a", keySurface: "Acme Corp", canonicalSurface: "acme corp" }),
    ]);
    expect(ids.get("acme corp")).toBe(id("wh_a"));
  });
});

describe("entityStoreResolver", () => {
  /** The lookup seam, recording what it was asked. */
  function lookup(rows: readonly EntityStoreEntry[]) {
    const asked: string[][] = [];
    return {
      asked,
      fn: async (_workspaceId: string, norms: readonly string[]) => {
        asked.push([...norms]);
        return rows
          .filter((r) => norms.includes(r.keyNorm) || norms.includes(r.canonicalNorm))
          .map((r) => ({
            entity_id: r.entityId,
            key_norm: r.keyNorm,
            canonical_norm: r.canonicalNorm,
          }));
      },
    };
  }

  const rows = [
    entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme Corp" }),
    entry({ entityId: "wh_b", keySurface: "43", canonicalSurface: "Beta LLC" }),
  ];

  it("resolves a surface by its canonical name AND by its key — role-invariantly", async () => {
    const l = lookup(rows);
    const resolve = entityStoreResolver({ lookup: l.fn });
    const answer = await resolve(new Set(["ACME  corp", "43"]), { workspaceId: "ws" });
    // ⚠️ THE POSITIVE CONTROL for the whole store. Everything else in this file
    // could pass against a resolver that always abstains; this one cannot.
    expect(answer.get("ACME  corp")).toEqual({ entityId: "wh_a" });
    expect(answer.get("43")).toEqual({ entityId: "wh_b" });
  });

  it("abstains on an unknown surface while answering a known one in the same batch", async () => {
    const resolve = entityStoreResolver({ lookup: lookup(rows).fn });
    const answer = await resolve(new Set(["Acme Corp", "Gamma Inc"]), { workspaceId: "ws" });
    expect(answer.has("Gamma Inc")).toBe(false);
    expect(answer.get("Acme Corp")).toEqual({ entityId: "wh_a" });
  });

  it("does NOTHING clever — no prefix, no substring, no near miss", async () => {
    const resolve = entityStoreResolver({ lookup: lookup(rows).fn });
    const answer = await resolve(
      new Set(["Acme", "Acme Corporation", "Acme Corp"]),
      { workspaceId: "ws" },
    );
    // A prefix and a superstring of a stored name, both absent. The exact
    // spelling beside them is the control.
    expect(answer.has("Acme")).toBe(false);
    expect(answer.has("Acme Corporation")).toBe(false);
    expect(answer.get("Acme Corp")).toEqual({ entityId: "wh_a" });
  });

  it("abstains on an ambiguous name and still answers the unambiguous surface", async () => {
    const l = lookup([
      entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "43", canonicalSurface: "Acme" }),
    ]);
    const resolve = entityStoreResolver({ lookup: l.fn });
    const answer = await resolve(new Set(["Acme", "42"]), { workspaceId: "ws" });
    expect(answer.has("Acme")).toBe(false);
    expect(answer.get("42")).toEqual({ entityId: "wh_a" });
  });

  it("sends ONE deduplicated batch of norms, and never a degenerate one", async () => {
    const l = lookup(rows);
    const resolve = entityStoreResolver({ lookup: l.fn });
    // Three spellings of one norm, plus a surface that norms away.
    await resolve(new Set(["Acme Corp", "ACME CORP", "acme  corp", "---"]), {
      workspaceId: "ws",
    });
    expect(l.asked).toHaveLength(1);
    // `''` is the one norm that would join every degenerate row in the table.
    expect(l.asked[0]?.toSorted()).toEqual(["acme corp"]);
  });

  it("skips the lookup entirely when every surface norms away", async () => {
    const l = lookup(rows);
    const answer = await entityStoreResolver({ lookup: l.fn })(new Set(["---", "  "]), {
      workspaceId: "ws",
    });
    expect(l.asked).toEqual([]);
    expect(answer.size).toBe(0);
  });

  it("THROWS when the store cannot be read — it does not degrade to an abstain", async () => {
    // An absent key means "this will not change on replay" and is left
    // unflagged; a store that was UNREACHABLE will change on replay, and the
    // only way to say so is to fail. `reconcile.ts` catches this and marks the
    // episode provisional. Swallowing here makes those rows unfindable, because
    // `object_cmp IS NULL` matches every honest abstain too.
    const resolve = entityStoreResolver({
      lookup: async () => {
        throw new Error("connection terminated");
      },
    });
    await expect(resolve(new Set(["Acme Corp"]), { workspaceId: "ws" })).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("entityEdgeProposals", () => {
  it("emits key → canonical at BOTH entity positions, warehouse-classed", () => {
    const proposals = entityEdgeProposals([
      entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme Corp" }),
    ]);
    expect(proposals).toEqual([
      {
        position: "subject",
        fromNorm: "42",
        toNorm: "acme corp",
        directed: true,
        sourceClass: "warehouse_key",
        confidence: ENTITY_EDGE_CONFIDENCE,
        proposedBy: ENTITY_EDGE_PRODUCER,
      },
      {
        position: "object",
        fromNorm: "42",
        toNorm: "acme corp",
        directed: true,
        sourceClass: "warehouse_key",
        confidence: ENTITY_EDGE_CONFIDENCE,
        proposedBy: ENTITY_EDGE_PRODUCER,
      },
    ]);
    expect([...ENTITY_EDGE_POSITIONS]).toEqual(["subject", "object"]);
  });

  it("points the edge AT the human name, never at the key", () => {
    // The reverse direction re-keys every human mention onto an opaque id,
    // reproducing in the vocabulary the corpus-orphaning ADR-0037 §5 kept ids
    // out of the slot to prevent. Asserted as an inequality too, so a fixture
    // whose two norms happened to sort the same way could not satisfy it.
    const [first] = entityEdgeProposals([
      entry({ entityId: "wh_a", keySurface: "42", canonicalSurface: "Acme Corp" }),
    ]);
    expect(first?.fromNorm).toBe("42");
    expect(first?.toNorm).toBe("acme corp");
  });

  it("emits NOTHING for a natural key — the two norms are one", () => {
    expect(
      entityEdgeProposals([
        entry({ entityId: "wh_a", keySurface: "Acme Corp", canonicalSurface: "acme corp" }),
      ]),
    ).toEqual([]);
  });

  it("refuses BOTH sides of an ambiguous name, and emits for the third entity", () => {
    // `1 → acme` and `2 → acme` are each legal under the edge table's
    // at-most-one-parent key, and together they merge two entities into one slot
    // key workspace-wide with no inverse.
    const proposals = entityEdgeProposals([
      entry({ entityId: "wh_a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "2", canonicalSurface: "acme" }),
      entry({ entityId: "wh_c", keySurface: "3", canonicalSurface: "Gamma" }),
    ]);
    // The control is the third entity: an implementation that refused
    // everything on seeing any ambiguity would satisfy the negative alone.
    expect(proposals.map((p) => `${p.fromNorm}->${p.toNorm}`)).toEqual([
      "3->gamma",
      "3->gamma",
    ]);
  });

  it("refuses an entry whose KEY is another entity's name", () => {
    const proposals = entityEdgeProposals([
      entry({ entityId: "wh_a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", keySurface: "Acme", canonicalSurface: "Beta" }),
      entry({ entityId: "wh_c", keySurface: "3", canonicalSurface: "Gamma" }),
    ]);
    expect(proposals.map((p) => `${p.fromNorm}->${p.toNorm}`)).toEqual(["3->gamma", "3->gamma"]);
  });

  it("spans entities — ambiguity is a property of the WHOLE store", () => {
    // Two entities, one name each, identical. Emitted per-entity this pair would
    // never be compared, which is the reason the producer runs the edge pass
    // after the entity loop over the persisted store.
    const proposals = entityEdgeProposals([
      entry({ entityId: "wh_a", entity: "accounts", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "wh_b", entity: "contacts", keySurface: "9", canonicalSurface: "Acme" }),
    ]);
    expect(proposals).toEqual([]);
  });
});
