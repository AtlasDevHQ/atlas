"use client";

/**
 * Catalog card section for /admin/integrations (1.5.2 slice 3 — #2651).
 *
 * Reads the workspace-scoped catalog from `GET /api/v1/integrations/catalog`
 * and renders one card per entry, grouped by type (`chat` vs `integration`)
 * per CONTEXT.md.
 *
 * Read-only at this slice: the Connect / Manage / Disconnect buttons render
 * but are inert. Slice 5 (#2654) wires Connect; slice 6 (#2656) wires
 * Manage / Disconnect and removes the legacy per-platform blocks below.
 */

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cable, Sparkles } from "lucide-react";

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
}

function CatalogCard({ entry }: CatalogCardProps) {
  const isUpsell = entry.upsellOnly;
  const isInstalled = entry.installed;

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
            {entry.install_model}
          </span>
          {/* TODO(#2654/#2656) — Connect/Manage/Disconnect wire-up.
              Buttons render in this slice for shape parity, but are
              deliberately inert. Slice 5 wires the Connect path; slice 6
              wires Disconnect and lifts the legacy per-platform blocks
              below this section out. */}
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
          ) : (
            <Button size="sm" onClick={() => undefined} aria-label={`Connect ${entry.name}`}>
              Connect
            </Button>
          )}
        </div>
      </CardContent>
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
                  <CatalogCard key={entry.id} entry={entry} />
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
                  <CatalogCard key={entry.id} entry={entry} />
                ))}
              </div>
            </div>
          )}
        </div>
      </AdminContentWrapper>
    </section>
  );
}
