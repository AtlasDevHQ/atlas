/**
 * Pins the catalog wire schema against the install models the API actually
 * emits. The `?pillar=datasource` listing (#3377) includes GitHub Data's
 * `oauth-datasource` row (migration 0111); `useAdminFetch` parses the WHOLE
 * response through this schema, so one unaccepted install model would drop
 * every catalog-driven tile in the Add-datasource picker (#3384 review).
 */
import { describe, it, expect } from "bun:test";
import { IntegrationsCatalogResponseSchema } from "@/ui/lib/admin-schemas";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog:github-data",
    slug: "github-data",
    type: "datasource",
    installModel: "oauth-datasource",
    name: "GitHub Data",
    description: "Query GitHub repos as a read-only datasource.",
    iconUrl: null,
    minPlan: "starter",
    pillar: "datasource",
    implementationStatus: "available",
    configSchema: [],
    installed: false,
    installedAt: null,
    installedBy: null,
    installStatus: null,
    upsellOnly: false,
    accessible: true,
    ...overrides,
  };
}

describe("IntegrationsCatalogResponseSchema — install models (#3377/#3384)", () => {
  it("accepts every install model the datasource pillar emits", () => {
    const models = ["oauth", "form", "static-bot", "oauth-datasource"];
    const parsed = IntegrationsCatalogResponseSchema.safeParse({
      catalog: models.map((installModel, i) =>
        entry({ id: `catalog:m${i}`, slug: `m${i}`, installModel }),
      ),
    });
    expect(parsed.success).toBe(true);
  });

  it("one oauth-datasource row does not poison the rest of the listing", () => {
    const parsed = IntegrationsCatalogResponseSchema.safeParse({
      catalog: [
        entry({ id: "catalog:clickhouse", slug: "clickhouse", installModel: "form" }),
        entry(), // github-data, oauth-datasource
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog.length).toBe(2);
    }
  });
});
