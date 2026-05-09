"use client";

/**
 * `/settings/profile` → Active sessions section.
 *
 * Lists the signed-in user's own sessions via `GET /api/v1/sessions` (user-
 * scoped; distinct from the org-wide `/api/v1/admin/sessions`). Bulk
 * sign-out uses `Promise.allSettled` so one failed revoke doesn't abandon
 * the rest. Better Auth doesn't flag the current session in the list, so
 * the comparison is client-side against `session.data.session.id`.
 */

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, LogOut, Monitor, Trash2 } from "lucide-react";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { SectionHeading } from "@/ui/components/admin/compact";

const SessionRowSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

const SessionsResponseSchema = z.object({
  sessions: z.array(SessionRowSchema),
});

type SessionRow = z.infer<typeof SessionRowSchema>;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Order matters: Edge before Chrome (Edge UA contains "Chrome"); Chrome
// before Safari (Chrome UA contains "Safari").
const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const OS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

/**
 * Friendly device label from a user-agent. Detection is intentionally
 * narrow — anything outside the common four browsers / five OSes falls
 * through to "Browser" / "Unknown" so the list never renders raw UA cruft.
 */
export function summarizeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = BROWSER_PATTERNS.find(([re]) => re.test(ua))?.[1] ?? "Browser";
  const os = OS_PATTERNS.find(([re]) => re.test(ua))?.[1] ?? "Unknown";
  return `${os} · ${browser}`;
}

export function SessionsSection() {
  const session = authClient.useSession();
  // Better Auth's typed session covers `id` as a base field, but the
  // plugin-wrapped client occasionally erases the inferred shape — narrow
  // here without leaking the cast across the file.
  const currentSessionId = (session.data?.session as { id?: string } | undefined)?.id;

  const { data, loading, error, refetch } = useAdminFetch("/api/v1/sessions", {
    schema: SessionsResponseSchema,
  });

  const sessions: SessionRow[] = data?.sessions ?? [];

  const { mutate: revokeMutate, errorFor } = useAdminMutation<{
    success: boolean;
  }>({
    method: "DELETE",
    invalidates: refetch,
  });

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [bulkSigningOut, setBulkSigningOut] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await revokeMutate({ path: `/api/v1/sessions/${id}`, itemId: id });
    } finally {
      setRevokingId(null);
    }
  }

  async function handleSignOutEverywhere() {
    setBulkError(null);
    setBulkSigningOut(true);
    try {
      const targets = sessions.filter((s) => s.id !== currentSessionId);
      const results = await Promise.allSettled(
        targets.map((s) => revokeMutate({ path: `/api/v1/sessions/${s.id}`, itemId: s.id })),
      );
      // `useAdminMutation.mutate()` resolves with `{ ok: false }` on HTTP
      // failure rather than rejecting — Promise.allSettled would otherwise
      // count every failure as a fulfilled (success) entry.
      const failed = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok),
      ).length;
      if (failed > 0) {
        setBulkError(`Couldn't sign out ${failed} of ${targets.length} sessions.`);
      }
    } finally {
      setBulkSigningOut(false);
    }
  }

  const otherCount = sessions.filter((s) => s.id !== currentSessionId).length;

  return (
    <section>
      <SectionHeading
        title="Active sessions"
        description="Each browser or device that's signed in to Atlas with your account."
      />
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {loading && <LoadingState message="Loading sessions..." />}

        {error && (
          <ErrorBanner
            message={
              error.status === 404
                ? "Session management isn't available in this auth mode."
                : error.message ?? "Couldn't load sessions."
            }
            onRetry={refetch}
          />
        )}

        {!loading && !error && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        )}

        {sessions.length > 0 && (
          <>
            <ul className="divide-y rounded-md border bg-background">
              {sessions.map((s) => {
                const isCurrent = s.id === currentSessionId;
                const isRevoking = revokingId === s.id;
                const rowError = errorFor(s.id);
                return (
                  <li
                    key={s.id}
                    className="flex flex-col gap-1 px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {summarizeUserAgent(s.userAgent)}
                            </span>
                            {isCurrent && (
                              <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                                This session
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {s.ipAddress ?? "Unknown IP"} · last active {formatDate(s.updatedAt)}
                          </p>
                        </div>
                      </div>
                      {!isCurrent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { void handleRevoke(s.id); }}
                          disabled={isRevoking}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Revoke ${summarizeUserAgent(s.userAgent)}`}
                        >
                          {isRevoking ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                    {rowError && (
                      <p
                        role="alert"
                        className="ml-7 text-xs text-destructive"
                      >
                        {rowError.message ?? "Couldn't revoke this session."}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            {bulkError && (
              <p role="alert" className="text-sm text-destructive">
                {bulkError}
              </p>
            )}

            {otherCount > 0 && (
              <div className="flex justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={bulkSigningOut}>
                      {bulkSigningOut ? (
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      ) : (
                        <LogOut className="mr-1.5 size-3.5" />
                      )}
                      Sign out other sessions ({otherCount})
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Sign out {otherCount} other session{otherCount === 1 ? "" : "s"}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Anyone signed in to your account on another device will be signed out
                        immediately. This session stays signed in.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={bulkSigningOut}>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => { void handleSignOutEverywhere(); }}>
                        Sign out
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
