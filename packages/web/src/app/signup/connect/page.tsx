"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
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
import { Database, CheckCircle2, XCircle, Loader2 } from "lucide-react";

function getApiBase(): string {
  if (API_URL) return API_URL;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return IS_CROSS_ORIGIN ? "include" : "same-origin";
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";

interface TestResult {
  status?: string;
  latencyMs?: number;
  dbType?: string;
  maskedUrl?: string;
  error?: string;
  message?: string;
}

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
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    if (!url.trim()) return;

    setConnectionStatus("testing");
    setTestResult(null);
    setError(null);

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
        setError("Server returned an unexpected response. Check that the API is running.");
        return;
      }
      setTestResult(data);

      if (res.ok && data.status === "healthy") {
        setConnectionStatus("success");
      } else {
        setConnectionStatus("error");
        setError(data.message ?? "Connection test failed");
      }
    } catch (err) {
      setConnectionStatus("error");
      setError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Connection test failed",
      );
    }
  }

  async function handleComplete() {
    if (!url.trim() || connectionStatus !== "success") return;

    setSaving(true);
    setError(null);

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
        setError("Server returned an unexpected response. Check that the API is running.");
        return;
      }
      if (!res.ok) {
        setError((data.message as string) ?? "Failed to save connection");
        return;
      }

      router.push("/signup/success");
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Failed to complete setup",
      );
    } finally {
      setSaving(false);
    }
  }

  const dbLabel = url ? detectDbLabel(url) : "Database";

  return (
    <Card className="w-full max-w-lg">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Database className="size-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">Connect your database</CardTitle>
        <CardDescription>
          Paste your database connection URL. Atlas connects read-only and never
          modifies your data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
              setError(null);
            }}
            autoFocus
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Supports PostgreSQL (<code>postgresql://</code>) and MySQL (<code>mysql://</code>).
          </p>
        </div>

        {/* Test result indicator */}
        {connectionStatus === "success" && testResult && (
          <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>
              Connected to {dbLabel} in {testResult.latencyMs}ms
            </span>
          </div>
        )}

        {connectionStatus === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error ?? "Connection failed"}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={!url.trim() || connectionStatus === "testing"}
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
            disabled={connectionStatus !== "success" || saving}
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

        <button
          type="button"
          onClick={() => router.push("/signup/success")}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Skip for now — I&apos;ll connect later
        </button>

        <div className="flex justify-center">
          <StepIndicator current={3} total={4} />
        </div>
      </CardContent>
    </Card>
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
