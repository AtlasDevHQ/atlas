"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Database,
  CheckCircle2,
  XCircle,
  Loader2,
  Shield,
  ShoppingCart,
  Users,
  Sparkles,
} from "lucide-react";

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return isCrossOrigin() ? "include" : "same-origin";
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";
type DemoType = "demo" | "cybersec" | "ecommerce";

interface TestResult {
  status?: string;
  latencyMs?: number;
  dbType?: string;
  maskedUrl?: string;
  error?: string;
  message?: string;
}

interface DemoDataset {
  type: DemoType;
  label: string;
  description: string;
  icon: typeof Database;
  tables: number;
}

const DEMO_DATASETS: DemoDataset[] = [
  { type: "demo",      label: "SaaS CRM",      description: "Companies, contacts, and subscription accounts",      icon: Users,        tables: 3 },
  { type: "cybersec",  label: "Cybersecurity", description: "Vulnerabilities, incidents, compliance, and billing", icon: Shield,       tables: 62 },
  { type: "ecommerce", label: "E-commerce",    description: "Orders, products, customers, shipping, and reviews",  icon: ShoppingCart, tables: 52 },
];

/** Auto-detect database type from URL scheme for display. */
function detectDbLabel(url: string): string {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "PostgreSQL";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "MySQL";
  return "Database";
}

export default function ConnectPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState<DemoType | null>(null);

  useEffect(() => {
    fetch(`${getApiBase()}/api/health`, { credentials: getCredentials() })
      .then((res) => {
        if (!res.ok) throw new Error(`Health check returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data?.checks?.datasource?.status === "ok") {
          setDemoAvailable(true);
        }
      })
      .catch((err) => {
        console.debug("[signup/connect] health check failed:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  async function handleTest() {
    if (!url.trim()) return;

    setConnectionStatus("testing");
    setTestResult(null);
    setConnectError(null);

    try {
      const res = await fetch(`${getApiBase()}/api/v1/onboarding/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({ url }),
      });

      let data: TestResult;
      try {
        data = await res.json();
      } catch {
        setConnectionStatus("error");
        setConnectError("Server returned an unexpected response. Check that the API is running.");
        return;
      }
      setTestResult(data);

      if (res.ok && data.status === "healthy") {
        setConnectionStatus("success");
      } else {
        setConnectionStatus("error");
        setConnectError(data.message ?? "Connection test failed");
      }
    } catch (err) {
      setConnectionStatus("error");
      setConnectError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Connection test failed",
      );
    }
  }

  async function handleComplete() {
    if (!url.trim() || connectionStatus !== "success") return;

    setSaving(true);
    setConnectError(null);

    try {
      const res = await fetch(`${getApiBase()}/api/v1/onboarding/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({ url }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        setConnectError("Server returned an unexpected response. Check that the API is running.");
        return;
      }
      if (!res.ok) {
        setConnectError((data.message as string) ?? "Failed to save connection");
        return;
      }

      router.push("/signup/success");
    } catch (err) {
      setConnectError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Failed to complete setup",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleUseDemo(demoType: DemoType) {
    setLoadingDemo(demoType);
    setDemoError(null);

    try {
      const res = await fetch(`${getApiBase()}/api/v1/onboarding/use-demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({ demoType }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        setDemoError("Server returned an unexpected response.");
        return;
      }
      if (!res.ok) {
        setDemoError((data.message as string) ?? "Failed to set up demo data");
        return;
      }

      router.push("/signup/success");
    } catch (err) {
      setDemoError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Failed to set up demo data",
      );
    } finally {
      setLoadingDemo(null);
    }
  }

  const dbLabel = url ? detectDbLabel(url) : "Database";
  const anyLoading = saving || loadingDemo !== null;

  return (
    <div className={cn("w-full", demoAvailable ? "max-w-4xl" : "max-w-lg")}>
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Database className="size-6 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Get started with your data
        </h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Connect your own database or explore Atlas with a pre-loaded demo dataset.
        </p>
      </div>

      <div
        className={cn(
          "grid gap-4",
          demoAvailable && "md:grid-cols-2",
        )}
      >
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="size-4 text-muted-foreground" />
              Connect your database
            </CardTitle>
            <CardDescription>
              Paste a read-only connection URL. Atlas never modifies your data.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col space-y-4">
            <div className="space-y-2">
              <Label htmlFor="db-url">Connection URL</Label>
              <Input
                id="db-url"
                type="url"
                placeholder="postgresql://user:pass@host:5432/dbname"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setConnectionStatus("idle");
                  setTestResult(null);
                  setConnectError(null);
                }}
                autoFocus
                disabled={anyLoading}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Supports PostgreSQL (<code>postgresql://</code>) and MySQL (<code>mysql://</code>).
              </p>
            </div>

            {connectionStatus === "success" && testResult && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200"
              >
                <CheckCircle2 className="size-4 shrink-0" />
                <span>Connected to {dbLabel} in {testResult.latencyMs}ms</span>
              </div>
            )}

            {(connectionStatus === "error" || connectError) && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              >
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span>{connectError ?? "Connection failed"}</span>
              </div>
            )}

            <div className="mt-auto flex gap-2 pt-2">
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={!url.trim() || connectionStatus === "testing" || anyLoading}
                className="flex-1"
              >
                {connectionStatus === "testing" ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
              <Button
                onClick={handleComplete}
                disabled={connectionStatus !== "success" || saving || loadingDemo !== null}
                className="flex-1"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {demoAvailable && (
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="size-4 text-muted-foreground" />
                Explore demo data
              </CardTitle>
              <CardDescription>
                Try Atlas with a pre-loaded dataset. You can connect your own database later.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col space-y-3">
              <div className="grid gap-2">
                {DEMO_DATASETS.map((ds) => {
                  const isLoading = loadingDemo === ds.type;
                  return (
                    <button
                      key={ds.type}
                      type="button"
                      onClick={() => handleUseDemo(ds.type)}
                      disabled={anyLoading}
                      aria-label={`Use ${ds.label} demo dataset (${ds.tables} tables)`}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors",
                        "hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:pointer-events-none disabled:opacity-50",
                      )}
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted group-hover:bg-primary/10">
                        <ds.icon className="size-4 text-muted-foreground group-hover:text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{ds.label}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {ds.tables} {ds.tables === 1 ? "table" : "tables"}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{ds.description}</p>
                      </div>
                      {isLoading && (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>

              {demoError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                >
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{demoError}</span>
                </div>
              )}

              <p className="mt-auto pt-2 text-xs text-muted-foreground">
                Demo data is pre-loaded and read-only. Perfect for exploring the agent.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="mt-6 flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={() => router.push("/signup/success")}
          disabled={anyLoading}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          Skip for now — I&apos;ll connect later
        </button>
        <StepIndicator current={4} total={5} />
      </div>
    </div>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}
