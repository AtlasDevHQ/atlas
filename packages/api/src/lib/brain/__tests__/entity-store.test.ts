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
import { warehouseRowId, type WarehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";

/**
 * A REAL minted id, not a `wh_a` cast.
 *
 * ⚠️ The resolver DROPS a row whose id is not the minted shape (#5232) — the
 * region importer is a second writer of `brain_entity` and a bundle is
 * untrusted — so a placeholder makes every resolver assertion below vacuous.
 * The pure functions (`resolvableIds`, `entityEdgeProposals`) do not check, but
 * one spelling for both keeps the file honest.
 */
const id = (seed: string) => warehouseRowId("ws", "accounts", seed);

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
    const built = entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme  Corp" });
    expect(built).toEqual({
      entityId: id("a"),
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
        entityId: id("a"),
        entity: "accounts",
        keySurface: "---",
        canonicalSurface: "Acme Corp",
      }),
    ).toBeNull();
    expect(
      buildEntityEntry({
        entityId: id("a"),
        entity: "accounts",
        keySurface: "42",
        canonicalSurface: "___",
      }),
    ).toBeNull();
    // The control: same call, both sides usable.
    expect(
      buildEntityEntry({
        entityId: id("a"),
        entity: "accounts",
        keySurface: "42",
        canonicalSurface: "Acme Corp",
      }),
    ).not.toBeNull();
  });

  it("refuses an empty id, entity or surface", () => {
    const base = { entity: "accounts", keySurface: "42", canonicalSurface: "Acme Corp" } as const;
    expect(buildEntityEntry({ ...base, entityId: "" as WarehouseRowId })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("a"), entity: "" })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("a"), keySurface: "" })).toBeNull();
    expect(buildEntityEntry({ ...base, entityId: id("a"), canonicalSurface: "" })).toBeNull();
  });
});

describe("resolvableIds — the fail-closed rule", () => {
  it("answers for both handles of an unambiguous entity", () => {
    const ids = resolvableIds([entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme Corp" })]);
    expect(ids.get("42")).toBe(id("a"));
    expect(ids.get("acme corp")).toBe(id("a"));
  });

  it("ABSTAINS on a canonical norm two entities share — and still answers for their keys", () => {
    const ids = resolvableIds([
      entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "43", canonicalSurface: "acme" }),
    ]);
    // The shared name resolves to NOTHING. Picking either would attach a claim
    // to the wrong entity; at the edge producer it would merge the two.
    expect(ids.has("acme")).toBe(false);
    // ⚠️ The controls, and they are what make the assertion above mean
    // "abstained on ambiguity" rather than "returned an empty map". Both keys
    // still resolve, to DIFFERENT ids.
    expect(ids.get("42")).toBe(id("a"));
    expect(ids.get("43")).toBe(id("b"));
  });

  it("ABSTAINS when one entity's key is another's name", () => {
    // The composition hazard: an edge `1 → acme` beside `acme → beta` composes
    // in the closure to `1 → beta`, merging two entities nobody merged.
    const ids = resolvableIds([
      entry({ entityId: "a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "Acme", canonicalSurface: "Beta" }),
    ]);
    expect(ids.has("acme")).toBe(false);
    expect(ids.get("1")).toBe(id("a"));
    expect(ids.get("beta")).toBe(id("b"));
  });

  it("stays poisoned when a THIRD entry repeats an already-ambiguous norm", () => {
    // Deleting the key on collision instead of marking it would let this third
    // entry re-insert the norm as unambiguous — a rule whose answer depends on
    // arrival order.
    const ids = resolvableIds([
      entry({ entityId: "a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "2", canonicalSurface: "Acme" }),
      entry({ entityId: "c", keySurface: "3", canonicalSurface: "Acme" }),
    ]);
    expect(ids.has("acme")).toBe(false);
    expect(ids.get("3")).toBe(id("c"));
  });

  it("REFUSES an empty norm itself, rather than trusting its callers to filter", () => {
    // ⚠️ `resolvableIds` takes `EntityNorms` — a bare structural type, not the
    // constructor-guarded `EntityStoreEntry` — so a caller CAN hand it a
    // degenerate norm, and this function's docstring calls itself the single
    // home of the fail-closed clause. That was true of ambiguity and not of
    // emptiness: `""` was refused only by two other places, so the claim was
    // being kept by the callers rather than here.
    //
    // Hand-built deliberately: `buildEntityEntry` cannot produce this, which is
    // exactly why the guard was unfalsifiable until now.
    const ids = resolvableIds([
      { entityId: id("a"), keyNorm: "", canonicalNorm: "acme corp" },
      { entityId: id("b"), keyNorm: "", canonicalNorm: "beta llc" },
    ]);
    // `""` is the one key value that joins every other degenerate row. Without
    // the guard it is merely AMBIGUOUS here (two ids claim it) — which is safe
    // by luck. A single degenerate entry would resolve it to a real id.
    expect(ids.has("")).toBe(false);
    const alone = resolvableIds([{ entityId: id("a"), keyNorm: "", canonicalNorm: "acme corp" }]);
    expect(alone.has("")).toBe(false);
    // The control, from the same call: the non-degenerate norm still resolves,
    // so this is a rule about `""` and not a function that refuses everything.
    expect(alone.get("acme corp")).toBe(id("a"));
  });

  it("does not poison an entry whose two norms are equal — a natural key", () => {
    const ids = resolvableIds([
      entry({ entityId: "a", keySurface: "Acme Corp", canonicalSurface: "acme corp" }),
    ]);
    expect(ids.get("acme corp")).toBe(id("a"));
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
    entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme Corp" }),
    entry({ entityId: "b", keySurface: "43", canonicalSurface: "Beta LLC" }),
  ];

  it("resolves a surface by its canonical name AND by its key — role-invariantly", async () => {
    const l = lookup(rows);
    const resolve = entityStoreResolver({ lookup: l.fn });
    const answer = await resolve(new Set(["ACME  corp", "43"]), { workspaceId: "ws" });
    // ⚠️ THE POSITIVE CONTROL for the whole store. Everything else in this file
    // could pass against a resolver that always abstains; this one cannot.
    expect(answer.get("ACME  corp")).toEqual({ entityId: id("a") });
    expect(answer.get("43")).toEqual({ entityId: id("b") });
  });

  it("abstains on an unknown surface while answering a known one in the same batch", async () => {
    const resolve = entityStoreResolver({ lookup: lookup(rows).fn });
    const answer = await resolve(new Set(["Acme Corp", "Gamma Inc"]), { workspaceId: "ws" });
    expect(answer.has("Gamma Inc")).toBe(false);
    expect(answer.get("Acme Corp")).toEqual({ entityId: id("a") });
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
    expect(answer.get("Acme Corp")).toEqual({ entityId: id("a") });
  });

  it("abstains on an ambiguous name and still answers the unambiguous surface", async () => {
    const l = lookup([
      entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "43", canonicalSurface: "Acme" }),
    ]);
    const resolve = entityStoreResolver({ lookup: l.fn });
    const answer = await resolve(new Set(["Acme", "42"]), { workspaceId: "ws" });
    expect(answer.has("Acme")).toBe(false);
    expect(answer.get("42")).toEqual({ entityId: id("a") });
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
    const { proposals, selfEdges, ambiguous } = entityEdgeProposals([
      entry({ entityId: "a", keySurface: "42", canonicalSurface: "Acme Corp" }),
    ]);
    expect({ selfEdges, ambiguous }).toEqual({ selfEdges: 0, ambiguous: 0 });
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
    // out of the slot to prevent.
    //
    // A key surface that NORMS DIFFERENTLY from itself, so `fromNorm` is
    // distinguishable from `keySurface` as well as from `toNorm` — an earlier
    // version used `"42"`, where the surface and its norm hold the same bytes
    // and an edge built from the wrong one is invisible.
    const [first] = entityEdgeProposals([
      entry({ entityId: "a", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
    ]).proposals;
    expect(first?.fromNorm).toBe("acc 42");
    expect(first?.toNorm).toBe("acme corp");
    // Stated as an inequality too — the comment claimed this assertion existed
    // when it did not, which is the class of false-comment the sweep exists for.
    expect(first?.fromNorm).not.toBe(first?.toNorm);
  });

  it("emits NOTHING for a natural key, and COUNTS it as a self-edge", () => {
    expect(
      entityEdgeProposals([
        entry({ entityId: "a", keySurface: "Acme Corp", canonicalSurface: "acme corp" }),
      ]),
    ).toEqual({ proposals: [], selfEdges: 1, ambiguous: 0 });
  });

  it("refuses BOTH sides of an ambiguous name, and emits for the third entity", () => {
    // `1 → acme` and `2 → acme` are each legal under the edge table's
    // at-most-one-parent key, and together they merge two entities into one slot
    // key workspace-wide with no inverse.
    const batch = entityEdgeProposals([
      entry({ entityId: "a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "2", canonicalSurface: "acme" }),
      entry({ entityId: "c", keySurface: "3", canonicalSurface: "Gamma" }),
    ]);
    // The control is the third entity: an implementation that refused
    // everything on seeing any ambiguity would satisfy the negative alone.
    expect(batch.proposals.map((p) => `${p.fromNorm}->${p.toNorm}`)).toEqual([
      "3->gamma",
      "3->gamma",
    ]);
    // ⚠️ COUNTED, not merely skipped. Both refused entries reach the run
    // report, which is the only way a person learns two of their rows share a
    // name and will never resolve by it.
    expect(batch.ambiguous).toBe(2);
    expect(batch.selfEdges).toBe(0);
  });

  it("refuses an entry whose KEY is another entity's name", () => {
    const batch = entityEdgeProposals([
      entry({ entityId: "a", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "b", keySurface: "Acme", canonicalSurface: "Beta" }),
      entry({ entityId: "c", keySurface: "3", canonicalSurface: "Gamma" }),
    ]);
    expect(batch.proposals.map((p) => `${p.fromNorm}->${p.toNorm}`)).toEqual(["3->gamma", "3->gamma"]);
    expect(batch.ambiguous).toBe(2);
  });

  it("carries NO id on any proposal — the claim two docstrings depend on", () => {
    // ⚠️ **A RATCHET, not a coverage test.** Three comments in this slice
    // asserted a dataflow the code did not honour, and one of them —
    // `loadEntityStore`'s "these ids reach `subject_cmp`" — was wrong precisely
    // because an id never leaves this function. That claim is now load-bearing
    // in two docstrings, so it is asserted rather than re-argued: if a future
    // edit threads an id onto a proposal (an `entityId` field, an id in
    // `proposedBy`, an id interpolated into a norm), the comments become false
    // and this goes red instead.
    const entries = [
      entry({ entityId: "a", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
      entry({ entityId: "b", keySurface: "ACC-43", canonicalSurface: "Beta LLC" }),
    ];
    const { proposals } = entityEdgeProposals(entries);
    expect(proposals.length).toBeGreaterThan(0);
    const ids = entries.map((e) => e.entityId);
    for (const proposal of proposals) {
      // Every field, serialized — so a NEW field carrying an id is caught too,
      // which a per-field assertion would not be.
      const serialized = JSON.stringify(proposal);
      for (const entityId of ids) {
        expect(serialized).not.toContain(entityId);
      }
    }
  });

  it("spans entities — ambiguity is a property of the WHOLE store", () => {
    // Two entities, one name each, identical. Emitted per-entity this pair would
    // never be compared, which is the reason the producer runs the edge pass
    // after the entity loop over the persisted store.
    const batch = entityEdgeProposals([
      entry({ entityId: "a", entity: "accounts", keySurface: "1", canonicalSurface: "Acme" }),
      entry({ entityId: "b", entity: "contacts", keySurface: "9", canonicalSurface: "Acme" }),
    ]);
    expect(batch).toEqual({ proposals: [], selfEdges: 0, ambiguous: 2 });
  });
});
