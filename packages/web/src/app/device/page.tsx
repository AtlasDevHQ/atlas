"use client";

/**
 * Device authorization approval screen (#4043 / ADR-0026).
 *
 * `atlas login` runs the OAuth 2.0 device flow (RFC 8628): the CLI prints a
 * user code + this page's URL. A signed-in human lands here (the plugin's
 * `verificationUri`), confirms the code, and approves — handing the decision to
 * Better Auth via `authClient.device.approve({ userCode })`. The CLI, polling
 * `/device/token`, then receives a workspace-scoped session bearer stamped
 * `origin='cli'`.
 *
 * Not signed in? We bounce to /login carrying a redirect back to this exact
 * URL (the user code rides in the query string), so the user returns here
 * post-login to finish approving.
 */

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Terminal,
  XCircle,
} from "lucide-react";
import { normalizeUserCode } from "./normalize-user-code";
import { deviceErrorMessage } from "./device-error";

function DeviceApproval() {
  const searchParams = useSearchParams();
  const session = authClient.useSession();

  const [code, setCode] = useState<string>(() =>
    normalizeUserCode(searchParams.get("user_code") ?? ""),
  );
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedCode = normalizeUserCode(code);

  async function submit(decision: "approve" | "deny") {
    if (!trimmedCode) {
      setError("Enter the code shown in your terminal.");
      return;
    }
    const action = decision === "approve" ? authClient.device?.approve : authClient.device?.deny;
    if (!action) {
      setError("Device authorization is unavailable. Please update and try again.");
      return;
    }
    setSubmitting(decision);
    setError(null);
    try {
      const res = await action({ userCode: trimmedCode });
      if (res?.error) {
        setError(deviceErrorMessage(res.error));
        return;
      }
      setOutcome(decision === "approve" ? "approved" : "denied");
    } catch (err) {
      setError(deviceErrorMessage(err));
    } finally {
      setSubmitting(null);
    }
  }

  // ── Loading session ──────────────────────────────────────────────
  if (session.isPending) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  // ── Not signed in → bounce to login, returning to this exact URL ──
  if (!session.data) {
    const returnTo = `/device${trimmedCode ? `?user_code=${encodeURIComponent(trimmedCode)}` : ""}`;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sign in to continue</CardTitle>
          <CardDescription>
            Sign in to Atlas to authorize the device requesting access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href={`/login?redirect=${encodeURIComponent(returnTo)}`}>Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Resolved ─────────────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" aria-hidden />
            Device approved
          </CardTitle>
          <CardDescription>
            You can return to your terminal — the Atlas CLI is now signed in.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (outcome === "denied") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" aria-hidden />
            Request denied
          </CardTitle>
          <CardDescription>
            The device was not authorized. You can close this page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── Approval form ────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-5 text-primary" aria-hidden />
          Authorize the Atlas CLI
        </CardTitle>
        <CardDescription>
          A device is requesting access to your Atlas workspace as{" "}
          <span className="font-medium text-foreground">{session.data.user?.email}</span>. Confirm the
          code shown in your terminal, then approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="user_code">Device code</Label>
          <Input
            id="user_code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter the code from your terminal"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono tracking-widest"
            disabled={submitting !== null}
          />
        </div>

        {error ? (
          <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        <div className="flex gap-3">
          <Button
            type="button"
            className="flex-1"
            onClick={() => submit("approve")}
            disabled={submitting !== null}
          >
            {submitting === "approve" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : "Approve"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => submit("deny")}
            disabled={submitting !== null}
          >
            {submitting === "deny" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : "Deny"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DevicePage() {
  // useSearchParams requires a Suspense boundary for static prerender.
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      }
    >
      <DeviceApproval />
    </Suspense>
  );
}
