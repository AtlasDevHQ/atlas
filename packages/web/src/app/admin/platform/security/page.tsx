"use client";

/**
 * Platform admin → Security adoption (#2094).
 *
 * Cross-workspace MFA + passkey + trust-device dashboard. Surfaces the
 * aggregate counts from `/api/v1/platform/admin/security/metrics` and a
 * per-workspace breakdown so a platform admin can answer:
 *
 *   - Is passkey adoption uniform across the SaaS or concentrated in
 *     a few workspaces?
 *   - Which workspaces have admins who haven't enrolled any factor?
 *   - How many admins are leaning on the trust-device cookie vs
 *     re-authenticating per session?
 *
 * The page is rendered on the Next.js side (not the Hono admin router)
 * — gated client-side via `usePlatformAdminGuard`. The API endpoint is
 * what enforces the platform_admin role; this guard is a redirect-shim
 * so non-platform users don't load the bundle.
 */

import { ShieldCheck, ShieldAlert, KeyRound, Users, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import {
  PlatformSecurityMetricsSchema,
  type WorkspaceSecurityMetrics,
} from "@/ui/lib/admin-schemas";

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function enrollmentRow(ws: WorkspaceSecurityMetrics): {
  rate: number;
  tone: "green" | "amber" | "red" | "muted";
} {
  if (ws.adminCount === 0) return { rate: 0, tone: "muted" };
  const rate = pct(ws.mfaEnrolled, ws.adminCount);
  if (rate === 100) return { rate, tone: "green" };
  if (rate === 0) return { rate, tone: "red" };
  return { rate, tone: "amber" };
}

const TONE_BADGE: Record<"green" | "amber" | "red" | "muted", "default" | "destructive" | "outline" | "secondary"> = {
  green: "outline",
  amber: "outline",
  red: "destructive",
  muted: "secondary",
};

const TONE_TEXT: Record<"green" | "amber" | "red" | "muted", string> = {
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-destructive",
  muted: "text-muted-foreground",
};

export default function PlatformSecurityPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return <PlatformSecurityContent />;
}

function PlatformSecurityContent() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/platform/admin/security/metrics",
    { schema: PlatformSecurityMetricsSchema },
  );

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Security Adoption"
      onRetry={refetch}
      loadingMessage="Loading security metrics..."
    >
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Security Adoption</h1>
          <p className="text-muted-foreground">
            Cross-workspace MFA, passkey, and trust-device adoption telemetry.
          </p>
        </div>

        {data ? (
          <>
            <SummaryCards data={data} />
            <FactorDistribution data={data} />
            <WorkspaceTable workspaces={data.workspaces} />
          </>
        ) : null}
      </div>
    </AdminContentWrapper>
  );
}

function SummaryCards({
  data,
}: {
  data: { aggregate: { adminCount: number; mfaEnrolled: number; activeTrustDevices: number; trustDeviceUsersInLast30Days: number; passkeyOnly: number; bothFactors: number }; workspaces: WorkspaceSecurityMetrics[] };
}) {
  const { aggregate, workspaces } = data;
  const enrollmentRate = pct(aggregate.mfaEnrolled, aggregate.adminCount);
  const passkeyAdmins = aggregate.passkeyOnly + aggregate.bothFactors;
  const passkeyRate = pct(passkeyAdmins, aggregate.adminCount);
  const workspacesWithGap = workspaces.filter(
    (w) => w.adminCount > 0 && w.mfaEnrolled < w.adminCount,
  ).length;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total admins"
        value={aggregate.adminCount}
        icon={<Users className="size-4" />}
        description={`${workspaces.length} active workspace${workspaces.length === 1 ? "" : "s"}`}
      />
      <StatCard
        title="MFA enrolled"
        value={`${enrollmentRate}%`}
        icon={<ShieldCheck className="size-4" />}
        description={`${aggregate.mfaEnrolled} of ${aggregate.adminCount} admins`}
      />
      <StatCard
        title="Passkey adopters"
        value={`${passkeyRate}%`}
        icon={<KeyRound className="size-4" />}
        description={`${passkeyAdmins} admin${passkeyAdmins === 1 ? "" : "s"} have at least one passkey`}
      />
      <StatCard
        title="Workspaces with gaps"
        value={workspacesWithGap}
        icon={<AlertTriangle className="size-4" />}
        description={
          workspacesWithGap > 0
            ? "Workspaces where at least one admin hasn't enrolled MFA"
            : "Every workspace is fully enrolled"
        }
      />
    </div>
  );
}

function FactorDistribution({
  data,
}: {
  data: { aggregate: { adminCount: number; bothFactors: number; passkeyOnly: number; twoFactorOnly: number; noFactors: number; activeTrustDevices: number; trustDeviceUsersInLast30Days: number } };
}) {
  const { aggregate } = data;
  const buckets: Array<{ label: string; value: number; tone: string }> = [
    { label: "Both factors", value: aggregate.bothFactors, tone: "bg-emerald-500" },
    { label: "Passkey only", value: aggregate.passkeyOnly, tone: "bg-sky-500" },
    { label: "TOTP only", value: aggregate.twoFactorOnly, tone: "bg-amber-500" },
    { label: "No factors", value: aggregate.noFactors, tone: "bg-destructive" },
  ];

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Factor distribution</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {aggregate.adminCount === 0 ? (
          <p className="text-sm text-muted-foreground">No admins on the platform yet.</p>
        ) : (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              {buckets.map((b) => {
                const w = pct(b.value, aggregate.adminCount);
                if (w === 0) return null;
                return (
                  <div
                    key={b.label}
                    className={b.tone}
                    style={{ width: `${w}%` }}
                    title={`${b.label}: ${b.value} (${w}%)`}
                  />
                );
              })}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              {buckets.map((b) => (
                <div key={b.label} className="flex items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${b.tone}`} aria-hidden />
                  <dt className="text-muted-foreground">{b.label}</dt>
                  <dd className="ml-auto font-medium tabular-nums">
                    {b.value}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({pct(b.value, aggregate.adminCount)}%)
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          <span>
            Active trust grants:{" "}
            <span className="font-medium text-foreground">{aggregate.activeTrustDevices}</span>
          </span>
          <span>
            Distinct admins skipping 2FA:{" "}
            <span className="font-medium text-foreground">
              {aggregate.trustDeviceUsersInLast30Days}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkspaceTable({ workspaces }: { workspaces: WorkspaceSecurityMetrics[] }) {
  if (workspaces.length === 0) {
    return (
      <Card className="shadow-none">
        <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <ShieldAlert className="mb-2 size-8" />
          <p>No active workspaces yet. Adoption metrics surface as workspaces onboard.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Workspaces</CardTitle>
        <p className="text-sm text-muted-foreground">
          One row per active workspace. Sorted by admin count, descending.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead className="text-right">Admins</TableHead>
              <TableHead>MFA enrollment</TableHead>
              <TableHead className="text-right">Passkey</TableHead>
              <TableHead className="text-right">TOTP</TableHead>
              <TableHead className="text-right">Both</TableHead>
              <TableHead className="text-right">Trust grants</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((ws) => {
              const { rate, tone } = enrollmentRow(ws);
              return (
                <TableRow key={ws.workspaceId}>
                  <TableCell>
                    <div className="font-medium">{ws.workspaceName}</div>
                    {ws.workspaceSlug && (
                      <div className="text-xs text-muted-foreground">{ws.workspaceSlug}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{ws.adminCount}</TableCell>
                  <TableCell>
                    {ws.adminCount === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Progress value={rate} className="h-2 max-w-[120px]" />
                        <Badge
                          variant={TONE_BADGE[tone]}
                          className={tone === "amber" || tone === "green" ? TONE_TEXT[tone] : undefined}
                        >
                          {rate}%
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {ws.mfaEnrolled} / {ws.adminCount}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ws.passkeyOnly + ws.bothFactors}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ws.twoFactorOnly + ws.bothFactors}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{ws.bothFactors}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ws.activeTrustDevices}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
