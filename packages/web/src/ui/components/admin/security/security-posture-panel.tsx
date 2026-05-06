"use client";

/**
 * Security-posture panel — top-of-page traffic-light view for workspace
 * MFA + trust-device adoption.
 *
 * Three tiles, one row each:
 *
 *   - "All admins have MFA"        — green when 100% enrolled, amber
 *                                     when partial, red when zero.
 *   - "Backup codes available"      — proxy: TOTP enrolled implies codes
 *                                     were issued by Better Auth; we can't
 *                                     observe code count without a per-user
 *                                     join the workspace endpoint doesn't do.
 *   - "Trust-device adoption"        — informational; counts active grants
 *                                     held by admin/owner members.
 *
 * Sources data from `/api/v1/admin/security/metrics`. Read-only — the
 * panel never mutates anything, it just surfaces the aggregate counts so
 * an admin can answer "do my co-admins actually have MFA?" without
 * writing SQL.
 */

import { ChevronDown, ShieldCheck, ShieldAlert, KeyRound, FileKey } from "lucide-react";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  SecurityBucketsSchema,
  type SecurityBuckets,
} from "@/ui/lib/admin-schemas";
import { friendlyError } from "@/ui/lib/fetch-error";
import { cn } from "@/lib/utils";

type Tone = "green" | "amber" | "red" | "muted";

/**
 * Tile-state discriminated union.
 *
 * Forces every status helper to compute a `tone` consistent with its
 * payload — a green tile cannot accidentally carry "Action required"
 * copy because the union ties the tone to its variant.
 */
type TileStatus =
  | { tone: "green"; headline: string; detail: string }
  | { tone: "amber"; headline: string; detail: string }
  | { tone: "red"; headline: string; detail: string }
  | { tone: "muted"; headline: string; detail: string };

function mfaTileStatus(m: SecurityBuckets): TileStatus {
  if (m.adminCount === 0) {
    return {
      tone: "muted",
      headline: "No admins yet",
      detail:
        "Once you invite a co-admin, this tile reports their MFA enrollment status.",
    };
  }
  if (m.mfaEnrolled === m.adminCount) {
    return {
      tone: "green",
      headline: `All ${m.adminCount} admins have MFA`,
      detail: bucketSummary(m),
    };
  }
  if (m.mfaEnrolled === 0) {
    return {
      tone: "red",
      headline: `0 of ${m.adminCount} admins enrolled`,
      detail:
        "Every admin should enroll a passkey or authenticator app. Without it, password compromise is a workspace-level breach.",
    };
  }
  const remaining = m.adminCount - m.mfaEnrolled;
  return {
    tone: "amber",
    headline: `${m.mfaEnrolled} of ${m.adminCount} admins enrolled`,
    detail: `${remaining} admin${remaining === 1 ? "" : "s"} still need to enroll. ${bucketSummary(m)}`,
  };
}

function bucketSummary(m: SecurityBuckets): string {
  const parts: string[] = [];
  if (m.bothFactors > 0) parts.push(`${m.bothFactors} with both factors`);
  if (m.passkeyOnly > 0) parts.push(`${m.passkeyOnly} passkey-only`);
  if (m.twoFactorOnly > 0) parts.push(`${m.twoFactorOnly} TOTP-only`);
  return parts.length > 0 ? parts.join(" · ") : "No enrolled factors yet.";
}

function backupCodesStatus(m: SecurityBuckets): TileStatus {
  // Backup codes are issued by Better Auth alongside TOTP enrollment, so
  // "TOTP enrolled" is the closest signal we can compute without a per-user
  // join. We deliberately don't claim "X admins HAVE backup codes" — codes
  // can be consumed; the workspace endpoint returns a count of admins with
  // TOTP, not a count of admins with unused codes.
  const totpEnrolled = m.twoFactorOnly + m.bothFactors;
  if (m.adminCount === 0) {
    return {
      tone: "muted",
      headline: "No admins yet",
      detail: "Backup codes are issued during TOTP enrollment.",
    };
  }
  if (totpEnrolled === 0) {
    if (m.passkeyOnly > 0) {
      return {
        tone: "amber",
        headline: "Passkey-only admins have no fallback codes",
        detail:
          "Backup codes pair with an authenticator app. Passkey-only accounts should keep at least one second passkey for recovery.",
      };
    }
    return {
      tone: "red",
      headline: "No backup codes — no MFA enrolled",
      detail: "Backup codes are issued the moment any admin enables TOTP.",
    };
  }
  return {
    tone: "green",
    headline: `${totpEnrolled} admin${totpEnrolled === 1 ? "" : "s"} with TOTP enrolled`,
    detail:
      "Each TOTP enrollment issues backup codes. Admins can rotate them from the Authenticator tile below.",
  };
}

function trustDeviceStatus(m: SecurityBuckets): TileStatus {
  if (m.activeTrustDevices === 0) {
    return {
      tone: "muted",
      headline: "No active trust grants",
      detail:
        "Admins are challenged for 2FA on every sign-in. Opt-in via the \"Trust this browser\" checkbox during a 2FA challenge.",
    };
  }
  return {
    tone: "green",
    headline: `${m.activeTrustDevices} active trust grant${m.activeTrustDevices === 1 ? "" : "s"}`,
    detail: `${m.activeTrustDeviceUsers} distinct admin${m.activeTrustDeviceUsers === 1 ? "" : "s"} skipping the 2FA challenge while their grant is valid.`,
  };
}

const TONE_RING: Record<Tone, string> = {
  green: "ring-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
  amber: "ring-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
  red: "ring-destructive/30 bg-destructive/5 text-destructive",
  muted: "ring-border bg-muted/30 text-muted-foreground",
};

const TONE_DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

const TONE_BADGE: Record<Tone, "default" | "destructive" | "outline" | "secondary"> = {
  green: "outline",
  amber: "outline",
  red: "destructive",
  muted: "secondary",
};

const TONE_LABEL: Record<Tone, string> = {
  green: "OK",
  amber: "Attention",
  red: "Action required",
  muted: "—",
};

interface PostureTileProps {
  title: string;
  icon: React.ReactNode;
  status: TileStatus;
  expandable?: React.ReactNode;
}

function PostureTile({ title, icon, status, expandable }: PostureTileProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "rounded-lg ring-1 transition-colors",
        TONE_RING[status.tone],
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <span
          className={cn(
            "mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-background/60 text-foreground",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span
              className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[status.tone])}
              aria-hidden
            />
            <Badge variant={TONE_BADGE[status.tone]} className="text-[10px] uppercase tracking-wide">
              {TONE_LABEL[status.tone]}
            </Badge>
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">{status.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">{status.detail}</p>
        </div>
        {expandable && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
          </Button>
        )}
      </div>
      {open && expandable && (
        <div className="border-t bg-background/40 px-4 py-3 text-xs">{expandable}</div>
      )}
    </div>
  );
}

export function SecurityPosturePanel() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/admin/security/metrics", {
    schema: SecurityBucketsSchema,
  });

  if (loading) {
    return (
      <Card className="shadow-none">
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    const message = error ? friendlyError(error) : "Could not load security posture.";
    // Only offer Retry when retrying might actually help. 404
    // (`not_available`) means the internal DB isn't configured — pressing
    // Retry will hit the same wall.
    const canRetry = !error || (error.status !== 404 && error.code !== "not_available");
    return (
      <Card className="shadow-none">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Security posture unavailable</p>
            <p className="text-muted-foreground">{message}</p>
          </div>
          {canRetry && (
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const mfaStatus = mfaTileStatus(data);
  const codesStatus = backupCodesStatus(data);
  const trustStatus = trustDeviceStatus(data);

  return (
    <Card className="shadow-none">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Security posture</h2>
            <p className="text-xs text-muted-foreground">
              Aggregate snapshot of admin enrollment in this workspace.
            </p>
          </div>
          <Badge variant="outline" className="font-normal">
            {data.adminCount} admin{data.adminCount === 1 ? "" : "s"}
          </Badge>
        </div>
        <PostureTile
          title="All admins have MFA"
          icon={<ShieldCheck className="size-4" />}
          status={mfaStatus}
          expandable={
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <DetailRow label="Both factors" value={data.bothFactors} />
              <DetailRow label="Passkey only" value={data.passkeyOnly} />
              <DetailRow label="TOTP only" value={data.twoFactorOnly} />
              <DetailRow label="Unenrolled" value={data.noFactors} />
            </dl>
          }
        />
        <PostureTile
          title="Backup codes available"
          icon={<FileKey className="size-4" />}
          status={codesStatus}
        />
        <PostureTile
          title="Trust-device adoption"
          icon={<KeyRound className="size-4" />}
          status={trustStatus}
          expandable={
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <DetailRow label="Active trust grants" value={data.activeTrustDevices} />
              <DetailRow label="Distinct admins" value={data.activeTrustDeviceUsers} />
            </dl>
          }
        />
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
