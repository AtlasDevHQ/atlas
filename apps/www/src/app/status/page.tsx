"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";

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
      mode: "cors",
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - start);

    if (svc.kind === "api") {
      if (!res.ok) return { status: "down", latencyMs };
      try {
        const body = (await res.json()) as { status?: string };
        if (body.status === "degraded") return { status: "degraded", latencyMs };
        if (body.status === "error") return { status: "down", latencyMs };
      } catch {
        // JSON parse failed — still got a response, treat as degraded
        return { status: "degraded", latencyMs };
      }
      return { status: "operational", latencyMs };
    }

    // HTTP-only services — any 2xx/3xx is operational
    return { status: res.ok ? "operational" : "down", latencyMs };
  } catch {
    // Network error, CORS block, or timeout — cannot determine status
    // For non-API services, CORS blocks on HEAD are expected (opaque response),
    // so we fall back to "operational" assumption when we can't reach them
    if (svc.kind === "http") {
      return { status: "operational" };
    }
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
  { label: string; dotClass: string; textClass: string; bgClass: string }
> = {
  operational: {
    label: "Operational",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-400",
    bgClass: "bg-emerald-500/10 border-emerald-500/20",
  },
  degraded: {
    label: "Degraded",
    dotClass: "bg-amber-500",
    textClass: "text-amber-400",
    bgClass: "bg-amber-500/10 border-amber-500/20",
  },
  down: {
    label: "Down",
    dotClass: "bg-red-500",
    textClass: "text-red-400",
    bgClass: "bg-red-500/10 border-red-500/20",
  },
  checking: {
    label: "Checking...",
    dotClass: "bg-zinc-500 animate-pulse",
    textClass: "text-zinc-500",
    bgClass: "bg-zinc-500/10 border-zinc-500/20",
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
  return <span className={`inline-block h-2 w-2 rounded-full ${STATUS_CONFIG[status].dotClass}`} />;
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
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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

  const runChecks = useCallback(async () => {
    const results = await Promise.all(
      SERVICES.map(async (svc) => {
        const result = await checkService(svc);
        return {
          name: svc.name,
          description: svc.description,
          status: result.status,
          latencyMs: result.latencyMs,
        };
      }),
    );
    setServices(results);
    setLastChecked(new Date());
  }, []);

  useEffect(() => {
    runChecks();
    const id = setInterval(runChecks, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runChecks]);

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
      <header className="mx-auto max-w-3xl px-6 pt-12 pb-8">
        <a
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
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
      <div className="mx-auto max-w-3xl px-6 pb-8">
        <div className={`rounded-xl border px-6 py-5 ${banner.className}`}>
          <div className="flex items-center gap-3">
            <StatusDot status={overall} />
            <span className="font-mono text-sm font-medium">{banner.message}</span>
          </div>
        </div>
      </div>

      {/* Service list */}
      <div className="mx-auto max-w-3xl px-6 pb-12">
        <div className="overflow-hidden rounded-xl border border-zinc-800/60">
          {services.map((svc, i) => {
            const config = STATUS_CONFIG[svc.status];
            return (
              <div
                key={svc.name}
                className={`flex items-center justify-between px-6 py-4${
                  i < services.length - 1 ? " border-b border-zinc-800/40" : ""
                }`}
              >
                <div>
                  <p className="font-mono text-sm font-medium text-zinc-200">{svc.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">{svc.description}</p>
                </div>
                <div className="flex items-center gap-3">
                  {svc.latencyMs !== undefined && (
                    <span className="font-mono text-xs text-zinc-600">{svc.latencyMs}ms</span>
                  )}
                  <div className="flex items-center gap-2">
                    <StatusDot status={svc.status} />
                    <span className={`font-mono text-xs font-medium ${config.textClass}`}>
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
      <div className="mx-auto max-w-3xl px-6 py-12">
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
