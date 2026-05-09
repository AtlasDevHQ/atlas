"use client";

/**
 * `/settings/profile` → Active sessions section.
 *
 * Lists the signed-in user's own sessions via `GET /api/v1/sessions` (the
 * user-scoped self-service route, distinct from the admin-wide
 * `/api/v1/admin/sessions` which is org-wide). Per-row revoke calls
 * `DELETE /api/v1/sessions/:id`; "Sign out everywhere" iterates the
 * non-current rows so a single network failure on one session doesn't
 * abandon the rest.
 *
 * The current session is identified by `session.data.session.id`. Better
 * Auth doesn't return whether a row is the current one in the list payload,
 * so the comparison happens client-side.
 */

import { useMemo, useState } from "react";
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
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
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

/**
 * Pull a friendly device label out of the user-agent string.
 * Browser detection is intentionally narrow — we only care about the most
 * common four (Safari, Chrome, Firefox, Edge); anything else falls through
 * to "Browser" so we don't render a wall of UA cruft.
 */
export function summarizeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = (() => {
    if (/Edg\//.test(ua)) return "Edge";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "Chrome";
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
    return "Browser";
  })();
  const os = (() => {
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    if (/Windows/.test(ua)) return "Windows";
    if (/Mac OS X/.test(ua)) return "macOS";
    if (/Linux/.test(ua)) return "Linux";
    return "Unknown";
  })();
  return `${os} · ${browser}`;
}

export function SessionsSection() {
  const session = authClient.useSession();
  // The session payload carries a `session.id` field at runtime; cast to
  // read it without widening AtlasAuthClient. May be undefined while the
  // session is still loading.
  const currentSessionId = (session.data?.session as { id?: string } | undefined)?.id;

  const { data, loading, error, refetch } = useAdminFetch("/api/v1/sessions", {
    schema: SessionsResponseSchema,
  });

  const sessions = useMemo<SessionRow[]>(() => data?.sessions ?? [], [data]);

  const { mutate: revokeMutate, error: revokeError } = useAdminMutation<{
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
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
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
                return (
                  <li
                    key={s.id}
                    className="flex items-start justify-between gap-3 px-3 py-3"
                  >
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
                  </li>
                );
              })}
            </ul>

            {revokeError && (
              <p role="alert" className="text-sm text-destructive">
                {revokeError.message ?? "Couldn't revoke session."}
              </p>
            )}
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
