/**
 * Canonical amendment identity key (#4507).
 *
 * These pin the "one key, everywhere" contract: the analyzer's staleness key,
 * `loadRejectedKeys`, and the insert-time guard must all agree on what "the
 * same change" is. In particular:
 *   - group scoping (NULL → "default") — a decision in one group must not
 *     govern another's same-named amendment;
 *   - per-type target extraction — distinct amendments of the same type on the
 *     same entity must NOT collapse into one identity (which would turn the
 *     permanent rejection guard into an over-broad block).
 */

import { describe, it, expect } from "bun:test";
import {
  amendmentIdentityKey,
  amendmentIdentityFromRow,
  amendmentTargetName,
} from "../amendment-identity";

describe("amendmentIdentityKey", () => {
  it("is group-scoped — NULL and undefined groups map to 'default'", () => {
    expect(amendmentIdentityKey(null, "orders", "add_dimension", "region")).toBe(
      "default:orders:add_dimension:region",
    );
    expect(amendmentIdentityKey(undefined, "orders", "add_dimension", "region")).toBe(
      "default:orders:add_dimension:region",
    );
  });

  it("keeps distinct groups distinct", () => {
    expect(amendmentIdentityKey("eu", "orders", "add_dimension", "region")).not.toBe(
      amendmentIdentityKey("us", "orders", "add_dimension", "region"),
    );
  });

  it("omits the target segment when absent (coarse identities)", () => {
    expect(amendmentIdentityKey("default", "orders", "add_query_pattern")).toBe(
      "default:orders:add_query_pattern",
    );
    expect(amendmentIdentityKey("default", "orders", "add_query_pattern", "")).toBe(
      "default:orders:add_query_pattern",
    );
  });

  it("glossary identity is host-entity-agnostic — same (group, term) is one key regardless of host entity (#4518)", () => {
    // The glossary is one document per group, so a term proposed under `orders`
    // and the same term under `customers` must reconstruct to the SAME identity
    // — otherwise rejecting one wouldn't suppress the other and dedup would queue
    // two rows writing the identical term.
    const fromOrders = amendmentIdentityKey("eu", "orders", "add_glossary_term", "MRR");
    const fromCustomers = amendmentIdentityKey("eu", "customers", "add_glossary_term", "MRR");
    expect(fromOrders).toBe(fromCustomers);
    expect(fromOrders).toBe("eu:glossary:add_glossary_term:MRR");
  });

  it("glossary group scoping and add-vs-update stay distinct (#4518)", () => {
    // Different groups remain distinct...
    expect(amendmentIdentityKey("eu", "orders", "add_glossary_term", "MRR")).not.toBe(
      amendmentIdentityKey("us", "orders", "add_glossary_term", "MRR"),
    );
    // ...and add vs update are distinct verbs (as add_/update_dimension are).
    expect(amendmentIdentityKey("eu", "orders", "add_glossary_term", "MRR")).not.toBe(
      amendmentIdentityKey("eu", "orders", "update_glossary_term", "MRR"),
    );
  });
});

describe("amendmentTargetName", () => {
  it("reads .name for name-keyed types", () => {
    expect(amendmentTargetName("add_dimension", { name: "region" })).toBe("region");
    expect(amendmentTargetName("add_measure", { name: "total_amount" })).toBe("total_amount");
    expect(amendmentTargetName("update_dimension", { name: "status" })).toBe("status");
    expect(amendmentTargetName("add_virtual_dimension", { name: "created_month" })).toBe("created_month");
  });

  it("reads the join name (to_<table>) for add_join", () => {
    expect(amendmentTargetName("add_join", { name: "to_customers" })).toBe("to_customers");
  });

  it("distinguishes table vs dimension description edits", () => {
    expect(amendmentTargetName("update_description", { field: "table", description: "x" })).toBe("table");
    expect(amendmentTargetName("update_description", { dimension: "region", description: "x" })).toBe("region");
    // Two update_description edits on the same entity must NOT collapse.
    expect(amendmentTargetName("update_description", { field: "table" })).not.toBe(
      amendmentTargetName("update_description", { dimension: "region" }),
    );
  });

  it("reads .term for glossary terms", () => {
    expect(amendmentTargetName("add_glossary_term", { term: "arr", definition: "" })).toBe("arr");
    // #4518: update_glossary_term keys on .term too, so rejection memory + pending
    // dedup identify a term amendment regardless of add-vs-update verb.
    expect(amendmentTargetName("update_glossary_term", { term: "churn", definition: "x" })).toBe("churn");
  });

  it("is coarse (undefined) for add_query_pattern — the stored name carries a per-run index", () => {
    expect(amendmentTargetName("add_query_pattern", { name: "pattern_orders_3" })).toBeUndefined();
  });

  it("returns undefined for a non-object amendment", () => {
    expect(amendmentTargetName("add_dimension", null)).toBeUndefined();
    expect(amendmentTargetName("add_dimension", "nope")).toBeUndefined();
    expect(amendmentTargetName("add_dimension", ["a"])).toBeUndefined();
  });
});

describe("amendmentIdentityFromRow", () => {
  it("reconstructs the same key from a stored payload (object) as amendmentIdentityKey builds", () => {
    const key = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: "eu",
      amendmentPayload: { amendmentType: "add_dimension", amendment: { name: "region" } },
    });
    expect(key).toBe("eu:orders:add_dimension:region");
    expect(key).toBe(amendmentIdentityKey("eu", "orders", "add_dimension", "region"));
  });

  it("parses a JSON-string payload", () => {
    const key = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: null,
      amendmentPayload: JSON.stringify({ amendmentType: "add_measure", amendment: { name: "total_amount" } }),
    });
    expect(key).toBe("default:orders:add_measure:total_amount");
  });

  it("reconstructs the join identity the analyzer keys staleness on", () => {
    // Analyzer keys add_join on `to_<table>`; the stored payload carries the
    // same name — the two must reconstruct to the same identity.
    const key = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: null,
      amendmentPayload: { amendmentType: "add_join", amendment: { name: "to_customers", sql: "..." } },
    });
    expect(key).toBe("default:orders:add_join:to_customers");
  });

  it("does not collapse two update_description edits on the same entity", () => {
    const tableKey = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: null,
      amendmentPayload: { amendmentType: "update_description", amendment: { field: "table", description: "x" } },
    });
    const dimKey = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: null,
      amendmentPayload: { amendmentType: "update_description", amendment: { dimension: "region", description: "y" } },
    });
    expect(tableKey).toBe("default:orders:update_description:table");
    expect(dimKey).toBe("default:orders:update_description:region");
    expect(tableKey).not.toBe(dimKey);
  });

  it("reconstructs a host-agnostic identity for glossary rows — same (group, term), different source entity (#4518)", () => {
    // Two pending glossary rows for the same term, surfaced under different host
    // entities, must dedup: they reconstruct to one host-agnostic identity.
    const underOrders = amendmentIdentityFromRow({
      sourceEntity: "orders",
      connectionGroupId: "eu",
      amendmentPayload: { amendmentType: "add_glossary_term", amendment: { term: "MRR", definition: "x" } },
    });
    const underCustomers = amendmentIdentityFromRow({
      sourceEntity: "customers",
      connectionGroupId: "eu",
      amendmentPayload: { amendmentType: "add_glossary_term", amendment: { term: "MRR", definition: "y" } },
    });
    expect(underOrders).toBe("eu:glossary:add_glossary_term:MRR");
    expect(underOrders).toBe(underCustomers);
  });

  it("returns null for a malformed payload (missing amendmentType)", () => {
    expect(
      amendmentIdentityFromRow({ sourceEntity: "orders", connectionGroupId: null, amendmentPayload: { amendment: { name: "x" } } }),
    ).toBeNull();
    expect(
      amendmentIdentityFromRow({ sourceEntity: "orders", connectionGroupId: null, amendmentPayload: "not-json{" }),
    ).toBeNull();
    expect(
      amendmentIdentityFromRow({ sourceEntity: "orders", connectionGroupId: null, amendmentPayload: null }),
    ).toBeNull();
  });
});
