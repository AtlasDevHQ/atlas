"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { postJson, getApiBase, getCredentials } from "@/lib/fetch-json";
import { detectDbLabel } from "@/lib/db-labels";
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
  ShoppingCart,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { SignupShell } from "@/ui/components/signup/signup-shell";

type ConnectionStatus = "idle" | "testing" | "success" | "error";
type DemoAvailability = "unknown" | "available" | "unavailable" | "error";

interface TestResult {
  status?: string;
  latencyMs?: number;
  dbType?: string;
  maskedUrl?: string;
  error?: string;
  message?: string;
}

// Atlas ships a single canonical demo dataset since 1.4.0 (#2021): NovaMart,
// an e-commerce DTC brand with 13 entities (products, orders, customers,
// payments, returns, shipments, sellers, …) and ~480K rows. The previous
// three-card picker (`SaaS CRM` / `Cybersecurity` / `E-commerce`) is gone.
const DEMO = {
  label: "NovaMart (E-commerce)",
  description: "Products, orders, customers, payments, returns, shipments, and sellers.",
  tables: 52,
} as const;

async function runHealthCheck(signal?: AbortSignal): Promise<DemoAvailability> {
  try {
    const res = await fetch(`${getApiBase()}/api/health`, {
      credentials: getCredentials(),
      signal,
    });
    if (!res.ok) throw new Error(`Health check returned ${res.status}`);
    const data = (await res.json()) as { checks?: { datasource?: { status?: string } } };
    return data?.checks?.datasource?.status === "ok" ? "available" : "unavailable";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn("[signup/connect] health check failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return "error";
  }
}

export default function ConnectPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoAvailability, setDemoAvailability] = useState<DemoAvailability>("unknown");
  const [loadingDemo, setLoadingDemo] = useState(false);
  // Aborts any in-flight health check (mount effect or retry click) so stale
  // resolutions can't overwrite a newer result or setState after unmount.
  const healthCheckAbortRef = useRef<AbortController | null>(null);

  // Don't silently hide the demo card on health-check failure — "error" state
  // shows a retry affordance so users can distinguish "demo not configured"
  // from "we couldn't check."
  useEffect(() => {
    const controller = new AbortController();
    healthCheckAbortRef.current = controller;
    runHealthCheck(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDemoAvailability(result);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        console.warn("[signup/connect] unexpected error from health-check:", err);
      });
    return () => controller.abort();
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
      } catch (parseErr) {
        console.debug("[signup/connect] test-connection JSON parse failed:", {
          status: res.status,
          contentType: res.headers.get("content-type"),
          err: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
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
        err instanceof TypeError ? "Unable to reach the server" : "Connection test failed",
      );
    }
  }

  async function handleComplete() {
    if (!url.trim() || connectionStatus !== "success") return;

    setSaving(true);
    setConnectError(null);

    const result = await postJson("/api/v1/onboarding/complete", { url }, {
      fallbackMessage: "Failed to save connection",
    });

    if (!result.ok) {
      setConnectionStatus("error");
      setConnectError(result.error);
      setSaving(false);
      return;
    }

    router.push("/signup/success");
  }

  async function handleUseDemo() {
    setLoadingDemo(true);
    setDemoError(null);

    const result = await postJson("/api/v1/onboarding/use-demo", {}, {
      fallbackMessage: "Failed to set up demo data",
    });

    if (!result.ok) {
      setDemoError(result.error);
      setLoadingDemo(false);
      return;
    }

    router.push("/signup/success");
  }

  async function retryHealthCheck() {
    healthCheckAbortRef.current?.abort();
    const controller = new AbortController();
    healthCheckAbortRef.current = controller;
    setDemoAvailability("unknown");
    try {
      const result = await runHealthCheck(controller.signal);
      if (!controller.signal.aborted) setDemoAvailability(result);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.warn("[signup/connect] unexpected error from health-check retry:", err);
    }
  }

  const dbLabel = url ? detectDbLabel(url) : "Database";
  const anyLoading = saving || loadingDemo;
  const showDemoCard = demoAvailability === "available" || demoAvailability === "error";

  return (
    <SignupShell step="connect" width={showDemoCard ? "xwide" : "default"}>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Get started with your data
        </h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          Connect your own database or explore Atlas with a pre-loaded demo dataset.
        </p>
      </div>

      <div className={cn("grid gap-4", showDemoCard && "md:grid-cols-2")}>
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
                disabled={connectionStatus !== "success" || saving || loadingDemo}
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

        {showDemoCard && (
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
              {demoAvailability === "error" ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                >
                  <span>Couldn&apos;t check demo availability.</span>
                  <Button
                    type="button"
                    onClick={retryHealthCheck}
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 gap-1 border-amber-300 bg-transparent hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900"
                  >
                    <RefreshCw className="size-3" />
                    Retry
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleUseDemo}
                  disabled={anyLoading}
                  aria-label={`Use ${DEMO.label} demo dataset (${DEMO.tables} tables)`}
                  className={cn(
                    "group flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors",
                    "hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted group-hover:bg-primary/10">
                    <ShoppingCart className="size-4 text-muted-foreground group-hover:text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{DEMO.label}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {DEMO.tables} tables
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{DEMO.description}</p>
                  </div>
                  {loadingDemo && (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  )}
                </button>
              )}

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

      <div className="mt-6 flex justify-center">
        <button
          type="button"
          onClick={() => router.push("/signup/success")}
          disabled={anyLoading}
          className="rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          Skip for now — I&apos;ll connect later
        </button>
      </div>
    </SignupShell>
  );
}
