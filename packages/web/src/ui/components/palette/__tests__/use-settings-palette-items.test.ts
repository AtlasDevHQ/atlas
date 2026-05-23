import { describe, expect, test, mock } from "bun:test";

// Mock the fetch hook so we can drive `useSettingsPaletteItems` with
// arbitrary catalog shapes — including the malformed branches the
// defensive null-walk is meant to absorb.
let mockData: unknown = null;
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: mockData, loading: false, error: null, refetch: () => {} }),
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { useSettingsPaletteItems } = await import("../use-settings-palette-items");

function workspaceSetting(over: Partial<{ key: string; section: string; label: string; envVar: string; description: string }>) {
  return {
    key: over.key ?? "ATLAS_ROW_LIMIT",
    section: over.section ?? "Query Limits",
    label: over.label ?? "Row Limit",
    description: over.description ?? "Caps the rows returned per query.",
    envVar: over.envVar ?? "ATLAS_ROW_LIMIT",
    scope: "workspace" as const,
  };
}

describe("useSettingsPaletteItems", () => {
  test("returns [] when fetch hasn't resolved", () => {
    mockData = null;
    expect(useSettingsPaletteItems(true)).toEqual([]);
  });

  test("returns [] when the response is malformed (no settings field)", () => {
    // Defensive null-walk: test mocks may return arbitrary shapes; the
    // host tree must not crash if .settings is missing.
    mockData = { manageable: true };
    expect(useSettingsPaletteItems(true)).toEqual([]);
  });

  test("groups workspace settings by section and tags items with the source", () => {
    mockData = {
      manageable: true,
      settings: [
        workspaceSetting({ key: "ATLAS_ROW_LIMIT", section: "Query Limits", label: "Row Limit" }),
        workspaceSetting({ key: "ATLAS_QUERY_TIMEOUT", section: "Query Limits", label: "Query Timeout" }),
        workspaceSetting({ key: "ATLAS_RATE_LIMIT_RPM", section: "Rate Limiting", label: "Rate Limit (RPM)" }),
      ],
    };
    const groups = useSettingsPaletteItems(true);
    expect(groups.map((g) => g.heading)).toEqual(["Setting: Query Limits", "Setting: Rate Limiting"]);
    const queryLimits = groups.find((g) => g.heading === "Setting: Query Limits");
    expect(queryLimits?.items.map((i) => i.title)).toEqual(["Row Limit", "Query Timeout"]);
    expect(queryLimits?.items[0].id).toBe("setting:ATLAS_ROW_LIMIT");
  });

  test("excludes platform-scoped settings", () => {
    // Platform settings live at `/platform/settings` and are not part of
    // the workspace surface — including them would route a workspace
    // admin into a 403 on click.
    mockData = {
      manageable: true,
      settings: [
        { ...workspaceSetting({}), scope: "platform" as const },
        workspaceSetting({ key: "ATLAS_KEEP", section: "Sessions", label: "Idle Timeout" }),
      ],
    };
    const groups = useSettingsPaletteItems(true);
    const items = groups.flatMap((g) => g.items);
    expect(items.map((i) => i.id)).toEqual(["setting:ATLAS_KEEP"]);
  });

  test("deep-link href uses the canonical #setting-<key> anchor", () => {
    mockData = {
      manageable: true,
      settings: [workspaceSetting({ key: "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS", section: "MCP", label: "Expose canonical prompts" })],
    };
    const item = useSettingsPaletteItems(true)[0].items[0];
    expect(item.action).toEqual({
      kind: "navigate",
      href: "/admin/settings#setting-ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS",
    });
  });

  test("keywords include env var, description, section, and key for fuzzy match", () => {
    mockData = {
      manageable: true,
      settings: [workspaceSetting({})],
    };
    const item = useSettingsPaletteItems(true)[0].items[0];
    expect(item.keywords).toContain("ATLAS_ROW_LIMIT");
    expect(item.keywords).toContain("Caps the rows returned per query.");
    expect(item.keywords).toContain("Query Limits");
  });
});
