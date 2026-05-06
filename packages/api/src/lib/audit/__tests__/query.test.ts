/**
 * Unit tests for the audit-log filter builder (#2067).
 *
 * The route-level tests in `admin.test.ts` exercise the full HTTP path;
 * these tests pin the SQL shape the builder emits so a future
 * refactor (e.g. moving to Drizzle's QueryBuilder) can't silently drop
 * a filter or shuffle the placeholder ordering.
 */

import { describe, it, expect } from "bun:test";
import { buildAuditFilters } from "../query";

function reader(map: Record<string, string>): (k: string) => string | undefined {
  return (k) => map[k];
}

describe("buildAuditFilters", () => {
  it("returns the orgId + soft-delete predicates with no caller filters", () => {
    const result = buildAuditFilters("org-1", reader({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual([
      "a.deleted_at IS NULL",
      "a.org_id = $1",
    ]);
    expect(result.params).toEqual(["org-1"]);
    expect(result.paramIdx).toBe(2);
  });

  it("applies actorKind filter (#2067)", () => {
    const result = buildAuditFilters("org-1", reader({ actorKind: "mcp" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toContain("a.actor_kind = $2");
    expect(result.params).toEqual(["org-1", "mcp"]);
  });

  it("applies clientId filter (#2067)", () => {
    const result = buildAuditFilters("org-1", reader({ clientId: "claude-desktop" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toContain("a.client_id = $2");
    expect(result.params).toEqual(["org-1", "claude-desktop"]);
  });

  it("applies tool filter (#2067)", () => {
    const result = buildAuditFilters("org-1", reader({ tool: "runMetric" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toContain("a.tool_name = $2");
    expect(result.params).toEqual(["org-1", "runMetric"]);
  });

  it("AND-combines all three #2067 filters with stable ordering", () => {
    const result = buildAuditFilters(
      "org-1",
      reader({ actorKind: "mcp", clientId: "claude-desktop", tool: "executeSQL" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Declaration order: actorKind ($2) → clientId ($3) → tool ($4)
    expect(result.conditions.slice(2)).toEqual([
      "a.actor_kind = $2",
      "a.client_id = $3",
      "a.tool_name = $4",
    ]);
    expect(result.params).toEqual(["org-1", "mcp", "claude-desktop", "executeSQL"]);
    expect(result.paramIdx).toBe(5);
  });

  it("ignores empty-string actorKind / clientId / tool", () => {
    // The frontend sends `?actorKind=` when the user picks "All actors";
    // the builder must treat empty strings as absent so the SQL doesn't
    // become `WHERE actor_kind = ''` and silently match no rows.
    const result = buildAuditFilters(
      "org-1",
      reader({ actorKind: "", clientId: "", tool: "" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conditions).toEqual([
      "a.deleted_at IS NULL",
      "a.org_id = $1",
    ]);
    expect(result.params).toEqual(["org-1"]);
  });

  it("preserves placeholder ordering when interleaved with existing filters", () => {
    const result = buildAuditFilters(
      "org-1",
      reader({
        user: "u-9",
        success: "true",
        actorKind: "mcp",
        clientId: "claude-desktop",
        tool: "runMetric",
        search: "orders",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // user $2 → success $3 → actorKind $4 → clientId $5 → tool $6 → search $7
    expect(result.params).toEqual([
      "org-1",
      "u-9",
      true,
      "mcp",
      "claude-desktop",
      "runMetric",
      "%orders%",
    ]);
    expect(result.conditions).toContain("a.user_id = $2");
    expect(result.conditions).toContain("a.success = $3");
    expect(result.conditions).toContain("a.actor_kind = $4");
    expect(result.conditions).toContain("a.client_id = $5");
    expect(result.conditions).toContain("a.tool_name = $6");
    expect(
      result.conditions.some((c) => c.includes("a.sql ILIKE $7")),
    ).toBe(true);
  });

  it("propagates invalid date errors as 400 results", () => {
    const result = buildAuditFilters("org-1", reader({ from: "not-a-date" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_request");
  });
});
