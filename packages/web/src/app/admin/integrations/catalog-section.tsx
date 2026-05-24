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
 * `implementationStatus: "coming_soon"` dominates every other gate per
 * `InstallStatusMachine` (#2740 / ADR-0007). A coming-soon card renders
 * a grey neutral badge + inert "Coming soon" CTA — visually distinct
 * from the purple upsell lock so a customer doesn't read "upgrade to
 * unlock" when the truth is "Atlas hasn't shipped it yet". Slice 9 (#2747).
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
import { Cable, Clock, Lock, Sparkles } from "lucide-react";
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

/**
 * Single catalog card. Exported only for unit tests — production code
 * goes through {@link CatalogSection}. Branches state from
 * `entry.access.kind`, `entry.installStatus`, `entry.installed`, and
 * `entry.implementationStatus` per the comment block inside.
 */
export function CatalogCard({ entry, onInstalled }: CatalogCardProps) {
  // Four visual states a card can land in:
  //   0. coming-soon             — Atlas hasn't shipped the install handler →
  //                                grey neutral badge + inert CTA. Dominates every
  //                                other gate per `resolveInstallStatus` (#2740).
  //   1. accessible              — plan admits + not installed → Connect / Install CTA
  //   2. upgrade-required        — plan does NOT admit + not installed → locked card,
  //                                "Premium — requires <plan>" badge, disabled Upgrade CTA
  //   3. configured-but-downgraded — plan does NOT admit + already installed → Installed
  //                                  badge + warning "Configured but inactive — plan
  //                                  downgrade" + upgrade CTA (Disconnect still works)
  //
  // Post-#2715: the admin-schemas zod transform parses (accessible,
  // upgradeRequired) into a CatalogAccess tagged union — `entry.access`
  // is `{ kind: "accessible" } | { kind: "upgrade"; requiredPlan: PlanTier | null }`.
  // The UI branches on `kind` instead of re-deriving from booleans.
  //
  // `implementationStatus` is optional on the wire (older API responses
  // pre-#2741 omit it). Default to `"available"` so a missing field
  // can never lock a working card to inert.
  const isComingSoon = entry.implementationStatus === "coming_soon";
  const isUpsell = entry.access.kind === "upgrade";
  const requiredPlan =
    entry.access.kind === "upgrade" ? entry.access.requiredPlan : null;
  const isInstalled = entry.installed;
  const isForm = entry.installModel === "form";
  const isOAuth = entry.installModel === "oauth";
  const isDowngraded = isInstalled && isUpsell;
  // `reconnect_needed` is set by the refresh-token flow when a permanent
  // failure (invalid_grant, revoked Connected App, etc.) proves the
  // install can't recover without a fresh OAuth dance. The Reconnect
  // CTA routes through the same /install endpoint as a fresh install
  // — the OAuth callback upserts both the install row and the
  // credential row, so re-running the dance heals the install.
  const needsReconnect = isInstalled && entry.installStatus === "reconnect_needed";
  const [formModalOpen, setFormModalOpen] = useState(false);

  return (
    <Card
      data-testid={`catalog-card-${entry.slug}`}
      data-card-state={
        isComingSoon ? "coming-soon" : isUpsell && !isInstalled ? "upgrade-required" : "accessible"
      }
      className={
        isComingSoon
          ? // Mute slightly more than the upsell card so the visual
            // weight matches the inert CTA. No hover affordance — the
            // card has no interaction; signalling hover would lie.
            "relative transition-colors opacity-80"
          : isUpsell && !isInstalled
            ? "relative transition-colors opacity-90 hover:border-primary/40"
            : "relative transition-colors hover:border-primary/40"
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-1.5 text-base">
            {isComingSoon ? (
              <Clock
                className="size-3.5 text-muted-foreground"
                aria-label="Coming soon"
                data-testid={`catalog-card-${entry.slug}-coming-soon-icon`}
              />
            ) : isUpsell && !isInstalled ? (
              <Lock
                className="size-3.5 text-muted-foreground"
                aria-label="Premium integration"
                data-testid={`catalog-card-${entry.slug}-lock-icon`}
              />
            ) : null}
            {entry.name}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            {isComingSoon ? (
              // Coming soon dominates — `resolveInstallStatus` (#2740)
              // returns `coming_soon` regardless of plan / install / handler
              // state. Render the neutral grey badge alone so a customer
              // doesn't read the premium-lock copy when the truth is
              // "Atlas hasn't shipped this yet".
              <Badge
                variant="secondary"
                className="gap-1 text-[10px]"
                data-testid={`catalog-card-${entry.slug}-coming-soon-badge`}
              >
                <Clock className="size-3" />
                Coming soon
              </Badge>
            ) : (
              <>
                {isDowngraded ? (
                  <Badge
                    variant="destructive"
                    className="text-[10px]"
                    data-testid={`catalog-card-${entry.slug}-downgrade-badge`}
                  >
                    Plan downgrade
                  </Badge>
                ) : needsReconnect ? (
                  <Badge variant="destructive" className="text-[10px]" data-testid={`catalog-card-${entry.slug}-reconnect-badge`}>
                    Reconnect needed
                  </Badge>
                ) : isInstalled ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Installed
                  </Badge>
                ) : null}
                {isUpsell && (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px]"
                    data-testid={`catalog-card-${entry.slug}-plan-badge`}
                  >
                    <Sparkles className="size-3" />
                    Premium — requires {requiredPlan ?? entry.minPlan}
                  </Badge>
                )}
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {entry.description && (
          <p className="text-sm text-muted-foreground">{entry.description}</p>
        )}
        {isDowngraded && (
          // State 3: install row exists but the workspace dropped below
          // the catalog's min_plan. Surface the explanation inline so
          // an admin investigating "why isn't Slack firing?" doesn't
          // have to cross-reference the catalog gate themselves.
          <p
            className="text-xs text-destructive"
            data-testid={`catalog-card-${entry.slug}-downgrade-banner`}
          >
            Configured but inactive — your plan was downgraded below{" "}
            <span className="font-medium">{requiredPlan ?? entry.minPlan}</span>.
            Upgrade to re-enable this integration, or disconnect to clean up.
          </p>
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
                Disconnect / Manage still ship in #2656.
              Coming-soon short-circuits ahead of every install-model
              branch — the row has no handler, so the CTA is inert
              regardless of plan or install presence. */}
          {isComingSoon ? (
            <Button
              size="sm"
              variant="outline"
              disabled
              aria-label={`${entry.name} is coming soon`}
              title="Atlas hasn't shipped this integration yet"
              data-testid={`catalog-card-${entry.slug}-coming-soon-cta`}
            >
              <Clock className="mr-1 size-3" />
              Coming soon
            </Button>
          ) : isUpsell && !isInstalled ? (
            <Button
              size="sm"
              variant="outline"
              disabled
              aria-label={`Available on ${requiredPlan ?? entry.minPlan} plans and above`}
              title={`Available on ${requiredPlan ?? entry.minPlan} plans and above`}
              data-testid={`catalog-card-${entry.slug}-locked-cta`}
            >
              <Lock className="mr-1 size-3" />
              Upgrade
            </Button>
          ) : needsReconnect ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                asChild
                aria-label={`Reconnect ${entry.name}`}
                data-testid={`catalog-card-${entry.slug}-reconnect`}
              >
                <a href={`${getApiUrl()}/api/v1/integrations/${entry.slug}/install`}>
                  Reconnect
                </a>
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
