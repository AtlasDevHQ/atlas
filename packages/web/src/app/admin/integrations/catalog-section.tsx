"use client";

/**
 * Catalog card section for /admin/integrations.
 *
 * Reads the workspace-scoped catalog from `GET /api/v1/integrations/catalog`
 * and renders one card per entry, grouped by type (`chat` vs `integration`)
 * per CONTEXT.md. Card action branches on `installModel`:
 *   - `oauth` — links to `GET /:slug/install` (Slack today; Salesforce / Jira / etc. as they land)
 *   - `form` — opens the {@link FormInstallModal} (Email today; Webhook + Obsidian per #2661)
 *   - `static-bot` — render-inert until the handler ships in 1.5.3
 *
 * Manage / Disconnect still ship in #2656; they render but are inert.
 */

import { useState } from "react";
import { toast } from "sonner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getApiUrl } from "@/lib/api-url";
import { Cable, Sparkles } from "lucide-react";
import { FormInstallModal } from "./form-install-modal";

function groupByType(entries: IntegrationsCatalogEntry[]) {
  const chat: IntegrationsCatalogEntry[] = [];
  const integration: IntegrationsCatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "chat") chat.push(entry);
    else integration.push(entry);
  }
  return { chat, integration };
}

interface CatalogCardProps {
  entry: IntegrationsCatalogEntry;
  /** Fires after a successful install so the catalog list refreshes. */
  onInstalled: () => void;
}

function CatalogCard({ entry, onInstalled }: CatalogCardProps) {
  const isUpsell = entry.upsellOnly;
  const isInstalled = entry.installed;
  const isForm = entry.installModel === "form";
  const isOAuth = entry.installModel === "oauth";
  const [formModalOpen, setFormModalOpen] = useState(false);

  return (
    <Card
      data-testid={`catalog-card-${entry.slug}`}
      className="relative transition-colors hover:border-primary/40"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{entry.name}</CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            {isInstalled && (
              <Badge variant="secondary" className="text-[10px]">
                Installed
              </Badge>
            )}
            {isUpsell && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Sparkles className="size-3" />
                {entry.minPlan}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {entry.description && (
          <p className="text-sm text-muted-foreground">{entry.description}</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {entry.installModel}
          </span>
          {/* Install action — branched on `installModel`:
              - "oauth" lands on the existing GET /install redirect
                (slice 5, #2653 — wired here in slice 7 so OAuth
                catalog cards stop being inert).
              - "form" opens the FormInstallModal (slice 7, #2660).
                Disconnect / Manage still ship in #2656. */}
          {isUpsell ? (
            <Button size="sm" variant="outline" disabled aria-label={`Upgrade required for ${entry.name}`}>
              Upgrade
            </Button>
          ) : isInstalled ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => undefined} aria-label={`Manage ${entry.name}`}>
                Manage
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => undefined}
                aria-label={`Disconnect ${entry.name}`}
              >
                Disconnect
              </Button>
            </div>
          ) : isForm ? (
            <Button
              size="sm"
              onClick={() => setFormModalOpen(true)}
              aria-label={`Install ${entry.name}`}
              data-testid={`catalog-card-${entry.slug}-install`}
            >
              Install
            </Button>
          ) : isOAuth ? (
            <Button size="sm" asChild aria-label={`Connect ${entry.name}`}>
              <a href={`${getApiUrl()}/api/v1/integrations/${entry.slug}/install`}>
                Connect
              </a>
            </Button>
          ) : (
            // static-bot — handler ships in 1.5.3; render inert so the
            // card is visible but not actionable yet.
            <Button size="sm" disabled aria-label={`Connect ${entry.name}`}>
              Connect
            </Button>
          )}
        </div>
      </CardContent>
      {isForm && (
        <FormInstallModal
          open={formModalOpen}
          onOpenChange={setFormModalOpen}
          slug={entry.slug}
          name={entry.name}
          description={entry.description}
          configSchema={entry.configSchema}
          onInstalled={() => {
            toast.success(`${entry.name} installed`);
            onInstalled();
          }}
        />
      )}
    </Card>
  );
}

export function CatalogSection() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/integrations/catalog", {
    schema: IntegrationsCatalogResponseSchema,
  });

  const entries = data?.catalog ?? [];
  const isEmpty = !loading && !error && entries.length === 0;
  const { chat, integration } = groupByType(entries);

  return (
    <section data-testid="catalog-section" className="mb-12">
      <header className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Available integrations</h2>
        <p className="text-sm text-muted-foreground">
          One-click install of integrations declared by your operator. Slack OAuth lands in 1.5.2;
          additional integrations roll out through the rest of the release.
        </p>
      </header>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Integrations"
        onRetry={refetch}
        loadingMessage="Loading integrations catalog..."
        emptyIcon={Cable}
        emptyTitle="No integrations available"
        emptyDescription="Your operator hasn't declared any catalog entries yet. See the Plugin Catalog documentation at docs.useatlas.dev/deployment/plugin-catalog to add some."
        isEmpty={isEmpty}
      >
        <div className="space-y-8">
          {chat.length > 0 && (
            <div data-testid="catalog-group-chat">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Chat platforms
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {chat.map((entry) => (
                  <CatalogCard key={entry.id} entry={entry} onInstalled={refetch} />
                ))}
              </div>
            </div>
          )}
          {integration.length > 0 && (
            <div data-testid="catalog-group-integration">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Integrations
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {integration.map((entry) => (
                  <CatalogCard key={entry.id} entry={entry} onInstalled={refetch} />
                ))}
              </div>
            </div>
          )}
        </div>
      </AdminContentWrapper>
    </section>
  );
}
