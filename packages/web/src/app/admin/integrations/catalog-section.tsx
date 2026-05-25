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
 *                          per ADR-0006 / slice 7)
 *
 * Status payload (`/api/v1/admin/integrations/status`) is injected from
 * page.tsx so the page-level live-count badge and the per-card detail
 * rows / BYOT eligibility all read from one fetch. If the status query
 * fails (`statusError`) we surface an inline banner above the sections
 * so admins know detail rows + BYOT may be incomplete; install/disconnect
 * still works via the catalog endpoint, just without per-platform metadata.
 *
 * The single-card lifecycle (install / disconnect / manage / reconnect /
 * legacy-connected handling) lives in {@link CatalogCard} from
 * `./catalog-card`.
 */

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import type { IntegrationStatus } from "@useatlas/types";
import { friendlyErrorOrNull, type FetchError } from "@/ui/lib/fetch-error";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { SectionHeading } from "@/ui/components/admin/compact";
import { Cable, TriangleAlert } from "lucide-react";
import { CatalogCard } from "./catalog-card";

// Re-export for the catalog-section.test.tsx fixtures that still import
// `CatalogCard` from this module. The implementation moved to
// `./catalog-card` in slice 8 — keeping the re-export avoids a churn
// commit in the test file.
export { CatalogCard } from "./catalog-card";

export interface CatalogSectionProps {
  /**
   * Aggregated platform status payload. `null` while the page-level fetch
   * is in flight or has failed (see `statusError`). Cards degrade
   * gracefully — they still render install paths from the catalog row but
   * detail rows and BYOT eligibility go missing.
   */
  readonly status: IntegrationStatus | null;
  /**
   * Error from the page-level status fetch, if any. Surfaced as an inline
   * banner above the catalog so admins know they're seeing a partial view.
   */
  readonly statusError: FetchError | null;
  /**
   * Called after install / disconnect succeeds (or when the inline banner
   * retry fires). The parent should re-run the status fetch so detail
   * rows + legacy-connected state repaint.
   */
  readonly onChange: () => void;
}

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

export function CatalogSection({ status, statusError, onChange }: CatalogSectionProps) {
  const catalogQuery = useAdminFetch("/api/v1/integrations/catalog", {
    schema: IntegrationsCatalogResponseSchema,
  });

  const entries = catalogQuery.data?.catalog ?? [];
  const isEmpty = !catalogQuery.loading && !catalogQuery.error && entries.length === 0;
  const { chat, action } = groupByPillar(entries);

  // Refresh both queries after a successful install / disconnect — the
  // catalog row's `installed` flag flips (handled by useAdminMutation's
  // `invalidates` upstream) and the per-platform detail rows need to
  // repaint with the new connection state (handled by `onChange`).
  const refresh = () => {
    catalogQuery.refetch();
    onChange();
  };

  return (
    <section data-testid="catalog-section">
      {statusError && (
        <StatusErrorBanner error={statusError} onRetry={onChange} />
      )}

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

/**
 * Inline banner shown when the status fetch failed but the catalog fetch
 * succeeded. Tells the admin install/disconnect still works through the
 * catalog endpoint but per-platform detail rows + BYOT eligibility may be
 * incomplete. Retry runs the same `onChange` callback the card lifecycle
 * uses post-mutation, so recovery is one click.
 */
function StatusErrorBanner({
  error,
  onRetry,
}: {
  error: FetchError;
  onRetry: () => void;
}) {
  const message = friendlyErrorOrNull(error) ?? "Connection detail temporarily unavailable.";
  return (
    <div
      role="alert"
      data-testid="catalog-status-error-banner"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">Connection detail unavailable</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {message} Install and disconnect still work; per-platform detail may be missing.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md border border-amber-500/30 bg-background/50 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-background"
      >
        Retry
      </button>
    </div>
  );
}
