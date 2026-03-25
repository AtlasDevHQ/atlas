"use client";

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatus = "operational" | "degraded" | "down" | "checking";

interface ServiceState {
  name: string;
  description: string;
  status: ServiceStatus;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

const SERVICES: { name: string; description: string; url: string; kind: "api" | "http" }[] = [
  {
    name: "API",
    description: "Core API and agent engine",
    url: "https://api.useatlas.dev/api/health",
    kind: "api",
  },
  {
    name: "Web App",
    description: "Atlas Cloud dashboard",
    url: "https://app.useatlas.dev",
    kind: "http",
  },
  {
    name: "Documentation",
    description: "Docs and reference",
    url: "https://docs.useatlas.dev",
    kind: "http",
  },
  {
    name: "Landing Page",
    description: "Marketing site",
    url: "https://useatlas.dev",
    kind: "http",
  },
];

// ---------------------------------------------------------------------------
// Health check logic
// ---------------------------------------------------------------------------

async function checkService(
  svc: (typeof SERVICES)[number],
): Promise<{ status: ServiceStatus; latencyMs?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const start = performance.now();
    const res = await fetch(svc.url, {
      method: svc.kind === "http" ? "HEAD" : "GET",
      signal: controller.signal,
      // no-cors for HTTP services: returns opaque response (status 0) when
      // reachable, throws on genuine network failure. Avoids false positives
      // from CORS preflight blocks on cross-origin HEAD requests.
      mode: svc.kind === "http" ? "no-cors" : "cors",
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - start);

    // no-cors produces opaque responses — a successful fetch means reachable
    if (svc.kind === "http") {
      return { status: "operational", latencyMs };
    }

    // API health endpoint — expects { status: "ok" | "degraded" | "error" }
    // per HealthResponseSchema in packages/api/src/api/routes/health.ts
    if (!res.ok) return { status: "down", latencyMs };
    try {
      const body = (await res.json()) as { status?: string };
      if (body.status === "ok") return { status: "operational", latencyMs };
      if (body.status === "degraded") return { status: "degraded", latencyMs };
      // Any unrecognized status (including "error", though !res.ok catches 503)
      return { status: "degraded", latencyMs };
    } catch (err) {
      console.debug(
        `[status] JSON parse failed for ${svc.name}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { status: "degraded", latencyMs };
    }
  } catch (err) {
    console.debug(
      `[status] Health check failed for ${svc.name}:`,
      err instanceof Error ? err.message : String(err),
    );
    // Timeout means unresponsive — that's down regardless of service type
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "down" };
    }
    // For API, any network error is down. For HTTP with no-cors, a thrown
    // error means the server is genuinely unreachable (not just CORS).
    return { status: "down" };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Derived overall status
// ---------------------------------------------------------------------------

function deriveOverallStatus(services: ServiceState[]): ServiceStatus {
  if (services.some((s) => s.status === "checking")) return "checking";
  if (services.some((s) => s.status === "down")) return "down";
  if (services.some((s) => s.status === "degraded")) return "degraded";
  return "operational";
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  ServiceStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  operational: {
    label: "Operational",
    dotClass: "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]",
    textClass: "text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    dotClass: "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)]",
    textClass: "text-amber-400",
  },
  down: {
    label: "Down",
    dotClass: "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]",
    textClass: "text-red-400",
  },
  checking: {
    label: "Checking...",
    dotClass: "bg-zinc-500 animate-pulse",
    textClass: "text-zinc-500",
  },
};

const OVERALL_BANNERS: Record<ServiceStatus, { message: string; className: string }> = {
  operational: {
    message: "All systems operational",
    className: "border-emerald-500/20 bg-emerald-500/5 text-emerald-400",
  },
  degraded: {
    message: "Some systems experiencing issues",
    className: "border-amber-500/20 bg-amber-500/5 text-amber-400",
  },
  down: {
    message: "System outage detected",
    className: "border-red-500/20 bg-red-500/5 text-red-400",
  },
  checking: {
    message: "Checking system status...",
    className: "border-zinc-700 bg-zinc-900/50 text-zinc-500",
  },
};

function StatusDot({ status }: { status: ServiceStatus }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full transition-colors duration-500 ${STATUS_CONFIG[status].dotClass}`}
    />
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// SVG icons (inline, matching landing page pattern)
// ---------------------------------------------------------------------------

function AtlasLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" fill="none" className={className} aria-hidden="true">
      <path
        d="M128 24 L232 208 L24 208 Z"
        stroke="currentColor"
        strokeWidth="14"
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="128" cy="28" r="16" fill="currentColor" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg
      className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StatusPage() {
  const [services, setServices] = useState<ServiceState[]>(
    SERVICES.map((s) => ({ name: s.name, description: s.description, status: "checking" })),
  );
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  useEffect(() => {
    async function runChecks() {
      try {
        const results = await Promise.all(
          SERVICES.map(async (svc) => ({
            name: svc.name,
            description: svc.description,
            ...(await checkService(svc)),
          })),
        );
        setServices(results);
        setLastChecked(new Date());
      } catch (err) {
        console.warn(
          "[status] Health check polling failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    runChecks();
    const id = setInterval(runChecks, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const overall = deriveOverallStatus(services);
  const banner = OVERALL_BANNERS[overall];

  return (
    <div className="relative min-h-screen">
      {/* Top gradient glow — matching landing page */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -z-10 h-[600px] w-[800px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, color-mix(in oklch, var(--atlas-brand) 6%, transparent) 0%, transparent 70%)",
        }}
      />

      {/* Header */}
      <header className="animate-fade-in-up mx-auto max-w-3xl px-6 pt-12 pb-8">
        <a
          href="/"
          className="group mb-8 inline-flex items-center gap-2 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
        >
          <ArrowLeftIcon />
          Back to Atlas
        </a>
        <div className="flex items-center gap-3">
          <AtlasLogo className="h-5 w-5 text-brand/60" />
          <h1 className="font-mono text-lg font-medium tracking-wide text-zinc-100">
            System Status
          </h1>
        </div>
      </header>

      {/* Overall status banner */}
      <div className="animate-fade-in-up delay-100 mx-auto max-w-3xl px-6 pb-8">
        <div
          className={`rounded-xl border px-6 py-5 transition-colors duration-500 ${banner.className}`}
        >
          <div className="flex items-center gap-3">
            <StatusDot status={overall} />
            <span className="font-mono text-sm font-medium">{banner.message}</span>
          </div>
        </div>
      </div>

      {/* Service list */}
      <div className="animate-fade-in-up delay-200 mx-auto max-w-3xl px-6 pb-12">
        <div className="overflow-hidden rounded-xl border border-zinc-800/60">
          {services.map((svc, i) => {
            const config = STATUS_CONFIG[svc.status];
            return (
              <div
                key={svc.name}
                className={`flex items-center justify-between gap-4 px-6 py-4 transition-colors duration-150 hover:bg-zinc-900/30${
                  i < services.length - 1 ? " border-b border-zinc-800/40" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-zinc-200">{svc.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">{svc.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {svc.latencyMs !== undefined && (
                    <span className="hidden font-mono text-xs text-zinc-600 sm:inline">
                      {svc.latencyMs}ms
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <StatusDot status={svc.status} />
                    <span
                      className={`font-mono text-xs font-medium transition-colors duration-500 ${config.textClass}`}
                    >
                      {config.label}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Last checked */}
        {lastChecked && (
          <p className="mt-4 text-right font-mono text-xs text-zinc-600">
            Last checked {formatTime(lastChecked)} · refreshes every 30s
          </p>
        )}
      </div>

      {/* Divider */}
      <div className="mx-auto max-w-3xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      </div>

      {/* Incident history */}
      <div className="animate-fade-in delay-300 mx-auto max-w-3xl px-6 py-12">
        <h2 className="mb-6 font-mono text-xs tracking-widest text-brand/80 uppercase">
          Incident History
        </h2>
        <div className="rounded-xl border border-zinc-800/60 px-6 py-10 text-center">
          <p className="font-mono text-sm text-zinc-500">No incidents reported</p>
          <p className="mt-1 text-xs text-zinc-600">
            Past incidents and maintenance windows will appear here.
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="mx-auto max-w-3xl px-6 pb-12">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
        <div className="flex items-center justify-between pt-8">
          <div className="flex items-center gap-2">
            <AtlasLogo className="h-4 w-4 text-brand/60" />
            <span className="font-mono text-sm text-zinc-600">atlas</span>
          </div>
          <a
            href="/"
            className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
          >
            useatlas.dev
          </a>
        </div>
      </footer>
    </div>
  );
}
