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

  // ── formInstallable (#3387) ────────────────────────────────────────────
  // The `?pillar=datasource` listing carries a server-derived per-row
  // `formInstallable`; the default listing omits it. Both shapes must
  // parse, and the flag must survive the access-union transform so the
  // Add picker can read it.
  it("passes formInstallable through the transform when present", () => {
    const parsed = IntegrationsCatalogResponseSchema.safeParse({
      catalog: [
        entry({
          id: "catalog:clickhouse",
          slug: "clickhouse",
          installModel: "form",
          formInstallable: true,
        }),
        entry({
          id: "catalog:duckdb",
          slug: "duckdb",
          installModel: "form",
          formInstallable: false,
        }),
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog[0]?.formInstallable).toBe(true);
      expect(parsed.data.catalog[1]?.formInstallable).toBe(false);
    }
  });

  it("parses rows without formInstallable (default listing / older API)", () => {
    const parsed = IntegrationsCatalogResponseSchema.safeParse({
      catalog: [entry({ installModel: "oauth" })],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog[0]?.formInstallable).toBeUndefined();
    }
  });
});
