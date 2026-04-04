"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — matches OpenStatus /feed/json response shape
// ---------------------------------------------------------------------------

interface StatusReportUpdate {
  id: number;
  status: string;
  message: string;
  date: string;
}

interface StatusReport {
  id: number;
  title: string;
  status: string; // "investigating" | "identified" | "monitoring" | "resolved"
  updatedAt: string;
  statusReportUpdates: StatusReportUpdate[];
}

interface StatusFeed {
  title: string;
  status: string;
  updatedAt: string;
  statusReports: StatusReport[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll for incidents every 5 minutes */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Fetch timeout */
const FETCH_TIMEOUT_MS = 5_000;

/** Consider fresh for 4min of the 5min interval */
const STALE_TIME_MS = 4 * 60 * 1000;

const ACTIVE_STATUSES = new Set(["investigating", "identified", "monitoring"]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Displays a slim banner when there are active incidents on the OpenStatus
 * status page. Fetches the public JSON feed (no auth required) and polls
 * every 5 minutes via TanStack Query's `refetchInterval`. Renders nothing
 * when there are no active incidents or when the slug is not configured.
 *
 * @param slug - OpenStatus workspace slug (e.g. "atlas"). When falsy, the
 *   banner renders nothing.
 * @param statusUrl - Full URL to the public status page for the "View status"
 *   link. Falls back to `https://{slug}.openstatus.dev`.
 */
export function IncidentBanner({
  slug,
  statusUrl,
}: {
  slug: string | undefined;
  statusUrl?: string;
}) {
  const { data: activeReports = [] } = useQuery<StatusReport[]>({
    queryKey: ["openstatus", slug],
    queryFn: async ({ signal }) => {
      const feedUrl = `https://${slug}.openstatus.dev/feed/json`;
      try {
        const res = await fetch(feedUrl, {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        });
        if (!res.ok) {
          console.debug(`[incident-banner] Feed returned ${res.status}`);
          return [];
        }
        const feed: StatusFeed = await res.json();
        return feed.statusReports.filter((r) => ACTIVE_STATUSES.has(r.status));
      } catch (err) {
        // Feed unavailable — don't show banner. This is expected when
        // the slug isn't configured yet or network is unreachable.
        console.debug(
          "[incident-banner] Feed fetch failed:",
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }
    },
    enabled: !!slug,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: STALE_TIME_MS,
  });

  if (!slug || activeReports.length === 0) return null;

  const href = statusUrl ?? `https://${slug}.openstatus.dev`;
  const mostSevere = activeReports[0]!;
  const isInvestigating = mostSevere.status === "investigating";

  return (
    <div
      role="alert"
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium",
        isInvestigating
          ? "bg-red-500/10 text-red-400 dark:bg-red-500/10 dark:text-red-400"
          : "bg-amber-500/10 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="truncate">
        {activeReports.length === 1
          ? mostSevere.title
          : `${activeReports.length} active incidents`}
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 underline underline-offset-2 hover:opacity-80"
      >
        View status
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
