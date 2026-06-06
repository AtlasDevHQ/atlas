"use client";

import { type ComponentType } from "react";
import {
  CreditCard,
  GitBranch,
  Loader2,
  Network,
  NotebookText,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import { getApiUrl } from "@/lib/api-url";
import { cn } from "@/lib/utils";
import { DATABASE_PROVIDERS, descriptionForDbType, iconForDbType } from "./provider-meta";
import type { CuratedCandidate } from "./curated-install-dialog";

/* ────────────────────────────────────────────────────────────────────────
 *  Add-connection picker — the single entry point for connecting a new
 *  datasource. Replaces the old always-listed "Connect" rows (one per unused
 *  provider) that padded the page out. Three groups:
 *
 *    Databases     — the SQL providers, each → the URL-form connection dialog
 *                    pre-pointed at that dbType.
 *    Popular APIs  — curated REST "data candidates" (Stripe, Notion, GitHub)
 *                    read live from the integrations catalog. Form candidates
 *                    open a one-credential dialog; OAuth candidates redirect.
 *    Custom        — any REST API with an OpenAPI 3.x spec (freeform URL).
 * ──────────────────────────────────────────────────────────────────────── */

/** The curated REST datasources we feature, in display order. Metadata is read
 *  from the catalog at runtime; this map only carries presentation (icon) and
 *  fixes the order. Keyed by catalog slug. */
const CURATED: ReadonlyArray<{ slug: string; icon: LucideIcon }> = [
  { slug: "stripe-data", icon: CreditCard },
  { slug: "notion-data", icon: NotebookText },
  { slug: "github-data", icon: GitBranch },
];
const CURATED_SLUGS = new Set(CURATED.map((c) => c.slug));

function Tile({
  icon: Icon,
  title,
  description,
  onClick,
  disabled,
  badge,
  testId,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "group flex items-start gap-3 rounded-xl border bg-card/40 px-3.5 py-3 text-left transition-colors",
        "hover:border-primary/40 hover:bg-card/80",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-card/40",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold tracking-tight">{title}</span>
          {badge ? (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {badge}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </h3>
  );
}

export function AddConnectionPicker({
  open,
  onOpenChange,
  demoReadOnly,
  onPickDatabase,
  onPickCustomRest,
  onPickCuratedForm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  demoReadOnly: boolean;
  onPickDatabase: (dbType: string) => void;
  onPickCustomRest: () => void;
  /** Form-based curated candidate (paste a key) → opens the curated dialog. */
  onPickCuratedForm: (candidate: CuratedCandidate) => void;
}) {
  // Curated candidates come from the integrations catalog. NOTE: the built-in
  // data candidates (stripe-data / notion-data / github-data) are seeded with
  // `type: "datasource"`, which `GET /api/v1/integrations/catalog` excludes
  // server-side (its facade narrows to `type IN ('chat','integration')`). So
  // this fetch surfaces curated tiles only once a datasource-pillar listing is
  // exposed (a `?pillar=datasource` mode or a dedicated endpoint) — until then
  // the "Popular APIs" group hides itself (see `curated` below). Salesforce
  // (legacy `type: "integration"`) is unaffected; it has its own section.
  // Enabled only while open so the picker doesn't fetch on every page render.
  const catalogQuery = useAdminFetch("/api/v1/integrations/catalog", {
    schema: IntegrationsCatalogResponseSchema,
    enabled: open,
  });

  const bySlug = new Map<string, IntegrationsCatalogEntry>(
    (catalogQuery.data?.catalog ?? [])
      .filter((e) => e.pillar === "datasource" && CURATED_SLUGS.has(e.slug))
      .map((e) => [e.slug, e]),
  );
  // Curated candidates the operator has opted into (enabled in the catalog),
  // in display order. Empty in deploys that haven't enabled any — the whole
  // "Popular APIs" section then hides rather than showing a bare heading.
  const curated = CURATED.map(({ slug, icon }) => {
    const entry = bySlug.get(slug);
    return entry ? { entry, icon } : null;
  }).filter((c): c is { entry: IntegrationsCatalogEntry; icon: LucideIcon } => c !== null);

  function pickDatabase(dbType: string) {
    onOpenChange(false);
    onPickDatabase(dbType);
  }
  function pickCustomRest() {
    onOpenChange(false);
    onPickCustomRest();
  }
  function pickCurated(entry: IntegrationsCatalogEntry) {
    if (entry.installModel === "oauth") {
      // OAuth candidates (e.g. GitHub) start the dance server-side; the
      // callback returns the admin to /admin/connections.
      window.location.href = `${getApiUrl()}/api/v1/integrations/${encodeURIComponent(entry.slug)}/install`;
      return;
    }
    onOpenChange(false);
    onPickCuratedForm({ slug: entry.slug, name: entry.name, description: entry.description });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a datasource</DialogTitle>
          <DialogDescription>
            Connect a database or a REST API. Atlas queries everything read-only; credentials are
            encrypted at rest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section>
            <GroupLabel>Databases</GroupLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {DATABASE_PROVIDERS.map((p) => (
                <Tile
                  key={p.value}
                  icon={iconForDbType(p.value)}
                  title={p.label}
                  description={descriptionForDbType(p.value)}
                  onClick={() => pickDatabase(p.value)}
                  disabled={demoReadOnly}
                  testId={`add-db-${p.value}`}
                />
              ))}
            </div>
          </section>

          {catalogQuery.loading ? (
            <section>
              <GroupLabel>Popular APIs</GroupLabel>
              <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading curated APIs…
              </div>
            </section>
          ) : curated.length > 0 ? (
            <section>
              <GroupLabel>Popular APIs</GroupLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                {curated.map(({ entry, icon }) => {
                  const access = entry.access;
                  const upgrade = access.kind === "upgrade";
                  const comingSoon = entry.implementationStatus === "coming_soon";
                  return (
                    <Tile
                      key={entry.slug}
                      icon={icon}
                      title={entry.name}
                      description={
                        entry.description ??
                        `Query ${entry.name} as a read-only REST datasource.`
                      }
                      badge={
                        entry.installed
                          ? "Connected"
                          : comingSoon
                            ? "Soon"
                            : access.kind === "upgrade" && access.requiredPlan
                              ? `${access.requiredPlan} plan`
                              : entry.installModel === "oauth"
                                ? "OAuth"
                                : undefined
                      }
                      onClick={() => pickCurated(entry)}
                      disabled={demoReadOnly || upgrade || comingSoon}
                      testId={`add-curated-${entry.slug}`}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          <section>
            <GroupLabel>Custom</GroupLabel>
            <Tile
              icon={Network}
              title="Custom REST API"
              description="Any REST service with an OpenAPI 3.x spec — an internal service, or a vendor not listed above."
              onClick={pickCustomRest}
              disabled={demoReadOnly}
              testId="add-custom-rest"
            />
          </section>

          {demoReadOnly ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Plus className="size-3.5" />
              Delete the demo connection or switch to developer mode to add a new one.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
