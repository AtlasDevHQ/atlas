"use client";

/**
 * Per-user trust-grant list rendered below the passkey list on
 * `/admin/settings/security`. Driven off `GET /api/v1/admin/me/trusted-devices`
 * via {@link useAdminFetch}; revoke fans out through {@link useAdminMutation}.
 *
 * Each row shows the derived label ("Mac · Safari"), a "This browser" badge
 * for the row that matches the request's trust cookie, the creation date,
 * and a destructive revoke action. Empty state mirrors the passkey list copy
 * so the two sections feel like siblings rather than competing surfaces.
 */

import { useState } from "react";
import { Loader2, Monitor, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";

export interface TrustedDeviceRow {
  identifier: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

interface ListResponse {
  devices: TrustedDeviceRow[];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function rowTitle(row: TrustedDeviceRow): string {
  if (row.deviceLabel) return row.deviceLabel;
  // Fallback when the hook wrote a row with no UA — better than blanking.
  return "Trusted browser";
}

export function TrustedDevicesList() {
  const { data, loading, error, refetch } = useAdminFetch<ListResponse>(
    "/api/v1/admin/me/trusted-devices",
  );
  const { mutate, isMutating, errorFor, clearErrorFor } = useAdminMutation({
    method: "DELETE",
    invalidates: refetch,
  });
  const [pending, setPending] = useState<TrustedDeviceRow | null>(null);

  const devices = data?.devices ?? [];

  function openConfirm(row: TrustedDeviceRow) {
    // useAdminMutation only clears per-item errors at the start of the SAME
    // itemId's NEXT mutate call — a Cancel-and-reopen (without retry) would
    // otherwise re-render the previous attempt's failure inline before the
    // user clicks Revoke. Clear explicitly so the dialog opens clean.
    clearErrorFor(row.identifier);
    setPending(row);
  }

  function closeConfirm() {
    setPending(null);
  }

  async function handleRevoke() {
    if (!pending) return;
    const result = await mutate({
      path: `/api/v1/admin/me/trusted-devices/${encodeURIComponent(pending.identifier)}`,
      itemId: pending.identifier,
    });
    if (result.ok) {
      closeConfirm();
    }
    // On failure the dialog stays open so the user sees the inline error
    // without losing their place; errorFor(pending.identifier) drives the
    // message under the dialog body.
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Trusted browsers
        </h2>
        <div className="flex items-center gap-2 rounded-lg border bg-card/30 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Trusted browsers
        </h2>
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {friendlyError(error)}
        </p>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Trusted browsers
        </h2>
        <div className="rounded-lg border border-dashed bg-card/30 p-6 text-center">
          <p className="text-sm font-medium">No trusted browsers</p>
          <p className="mt-1 text-xs text-muted-foreground">
            When you check &ldquo;Trust this device&rdquo; on the 2FA challenge,
            it appears here so you can revoke it later.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Trusted browsers
      </h2>
      <ul className="divide-y rounded-lg border bg-card/40">
        {devices.map((row) => {
          const busy = isMutating(row.identifier);
          return (
            <li
              key={row.identifier}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
                  aria-hidden
                >
                  <Monitor className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{rowTitle(row)}</p>
                    {row.isCurrent && (
                      <Badge
                        variant="secondary"
                        className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
                      >
                        This browser
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Trusted {formatDate(row.createdAt)} · expires {formatDate(row.expiresAt)}
                    {row.ipAddress ? ` · ${row.ipAddress}` : ""}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openConfirm(row)}
                disabled={busy}
                aria-label={`Revoke ${rowTitle(row)}`}
                className="text-destructive hover:text-destructive"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              </Button>
            </li>
          );
        })}
      </ul>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this trusted browser?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.isCurrent
                ? "This is your current browser. The next page navigation will require a 2FA challenge."
                : "The next sign-in from this browser will be challenged for 2FA."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && errorFor(pending.identifier) && (
            <p className="px-1 pb-1 text-sm text-destructive">
              {friendlyError(errorFor(pending.identifier)!)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeConfirm}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRevoke();
              }}
              disabled={pending ? isMutating(pending.identifier) : false}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending && isMutating(pending.identifier) ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
