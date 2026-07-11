/**
 * Unit tests for the pure improve-anchor helpers (#4519).
 *
 * These pin the load-bearing rules the launcher UI relies on: the request-field
 * omit-when-null contract (so an anchorless sweep is byte-identical to the
 * pre-anchor request), the kick-off copy, and the chip label. Mirrors the
 * proposals-extraction pure-module suite.
 */

import { describe, it, expect } from "bun:test";
import {
  anchorRequestField,
  describeAnchor,
  groupKickoffMessage,
  entityKickoffMessage,
  SWEEP_KICKOFF_MESSAGE,
  type ImproveAnchor,
} from "../anchor";

describe("anchorRequestField", () => {
  it("omits the anchor field entirely for an anchorless sweep (AC4)", () => {
    expect(anchorRequestField(null)).toEqual({});
    expect("anchor" in anchorRequestField(null)).toBe(false);
  });

  it("carries a group anchor through unchanged", () => {
    const anchor: ImproveAnchor = { kind: "group", group: "grp_prod" };
    expect(anchorRequestField(anchor)).toEqual({ anchor });
  });

  it("carries an entity anchor (with optional group) through unchanged", () => {
    const anchor: ImproveAnchor = { kind: "entity", entity: "orders", group: "grp_prod" };
    expect(anchorRequestField(anchor)).toEqual({ anchor });
  });
});

describe("kick-off messages", () => {
  it("uses the friendly label in the group kick-off", () => {
    expect(groupKickoffMessage("US Production")).toContain('"US Production" connection group');
  });

  it("uses the entity name in the entity kick-off", () => {
    expect(entityKickoffMessage("orders")).toContain('"orders" entity');
  });

  it("has a stable sweep kick-off", () => {
    expect(SWEEP_KICKOFF_MESSAGE).toContain("highest-impact improvements");
  });
});

describe("describeAnchor", () => {
  it("labels a group anchor", () => {
    expect(describeAnchor({ kind: "group", group: "grp_prod" }, "US Production")).toBe("Group: US Production");
  });

  it("labels an entity anchor", () => {
    expect(describeAnchor({ kind: "entity", entity: "orders" }, "orders")).toBe("Entity: orders");
  });
});
