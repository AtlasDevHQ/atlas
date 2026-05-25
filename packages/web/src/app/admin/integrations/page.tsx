"use client";

/**
 * `/admin/integrations` — workspace integrations admin.
 *
 * Slice 8 of 1.5.3 (#2746) killed the legacy per-platform card stack
 * (`<SlackCard>`, `<TeamsCard>`, `<DiscordCard>`, …) and consolidated
 * install / disconnect / manage / reconnect onto the catalog flow per
 * ADR-0006 §"One user-facing surface per pillar". The page is now a thin
 * orchestrator: catalog → CatalogSection; OAuth callback toasts → here.
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
 * Human-readable labels for OAuth callback query-param toasts. New
 * platforms must be appended as their slice-6 equivalent wires the
 * Connect button — TS narrowing on `data.<platform>` won't flag a
 * missing entry here, so audit when adding a row.
 */
const PLATFORM_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  discord: "Discord",
};

/**
 * Translate the `reason=` code from the API callback's error redirect
 * into actionable copy. Reasons are stable wire codes (`invalid_state`,
 * `upstream_error`) emitted by `packages/api/src/api/routes/integrations.ts`
 * — keep the cases in lockstep with that file. Unknown reasons fall back
 * to a non-vague but generic message; "Something went wrong" is forbidden
 * per CLAUDE.md.
 */
function translateInstallError(platform: string, reason: string | null): string {
  const platformLabel = PLATFORM_LABEL[platform] ?? platform;
  switch (reason) {
    case "invalid_state":
      return `The ${platformLabel} install session expired or was tampered with. Click Connect to start a fresh install.`;
    case "upstream_error":
      return `${platformLabel} rejected the OAuth handshake. Check the app's redirect URL matches this deploy, then retry.`;
    default:
      return `The ${platformLabel} OAuth callback failed. Click Connect to retry — if the problem persists, check the app credentials.`;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The page only needs the status payload for the live-count badge in the
  // hero and the delivery-channels footer — CatalogSection re-fetches its
  // own copy for the cards. Both calls hit the same in-flight request via
  // the SWR-style dedupe inside useAdminFetch (Cf. #1432).
  const { data, refetch } = useAdminFetch("/api/v1/admin/integrations/status", {
    schema: IntegrationStatusSchema,
  });

  // Holds the platform slug whose success toast is waiting for fresh
  // data — fired in a follow-up effect once the GET reflects the new
  // Connected state (so the toast can surface the team name).
  const [pendingSuccessPlatform, setPendingSuccessPlatform] = useState<string | null>(null);

  // ── OAuth callback query-param toasts ──────────────────────────────
  //
  // The API callback (`/api/v1/integrations/:platform/callback`) lands
  // here with one of `?installed=`, `?reconnect=`, or `?error=&reason=`.
  // Strip the param after firing the toast so a refresh doesn't replay
  // it. Success toasts pause until the fresh GET reflects the new
  // Connected state — that's how we get the team name in the toast.
  useEffect(() => {
    const installed = searchParams.get("installed");
    const reconnect = searchParams.get("reconnect");
    const errParam = searchParams.get("error");
    const reason = searchParams.get("reason");
    if (!installed && !reconnect && !errParam) return;

    if (installed) {
      setPendingSuccessPlatform(installed);
      refetch();
    }
    if (reconnect) {
      const label = PLATFORM_LABEL[reconnect] ?? reconnect;
      toast.warning(`${label} install completed but credentials didn't persist`, {
        description: "Click Reconnect on the card to retry the OAuth dance.",
      });
      refetch();
    }
    if (errParam) {
      const label = PLATFORM_LABEL[errParam] ?? errParam;
      toast.error(`Couldn't connect ${label}`, {
        description: translateInstallError(errParam, reason),
      });
    }
    // Strip query params so a manual refresh doesn't re-fire the toast.
    router.replace("/admin/integrations", { scroll: false });
    // Deps narrow on the serialized search string so a transient render
    // with an unchanged URL doesn't re-trigger. router + refetch are
    // stable references from Next + useAdminFetch and don't need to be
    // listed here.
  }, [searchParams, refetch, router]);

  // Fire the deferred success toast once the GET reports the platform
  // as connected. Reading the team name from the response keeps the
  // toast specific ("Slack connected to TestTeam") rather than generic.
  useEffect(() => {
    if (!pendingSuccessPlatform || !data) return;
    if (pendingSuccessPlatform === "slack" && data.slack?.connected) {
      const workspace = data.slack.workspaceName?.trim();
      toast.success(
        workspace ? `Slack connected to ${workspace}` : "Slack connected successfully",
      );
      setPendingSuccessPlatform(null);
    }
  }, [pendingSuccessPlatform, data]);

  // Hero live-count derives from the status payload — the catalog
  // endpoint doesn't expose per-platform `connected`, only `installed`.
  // Keep the count source consistent with the legacy chrome so the
  // 02 / 05 live badge doesn't jump around mid-deploy.
  const stats = computeLiveStats(data);
  const deliveryChannels = data?.deliveryChannels ?? [];

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
          <CatalogSection />

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

function computeLiveStats(data: ReturnType<typeof useAdminFetch>["data"] | null): LiveStats {
  if (!data || typeof data !== "object") return { live: 0, total: 0 };
  // Narrow via duck-typing — the schema gives us a known IntegrationStatus
  // shape, but the hook returns `unknown` until parsed. This file used to
  // hold the typed access pattern; preserving the same arithmetic so the
  // visible count doesn't drift across the refactor.
  const s = data as {
    slack?: { connected?: boolean; configurable?: boolean };
    teams?: { connected?: boolean; configurable?: boolean };
    discord?: { connected?: boolean; configurable?: boolean };
    telegram?: { connected?: boolean; configurable?: boolean };
    gchat?: { connected?: boolean; configurable?: boolean };
    whatsapp?: { connected?: boolean; configurable?: boolean };
    github?: { connected?: boolean; configurable?: boolean };
    linear?: { connected?: boolean; configurable?: boolean };
    email?: { connected?: boolean; configurable?: boolean };
    webhooks?: { activeCount?: number; configurable?: boolean };
    hasInternalDB?: boolean;
  };
  const hasDB = s.hasInternalDB ?? false;
  const rows: Array<{ connected: boolean; usable: boolean }> = [
    { connected: s.slack?.connected ?? false, usable: (s.slack?.configurable ?? false) || hasDB },
    { connected: s.teams?.connected ?? false, usable: (s.teams?.configurable ?? false) || hasDB },
    { connected: s.discord?.connected ?? false, usable: (s.discord?.configurable ?? false) || hasDB },
    { connected: s.telegram?.connected ?? false, usable: s.telegram?.configurable ?? false },
    { connected: s.gchat?.connected ?? false, usable: s.gchat?.configurable ?? false },
    { connected: s.whatsapp?.connected ?? false, usable: s.whatsapp?.configurable ?? false },
    { connected: s.github?.connected ?? false, usable: s.github?.configurable ?? false },
    { connected: s.linear?.connected ?? false, usable: s.linear?.configurable ?? false },
    { connected: s.email?.connected ?? false, usable: s.email?.configurable ?? false },
    {
      connected: (s.webhooks?.activeCount ?? 0) > 0,
      usable: s.webhooks?.configurable ?? false,
    },
  ];
  return {
    live: rows.filter((r) => r.connected).length,
    total: rows.filter((r) => r.connected || r.usable).length,
  };
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
