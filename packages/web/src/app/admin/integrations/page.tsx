"use client";

/**
 * `/admin/integrations` — workspace integrations admin.
 *
 * Slice 8 of 1.5.3 (#2746) killed the legacy per-platform card stack
 * (`<SlackCard>`, `<TeamsCard>`, `<DiscordCard>`, …) and consolidated
 * install / disconnect / manage / reconnect onto the catalog flow per
 * ADR-0006 §"One user-facing surface per pillar". The page is now a thin
 * orchestrator: catalog + status → CatalogSection; OAuth callback toasts → here.
 *
 * The status payload (`/api/v1/admin/integrations/status`) is fetched
 * once here and threaded into CatalogSection. This avoids the double-fetch
 * of an earlier draft (page.tsx and catalog-section each held their own
 * `useAdminFetch` call), and centralizes the recovery surface for status
 * failures: a single inline error banner here covers the live-count + the
 * detail rows + the BYOT eligibility signal, all of which depend on it.
 *
 * Why the page keeps the OAuth callback effect even though everything
 * else moved into CatalogSection: the API callback at
 * `/api/v1/integrations/:platform/callback` lands here with `?installed=`
 * / `?reconnect=` / `?error=&reason=` query params, and the page is the
 * one place that owns `useSearchParams` + `router.replace` after firing
 * the toast. Wiring this through CatalogSection would couple it to the
 * URL, which it has no other reason to touch.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { IntegrationStatusSchema } from "@/ui/lib/admin-schemas";
import type { IntegrationStatus } from "@useatlas/types";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { CatalogSection } from "./catalog-section";
import { SectionHeading } from "@/ui/components/admin/compact";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Cable,
  Mail,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Phone,
  Send,
  Users,
  Webhook,
} from "lucide-react";

// ---------------------------------------------------------------------------
// OAuth callback helpers
// ---------------------------------------------------------------------------

/**
 * Platforms whose OAuth install flow lands back on this page. Adding a
 * new OAuth platform requires appending it here so the toast surfaces a
 * human-readable label rather than the raw slug. The `as const` keeps
 * the keys narrowed so a future `Record` keyed on this union stays
 * exhaustive — see {@link translateInstallError} fallback for the path
 * an unknown slug takes.
 */
const PLATFORM_LABEL = {
  slack: "Slack",
  teams: "Microsoft Teams",
  discord: "Discord",
} as const;
type LabeledPlatform = keyof typeof PLATFORM_LABEL;

function platformLabel(slug: string): string {
  return (PLATFORM_LABEL as Record<string, string>)[slug] ?? slug;
}

/**
 * Translate the `reason=` code from the API callback's error redirect
 * into actionable copy. Reasons are stable wire codes (`invalid_state`,
 * `upstream_error`) emitted by `packages/api/src/api/routes/integrations.ts`
 * — keep the cases in lockstep with that file. Unknown reasons fall back
 * to a non-vague but generic message; "Something went wrong" is forbidden
 * per CLAUDE.md. The dev-mode `console.warn` exists so a new server-side
 * reason code that lands without a UI update doesn't silently degrade to
 * the generic message — same class of failure the chat-plugin contract
 * audit (#2677) called out.
 */
function translateInstallError(platform: string, reason: string | null): string {
  const label = platformLabel(platform);
  switch (reason) {
    case "invalid_state":
      return `The ${label} install session expired or was tampered with. Click Connect to start a fresh install.`;
    case "upstream_error":
      return `${label} rejected the OAuth handshake. Check the app's redirect URL matches this deploy, then retry.`;
    case "plan_limit_reached":
      // #2953 — workspace at its plan's chat-integration cap. The API
      // refused the install before writing anything; the fix is to upgrade,
      // not retry.
      return `Your plan's chat-integration limit is reached, so ${label} couldn't be connected. Upgrade your plan or remove another integration, then try again.`;
    default:
      if (reason && process.env.NODE_ENV !== "production") {
        console.warn(
          "[admin/integrations] translateInstallError: unknown reason code",
          { platform, reason },
        );
      }
      return `The ${label} OAuth callback failed. Click Connect to retry — if the problem persists, check the app credentials.`;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Single fetch of `/api/v1/admin/integrations/status` for the entire
  // page surface. The data + error are threaded into CatalogSection so a
  // status failure surfaces once, in one place, rather than each card
  // silently degrading on its own.
  const statusQuery = useAdminFetch("/api/v1/admin/integrations/status", {
    schema: IntegrationStatusSchema,
  });
  const status = statusQuery.data ?? null;
  // Destructure `refetch` outside the effect so the dep array references a
  // stable function rather than the whole `statusQuery` object (which is a
  // new identity each render and would re-fire the effect needlessly).
  const refetchStatus = statusQuery.refetch;

  // Holds the platform slug whose success toast is waiting for fresh
  // data — fired in a follow-up effect once the GET reflects the new
  // Connected state (so the toast can surface the team name).
  const [pendingSuccessPlatform, setPendingSuccessPlatform] = useState<LabeledPlatform | null>(null);

  // ── OAuth callback query-param toasts ──────────────────────────────
  //
  // The API callback (`/api/v1/integrations/:platform/callback`) lands
  // here with one of `?installed=`, `?reconnect=`, or `?error=&reason=`.
  // Strip those four params after firing the toast so a refresh doesn't
  // replay; preserve any other params (future tab anchors etc.). Success
  // toasts pause until the fresh GET reflects the new Connected state —
  // that's how we get the team name in the toast.
  useEffect(() => {
    const installed = searchParams.get("installed");
    const reconnect = searchParams.get("reconnect");
    const errParam = searchParams.get("error");
    const reason = searchParams.get("reason");
    if (!installed && !reconnect && !errParam) return;

    if (installed) {
      setPendingSuccessPlatform(asLabeledPlatform(installed));
      refetchStatus();
    }
    if (reconnect) {
      toast.warning(`${platformLabel(reconnect)} install completed but credentials didn't persist`, {
        description: "Click Reconnect on the card to retry the OAuth dance.",
      });
      refetchStatus();
    }
    if (errParam) {
      toast.error(`Couldn't connect ${platformLabel(errParam)}`, {
        description: translateInstallError(errParam, reason),
      });
    }
    // Strip only the four callback keys, preserve everything else — no
    // route on this page reads other params today, but future tab anchors
    // shouldn't get wiped by a successful OAuth round-trip.
    const next = new URLSearchParams(searchParams);
    for (const key of ["installed", "reconnect", "error", "reason"]) next.delete(key);
    const url = next.size > 0 ? `/admin/integrations?${next.toString()}` : "/admin/integrations";
    router.replace(url, { scroll: false });
    // Deps narrow on the serialized search string so a transient render
    // with an unchanged URL doesn't re-trigger. router + refetchStatus are
    // stable references from Next + useAdminFetch.
  }, [searchParams, refetchStatus, router]);

  // Fire the deferred success toast once the GET reports the platform
  // as connected. Reading the team name from the response keeps the
  // toast specific ("Slack connected to TestTeam") rather than generic.
  useEffect(() => {
    if (!pendingSuccessPlatform || !status) return;
    if (pendingSuccessPlatform === "slack" && status.slack.connected) {
      const workspace = status.slack.workspaceName?.trim();
      toast.success(
        workspace ? `Slack connected to ${workspace}` : "Slack connected successfully",
      );
      setPendingSuccessPlatform(null);
    }
  }, [pendingSuccessPlatform, status]);

  // Hero live-count derives from the status payload — the catalog
  // endpoint doesn't expose per-platform `connected`, only `installed`.
  // Keep the count source consistent with the legacy chrome so the
  // 02 / 05 live badge doesn't jump around mid-deploy.
  const stats = computeLiveStats(status);
  const deliveryChannels = status?.deliveryChannels ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(stats.live > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(stats.live).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(stats.total).padStart(2, "0")} live
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          External platforms Atlas can read from, write to, or deliver through.
        </p>
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={false}
          error={null}
          feature="Integrations"
          loadingMessage="Loading integrations..."
          emptyIcon={Cable}
          emptyTitle="No integrations"
          emptyDescription="Integration status could not be loaded."
          isEmpty={false}
        >
          <CatalogSection
            status={status}
            statusError={statusQuery.error}
            onChange={statusQuery.refetch}
          />

          {deliveryChannels.length > 0 && (
            <section className="mt-10">
              <SectionHeading
                title="Delivery Channels"
                description="Currently available for task delivery"
              />
              <div className="flex flex-wrap items-center gap-2">
                {deliveryChannels.map((channel) => (
                  <span
                    key={channel}
                    className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] capitalize text-foreground"
                  >
                    <ChannelIcon channel={channel} />
                    {channel}
                  </span>
                ))}
              </div>
            </section>
          )}
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LiveStats {
  readonly live: number;
  readonly total: number;
}

/**
 * Live + total counts for the hero badge. Counts every platform whose
 * status row says `connected` (or `activeCount > 0` for webhooks); total
 * counts the same plus configurable-but-not-connected. Source of truth is
 * the schema-parsed `IntegrationStatus` — adding a platform there will
 * surface here as a missing-property type error.
 */
function computeLiveStats(s: IntegrationStatus | null): LiveStats {
  if (!s) return { live: 0, total: 0 };
  const hasDB = s.hasInternalDB;
  const rows: ReadonlyArray<{ connected: boolean; usable: boolean }> = [
    { connected: s.slack.connected, usable: s.slack.configurable || hasDB },
    { connected: s.teams.connected, usable: s.teams.configurable || hasDB },
    { connected: s.discord.connected, usable: s.discord.configurable || hasDB },
    { connected: s.telegram.connected, usable: s.telegram.configurable },
    { connected: s.gchat.connected, usable: s.gchat.configurable },
    { connected: s.whatsapp.connected, usable: s.whatsapp.configurable },
    { connected: s.github.connected, usable: s.github.configurable },
    { connected: s.linear.connected, usable: s.linear.configurable },
    { connected: s.email.connected, usable: s.email.configurable },
    { connected: s.webhooks.activeCount > 0, usable: s.webhooks.configurable },
  ];
  return {
    live: rows.filter((r) => r.connected).length,
    total: rows.filter((r) => r.connected || r.usable).length,
  };
}

function asLabeledPlatform(slug: string): LabeledPlatform | null {
  return slug in PLATFORM_LABEL ? (slug as LabeledPlatform) : null;
}

function ChannelIcon({ channel }: { channel: string }) {
  switch (channel) {
    case "slack":
      return <MessageSquare className="size-3" />;
    case "teams":
      return <Users className="size-3" />;
    case "discord":
      return <MessageCircle className="size-3" />;
    case "telegram":
      return <Send className="size-3" />;
    case "gchat":
      return <MessageSquareText className="size-3" />;
    case "github":
      return <BarChart3 className="size-3" />;
    case "linear":
      return <BarChart3 className="size-3" />;
    case "whatsapp":
      return <Phone className="size-3" />;
    case "webhook":
      return <Webhook className="size-3" />;
    case "email":
      return <Mail className="size-3" />;
    default:
      return <Cable className="size-3" />;
  }
}
