/**
 * Unit tests for the pure improve-anchor helpers (#4519).
 *
 * These pin the load-bearing rules the launcher UI relies on: the request-field
 * omit-when-null contract (so an anchorless sweep carries no `anchor` key and the
 * server behaves exactly as it did before anchors existed — this proves absence
 * of the key, NOT whole-request byte-identity), the kick-off copy, and the chip
 * label. Mirrors the proposals-extraction pure-module suite.
 */

import { describe, it, expect } from "bun:test";
import {
  anchorRequestField,
  buildImproveChatBody,
  describeAnchor,
  groupKickoffMessage,
  entityKickoffMessage,
  columnKickoffMessage,
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

  it("carries a column anchor through unchanged (#4521)", () => {
    const anchor: ImproveAnchor = { kind: "column", entity: "orders", column: "status", group: "grp_prod" };
    expect(anchorRequestField(anchor)).toEqual({ anchor });
    const body = buildImproveChatBody([{ id: "m1", role: "user", parts: [] }], anchor);
    expect(body.anchor).toEqual(anchor);
  });
});

describe("buildImproveChatBody", () => {
  const messages = [{ id: "m1", role: "user", parts: [] }];

  it("rides the active anchor on the body when set (every turn stays scoped)", () => {
    const anchor: ImproveAnchor = { kind: "group", group: "grp_prod" };
    const body = buildImproveChatBody(messages, anchor);
    expect(body.messages).toBe(messages);
    expect(body.anchor).toEqual(anchor);
  });

  it("sends messages with no anchor key for an anchorless turn (AC4)", () => {
    const body = buildImproveChatBody(messages, null);
    expect(body.messages).toBe(messages);
    expect("anchor" in body).toBe(false);
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

  it("names both the column and its entity in the column kick-off (#4521)", () => {
    const msg = columnKickoffMessage("orders", "status");
    expect(msg).toContain('"status" column');
    expect(msg).toContain('"orders"');
    expect(msg).toContain("refine");
  });
});

describe("describeAnchor", () => {
  it("labels a group anchor", () => {
    expect(describeAnchor({ kind: "group", group: "grp_prod" }, "US Production")).toBe("Group: US Production");
  });

  it("labels an entity anchor", () => {
    expect(describeAnchor({ kind: "entity", entity: "orders" }, "orders")).toBe("Entity: orders");
  });

  it("labels a column anchor (#4521)", () => {
    expect(describeAnchor({ kind: "column", entity: "orders", column: "status" }, "orders.status")).toBe(
      "Column: orders.status",
    );
  });
});
