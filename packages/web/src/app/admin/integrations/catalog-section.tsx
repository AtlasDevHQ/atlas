"use client";

/**
 * Catalog section for `/admin/integrations`. Slice 8 of 1.5.3 (#2746)
 * removed the legacy per-platform card stack from `page.tsx` and pivoted
 * the catalog cards to a pillar-driven Chat / Actions split sourced from
 * the `pillar` field added in slice 3 (#2741).
 *
 *   - pillar="chat"       → "Chat — where customers talk to Atlas"
 *   - pillar="action"     → "Actions — what Atlas can do for you"
 *   - pillar="datasource" → filtered out (lives on `/admin/connections`
 *                          per slice 7 / ADR-0006)
 *
 * The single-card lifecycle (install / disconnect / manage / reconnect /
 * legacy-connected handling) lives in {@link CatalogCard} from
 * `./catalog-card`. This file is the orchestrator: fetches the catalog,
 * the admin status payload (for per-platform detail rows), and renders
 * the two sections.
 */

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  IntegrationStatusSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { SectionHeading } from "@/ui/components/admin/compact";
import { Cable } from "lucide-react";
import { CatalogCard } from "./catalog-card";

// Re-export for the catalog-section.test.tsx fixtures that still import
// `CatalogCard` from this module. The implementation moved to
// `./catalog-card` in slice 8 — keeping the re-export avoids a churn
// commit in the test file.
export { CatalogCard } from "./catalog-card";

/**
 * Split catalog entries by pillar. Datasource rows are dropped — they
 * render on `/admin/connections`, not here.
 */
function groupByPillar(entries: IntegrationsCatalogEntry[]) {
  const chat: IntegrationsCatalogEntry[] = [];
  const action: IntegrationsCatalogEntry[] = [];
  for (const entry of entries) {
    // `pillar` is optional on the wire (older API responses pre-#2741
    // omit it). Fall back to the legacy `type` field so a downgrade or
    // partial deploy never empties both sections.
    const pillar = entry.pillar ?? legacyPillar(entry.type);
    if (pillar === "chat") chat.push(entry);
    else if (pillar === "action") action.push(entry);
    // pillar === "datasource" is intentionally dropped.
  }
  return { chat, action };
}

function legacyPillar(
  type: IntegrationsCatalogEntry["type"],
): "chat" | "action" | "datasource" {
  return type === "chat" ? "chat" : "action";
}

export function CatalogSection() {
  const catalogQuery = useAdminFetch("/api/v1/integrations/catalog", {
    schema: IntegrationsCatalogResponseSchema,
  });
  // The status payload is the source of truth for per-platform detail
  // (workspaceName, tenantId, guildId, displayPhone, …) and the BYOT
  // eligibility signal (oauthConfigured + hasInternalDB on Slack). The
  // catalog endpoint can't currently expose either — Slack's BYOT path
  // pre-dates the unified `workspace_plugins` model.
  const statusQuery = useAdminFetch("/api/v1/admin/integrations/status", {
    schema: IntegrationStatusSchema,
  });

  const entries = catalogQuery.data?.catalog ?? [];
  const isEmpty = !catalogQuery.loading && !catalogQuery.error && entries.length === 0;
  const { chat, action } = groupByPillar(entries);
  const status = statusQuery.data ?? null;

  // Refresh both queries after a successful install / disconnect — the
  // catalog row's `installed` flag flips and the per-platform detail
  // rows need to repaint with the new connection state.
  const refresh = () => {
    catalogQuery.refetch();
    statusQuery.refetch();
  };

  return (
    <section data-testid="catalog-section">
      <AdminContentWrapper
        loading={catalogQuery.loading}
        error={catalogQuery.error}
        feature="Integrations"
        onRetry={catalogQuery.refetch}
        loadingMessage="Loading integrations catalog..."
        emptyIcon={Cable}
        emptyTitle="No integrations available"
        emptyDescription="Your operator hasn't declared any catalog entries yet. See the Plugin Catalog documentation at docs.useatlas.dev/deployment/plugin-catalog to add some."
        isEmpty={isEmpty}
      >
        <div className="space-y-10">
          {chat.length > 0 && (
            <section data-testid="catalog-group-chat">
              {/* Heading copy lands as an eyebrow label + sentence to match
                  the rest of the admin surfaces (Messaging / Developer Tools
                  / Notifications etc.). The issue's "Chat — where customers
                  talk to Atlas" full-sentence heading is split here: the
                  em-dash version reads worse at eyebrow weight and the split
                  also lets the description carry the actual explanation. */}
              <SectionHeading
                title="Chat"
                description="Where customers talk to Atlas."
              />
              <div className="space-y-2">
                {chat.map((entry) => (
                  <CatalogCard
                    key={entry.id}
                    entry={entry}
                    status={status}
                    onChange={refresh}
                  />
                ))}
              </div>
            </section>
          )}
          {action.length > 0 && (
            <section data-testid="catalog-group-action">
              <SectionHeading
                title="Actions"
                description="What Atlas can do on your behalf."
              />
              <div className="space-y-2">
                {action.map((entry) => (
                  <CatalogCard
                    key={entry.id}
                    entry={entry}
                    status={status}
                    onChange={refresh}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </AdminContentWrapper>
    </section>
  );
}
