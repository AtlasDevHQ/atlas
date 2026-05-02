"use client";

import { useState, useEffect } from "react";
import { AtlasChat } from "@useatlas/react";
import { getApiUrl } from "@/lib/api-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  ShieldAlert,
  Activity,
  Users,
  Network,
  ShieldOff,
  Crosshair,
  Database,
  Lock,
  type LucideIcon,
} from "lucide-react";

const DEMO_TOKEN_KEY = "atlas-demo-token";
const DEMO_EMAIL_KEY = "atlas-demo-email";
const DEMO_EXPIRES_KEY = "atlas-demo-expires";

/**
 * Marketing teaser shown on the pre-auth email gate — NOT the chat surface's
 * starter prompts. The chat fetches the live adaptive list from
 * `/api/v1/starter-prompts` once a demo bearer is signed; see #1944.
 */
const DEMO_TEASER_PROMPTS = [
  "Which alerts had the highest severity in the last 7 days?",
  "Show me failed login events grouped by user this week.",
  "What vulnerabilities are unpatched on critical assets?",
  "Top threat actors by alert count.",
] as const;

type DatasetEntry = {
  icon: LucideIcon;
  table: string;
  description: string;
};

const DEMO_DATASET: readonly DatasetEntry[] = [
  { icon: ShieldAlert, table: "alerts", description: "security events with severity, status, and assignee" },
  { icon: Activity, table: "scan_results", description: "vulnerability scan output across assets" },
  { icon: Users, table: "login_events", description: "auth attempts, failures, and session metadata" },
  { icon: Network, table: "assets", description: "hosts, services, and asset groups" },
  { icon: ShieldOff, table: "vulnerabilities", description: "CVEs with remediation status" },
  { icon: Crosshair, table: "threat_actors", description: "known IOCs and threat intelligence" },
];

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function DemoPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(DEMO_TOKEN_KEY);
      const expiresAt = sessionStorage.getItem(DEMO_EXPIRES_KEY);
      if (stored && expiresAt && Number(expiresAt) > Date.now()) {
        setToken(stored);
      } else if (stored) {
        sessionStorage.removeItem(DEMO_TOKEN_KEY);
        sessionStorage.removeItem(DEMO_EXPIRES_KEY);
      }
      const storedEmail = sessionStorage.getItem(DEMO_EMAIL_KEY);
      if (storedEmail) setEmail(storedEmail);
    } catch {
      // intentionally ignored: sessionStorage may be unavailable in some contexts
    }
  }, []);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setError(null);

    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/v1/demo/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Failed to start demo (HTTP ${res.status})`);
        return;
      }

      const data: {
        token: string;
        expiresAt: number;
        returning: boolean;
        conversationCount: number;
      } = await res.json();

      setToken(data.token);
      setReturning(data.returning);

      try {
        sessionStorage.setItem(DEMO_TOKEN_KEY, data.token);
        sessionStorage.setItem(DEMO_EMAIL_KEY, email);
        sessionStorage.setItem(DEMO_EXPIRES_KEY, String(data.expiresAt));
      } catch {
        // intentionally ignored: sessionStorage unavailable — token lives in state only
      }
    } catch (err) {
      console.warn(
        "[Atlas] demo start failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Failed to start demo session",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSignOut() {
    setToken(null);
    try {
      sessionStorage.removeItem(DEMO_TOKEN_KEY);
      sessionStorage.removeItem(DEMO_EMAIL_KEY);
      sessionStorage.removeItem(DEMO_EXPIRES_KEY);
    } catch {
      // intentionally ignored: sessionStorage may be unavailable
    }
  }

  if (!token) {
    return (
      <div className="flex flex-1 flex-col bg-background">
        <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
          <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <svg
              viewBox="0 0 256 256"
              className="size-5 text-primary"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M128 24 L232 208 L24 208 Z"
                stroke="currentColor"
                strokeWidth="14"
                fill="none"
                strokeLinejoin="round"
              />
              <circle cx="128" cy="28" r="16" fill="currentColor" />
            </svg>
            Atlas
          </a>
          <nav className="flex items-center gap-5 text-sm text-muted-foreground">
            <a href="https://docs.useatlas.dev" className="hover:text-foreground">
              Docs
            </a>
            <a href="/login" className="hover:text-foreground">
              Sign in
            </a>
          </nav>
        </header>

        <main className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-10 px-6 py-8 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <section className="flex flex-col gap-6">
            <Badge variant="outline" className="w-fit gap-1.5 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider">
              <span className="size-1.5 rounded-full bg-primary" /> Live demo
            </Badge>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Try Atlas on a real schema.
              </h1>
              <p className="max-w-md text-base text-muted-foreground">
                Ask a cybersecurity sample dataset in plain English. Atlas
                writes the SQL, validates it against the semantic layer, and
                shows the result — no signup, no setup.
              </p>
            </div>

            <form onSubmit={handleStart} className="flex flex-col gap-3" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="demo-email" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Email
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="demo-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    className="sm:max-w-xs"
                  />
                  <Button type="submit" disabled={loading || !email} className="sm:w-auto">
                    {loading ? "Starting..." : "Start demo"}
                    {!loading && <ArrowRight className="ml-1 size-4" />}
                  </Button>
                </div>
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="size-3" aria-hidden="true" />
                24-hour session. Email only used to send Atlas updates.
              </p>
            </form>

            <div className="space-y-2 pt-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Try asking
              </p>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {DEMO_TEASER_PROMPTS.map((prompt) => (
                  <li key={prompt}>
                    <span className="block rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-snug text-muted-foreground">
                      {prompt}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <aside className="flex flex-col gap-3 self-start rounded-xl border border-border/70 bg-muted/30 p-5 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                  <Database className="size-3" aria-hidden="true" />
                  Sample workspace
                </p>
                <h2 className="text-lg font-semibold tracking-tight">
                  Sentinel Security
                </h2>
                <p className="text-xs text-muted-foreground">
                  62 tables, ~500K rows. Realistic SaaS schema with audit
                  log, denormalized reporting tables, and a few legacy
                  artifacts to keep things honest.
                </p>
              </div>
            </div>
            <ul className="grid grid-cols-1 gap-1.5">
              {DEMO_DATASET.map(({ icon: Icon, table, description }) => (
                <li
                  key={table}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-medium">{table}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </main>

        <footer className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5 text-xs text-muted-foreground">
          <span>
            <a href="/" className="hover:text-foreground">
              Powered by Atlas
            </a>{" "}
            · open source.
          </span>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </footer>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2 text-xs sm:px-4 sm:text-sm">
        <p className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Database className="size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
          <span className="truncate">
            {returning ? "Welcome back. " : ""}Demo mode — sample dataset.
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <a
            href="/signup"
            className="hidden font-medium text-primary hover:underline sm:inline"
          >
            Sign up to connect your data
          </a>
          <a
            href="/signup"
            className="font-medium text-primary hover:underline sm:hidden"
          >
            Sign up
          </a>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Exit
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <AtlasChat
          apiUrl={getApiUrl()}
          apiKey={token}
          chatEndpoint="/api/v1/demo/chat"
          conversationsEndpoint="/api/v1/demo/conversations"
          sidebar
        />
      </div>
    </>
  );
}
