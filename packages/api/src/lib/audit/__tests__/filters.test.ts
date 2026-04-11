/**
 * Tests for the shared admin action filter builder.
 */

import { describe, it, expect } from "bun:test";
import { buildActionFilters } from "../filters";

describe("buildActionFilters", () => {
  it("returns empty conditions when no filters provided", () => {
    const result = buildActionFilters(1, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual([]);
    expect(result.params).toEqual([]);
    expect(result.paramIdx).toBe(1);
  });

  it("builds actor ILIKE filter with partial match", () => {
    const result = buildActionFilters(1, { actor: "admin" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["actor_email ILIKE $1"]);
    expect(result.params).toEqual(["%admin%"]);
    expect(result.paramIdx).toBe(2);
  });

  it("builds actionType exact match filter", () => {
    const result = buildActionFilters(1, { actionType: "settings.update" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["action_type = $1"]);
    expect(result.params).toEqual(["settings.update"]);
  });

  it("builds targetType exact match filter", () => {
    const result = buildActionFilters(1, { targetType: "connection" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["target_type = $1"]);
    expect(result.params).toEqual(["connection"]);
  });

  it("builds from date filter", () => {
    const result = buildActionFilters(1, { from: "2026-01-01" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["timestamp >= $1"]);
    expect(result.params).toEqual(["2026-01-01"]);
  });

  it("builds to date filter", () => {
    const result = buildActionFilters(1, { to: "2026-03-01" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["timestamp <= $1"]);
    expect(result.params).toEqual(["2026-03-01"]);
  });

  it("returns error for invalid from date", () => {
    const result = buildActionFilters(1, { from: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_request");
    expect(result.message).toContain("not-a-date");
    expect(result.status).toBe(400);
  });

  it("returns error for invalid to date", () => {
    const result = buildActionFilters(1, { to: "bad-date" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_request");
    expect(result.message).toContain("bad-date");
    expect(result.status).toBe(400);
  });

  it("builds search ILIKE filter on metadata", () => {
    const result = buildActionFilters(1, { search: "test-query" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["metadata::text ILIKE $1"]);
    expect(result.params).toEqual(["%test-query%"]);
  });

  it("escapes ILIKE special characters in search", () => {
    const result = buildActionFilters(1, { search: "50%" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params).toEqual(["%50\\%%"]);
  });

  it("escapes ILIKE special characters in actor", () => {
    const result = buildActionFilters(1, { actor: "admin_user" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params).toEqual(["%admin\\_user%"]);
  });

  it("builds orgId exact match filter", () => {
    const result = buildActionFilters(1, { orgId: "org-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["org_id = $1"]);
    expect(result.params).toEqual(["org-123"]);
  });

  it("composes multiple filters correctly", () => {
    const result = buildActionFilters(3, {
      actor: "admin",
      actionType: "settings.update",
      targetType: "settings",
      from: "2026-01-01",
      to: "2026-03-01",
      search: "key",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual([
      "actor_email ILIKE $3",
      "action_type = $4",
      "target_type = $5",
      "timestamp >= $6",
      "timestamp <= $7",
      "metadata::text ILIKE $8",
    ]);
    expect(result.params).toEqual([
      "%admin%",
      "settings.update",
      "settings",
      "2026-01-01",
      "2026-03-01",
      "%key%",
    ]);
    expect(result.paramIdx).toBe(9);
  });

  it("starts param indexing at the given startIdx", () => {
    const result = buildActionFilters(5, { actor: "bob" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual(["actor_email ILIKE $5"]);
    expect(result.paramIdx).toBe(6);
  });
});
