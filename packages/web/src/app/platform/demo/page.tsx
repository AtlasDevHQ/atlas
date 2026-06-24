"use client";

import { useQueryStates } from "nuqs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useConfigForm } from "@/ui/hooks/use-config-form";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import {
  DemoConfigSchema,
  DemoLeadsResponseSchema,
  DemoMetricsResponseSchema,
  DemoTranscriptResponseSchema,
  type DemoConfig,
  type DemoLead,
  type DemoTokenRollup,
} from "@/ui/lib/admin-schemas";
import { demoSearchParams } from "./search-params";
import { Inbox, Users } from "lucide-react";

// ── Formatting helpers ───────────────────────────────────────────────

function fmtTokens(n: number): string {
  return n.toLocaleString();
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Extract human-readable text from a persisted message's `content`. Demo
 * messages store AI-SDK UIMessage parts (`{ type: "text", text }`); this returns
 * the joined text parts (dropping non-text parts such as tool calls). A message
 * with no text part is JSON-dumped whole, guarded so a non-serializable value
 * (circular ref, BigInt) renders a placeholder instead of throwing into the
 * transcript Sheet.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text);
    if (texts.length > 0) return texts.join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    // intentionally ignored: unrenderable content (circular / BigInt) — show a
    // placeholder rather than crash the transcript Sheet via the ErrorBoundary.
    return "[unrenderable content]";
  }
}

// ── Page shell ───────────────────────────────────────────────────────

export default function DemoTrackingPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return (
    <ErrorBoundary>
      <DemoTrackingContent />
    </ErrorBoundary>
  );
}

function DemoTrackingContent() {
  const [{ selectedEmail }, setParams] = useQueryStates(demoSearchParams);
  const setSelectedEmail = (next: string | null) =>
    setParams({ selectedEmail: next });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Demo Tracking</h1>
        <p className="text-muted-foreground">
          Funnel visibility for the anonymous <code>/demo</code> path — model
          config, lead activity, token/cache spend, and per-turn latency.
        </p>
      </div>

      <ConfigPanel />
      <MetricsPanel />
      <LeadsPanel onSelect={setSelectedEmail} />

      <TranscriptSheet
        email={selectedEmail}
        onClose={() => setSelectedEmail(null)}
      />
    </div>
  );
}

// ── Config half ──────────────────────────────────────────────────────

type ConfigFormValues = {
  model: string;
  maxSteps: string;
  rpm: string;
};

function ConfigPanel() {
  const form = useConfigForm<DemoConfig, ConfigFormValues>({
    path: "/api/v1/platform/demo/config",
    schema: DemoConfigSchema,
    saveMethod: "PUT",
    toForm: (d) => ({
      model: d.model,
      maxSteps: String(d.maxSteps),
      rpm: String(d.rpm),
    }),
    toPayload: (v) => ({
      model: v.model.trim(),
      maxSteps: Number(v.maxSteps),
      rpm: Number(v.rpm),
    }),
  });

  const fields = form.fields;
  const maxStepsNum = fields ? Number(fields.maxSteps.value) : NaN;
  const rpmNum = fields ? Number(fields.rpm.value) : NaN;
  const invalid =
    !Number.isInteger(maxStepsNum) ||
    maxStepsNum < 1 ||
    maxStepsNum > 100 ||
    !Number.isInteger(rpmNum) ||
    rpmNum < 0;

  const effective = form.data?.effectiveModel ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Demo configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <AdminContentWrapper
          loading={form.loading}
          error={form.loadError}
          feature="Demo Tracking"
          onRetry={form.refetch}
          loadingMessage="Loading demo config..."
        >
          {fields ? (
            <div className="space-y-4">
              <div className="grid gap-1.5">
                <Label htmlFor="demo-model">Demo model</Label>
                <Input
                  id="demo-model"
                  value={fields.model.value}
                  onChange={(e) => fields.model.set(e.target.value)}
                  placeholder={effective ?? "Platform default"}
                  className="max-w-md font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Gateway model id (e.g.{" "}
                  <code>anthropic/claude-haiku-4.5</code>). Leave blank to use
                  the default
                  {effective ? (
                    <>
                      {" "}
                      (<code>{effective}</code>)
                    </>
                  ) : (
                    " (platform default on a non-gateway deploy)"
                  )}
                  . Changes take effect within the ~30s settings refresh
                  window — no redeploy.
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="demo-max-steps">Max agent steps</Label>
                  <Input
                    id="demo-max-steps"
                    type="number"
                    min={1}
                    max={100}
                    value={fields.maxSteps.value}
                    onChange={(e) => fields.maxSteps.set(e.target.value)}
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">1–100</p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="demo-rpm">Rate limit (RPM)</Label>
                  <Input
                    id="demo-rpm"
                    type="number"
                    min={0}
                    value={fields.rpm.value}
                    onChange={(e) => fields.rpm.set(e.target.value)}
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    Per demo user. 0 = disabled
                  </p>
                </div>
              </div>

              <MutationErrorSurface
                error={form.error}
                feature="Demo Tracking"
                onRetry={form.clearError}
              />

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => form.save()}
                  disabled={!form.dirty || form.saving || invalid}
                >
                  {form.saving ? "Saving..." : "Save config"}
                </Button>
                {form.dirty ? (
                  <Button
                    variant="ghost"
                    onClick={form.reset}
                    disabled={form.saving}
                  >
                    Reset
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </AdminContentWrapper>
      </CardContent>
    </Card>
  );
}

// ── Metrics rollup ───────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function MetricsPanel() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/platform/demo/metrics",
    { schema: DemoMetricsResponseSchema },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token &amp; cache spend</CardTitle>
      </CardHeader>
      <CardContent>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Demo Tracking"
          onRetry={refetch}
          loadingMessage="Loading metrics..."
        >
          {data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <StatTile label="Leads" value={fmtTokens(data.leadCount)} />
                <StatTile label="Sessions" value={fmtTokens(data.sessionCount)} />
                <StatTile label="Turns" value={fmtTokens(data.totals.turns)} />
                <StatTile
                  label="Est. spend"
                  value={`${fmtUsd(data.totals.estimatedCostUsd)}${data.totals.costComplete ? "" : "+"}`}
                />
                <StatTile
                  label="Prompt tokens"
                  value={fmtTokens(data.totals.promptTokens)}
                />
                <StatTile
                  label="Completion tokens"
                  value={fmtTokens(data.totals.completionTokens)}
                />
                <StatTile
                  label="Cache read / write"
                  value={`${fmtTokens(data.totals.cacheReadTokens)} / ${fmtTokens(data.totals.cacheWriteTokens)}`}
                />
                <StatTile
                  label="Avg latency"
                  value={fmtLatency(data.totals.avgLatencyMs)}
                />
              </div>

              {data.totals.estimatedCostUsd != null &&
              !data.totals.costComplete ? (
                <p className="text-xs text-muted-foreground">
                  Estimated spend is a partial figure — one or more models have
                  no known price. Costs are approximate (relative signal, not
                  billing).
                </p>
              ) : null}

              {data.perModel.length > 0 ? (
                <>
                  <Separator />
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Turns</TableHead>
                        <TableHead className="text-right">Prompt</TableHead>
                        <TableHead className="text-right">Completion</TableHead>
                        <TableHead className="text-right">Cache R/W</TableHead>
                        <TableHead className="text-right">Avg latency</TableHead>
                        <TableHead className="text-right">Est. $</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.perModel.map((m, i) => (
                        <TableRow key={`${m.model ?? "unknown"}-${m.provider ?? ""}-${i}`}>
                          <TableCell className="font-mono text-xs">
                            {m.model ?? "—"}
                            {m.provider ? (
                              <span className="text-muted-foreground">
                                {" "}
                                ({m.provider})
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtTokens(m.turns)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtTokens(m.promptTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtTokens(m.completionTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtTokens(m.cacheReadTokens)} /{" "}
                            {fmtTokens(m.cacheWriteTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtLatency(m.avgLatencyMs)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtUsd(m.estimatedCostUsd)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              ) : null}
            </div>
          ) : null}
        </AdminContentWrapper>
      </CardContent>
    </Card>
  );
}

// ── Leads table ──────────────────────────────────────────────────────

function LeadUsageCells({ usage }: { usage: DemoTokenRollup }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">
        {fmtTokens(usage.turns)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtTokens(usage.promptTokens + usage.completionTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtUsd(usage.estimatedCostUsd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtLatency(usage.avgLatencyMs)}
      </TableCell>
    </>
  );
}

function LeadsPanel({ onSelect }: { onSelect: (email: string) => void }) {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/platform/demo/leads",
    { schema: DemoLeadsResponseSchema },
  );

  const leads: DemoLead[] = data?.leads ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads</CardTitle>
      </CardHeader>
      <CardContent>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Demo Tracking"
          onRetry={refetch}
          loadingMessage="Loading leads..."
          emptyIcon={Users}
          emptyTitle="No demo leads yet"
          emptyDescription="Lead emails appear here once someone starts a demo session."
          isEmpty={leads.length === 0}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Convos</TableHead>
                <TableHead className="text-right">Turns</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Est. $</TableHead>
                <TableHead className="text-right">Avg latency</TableHead>
                <TableHead>Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow
                  key={lead.email}
                  onClick={() => onSelect(lead.email)}
                  className="cursor-pointer"
                >
                  <TableCell className="font-medium">{lead.email}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtTokens(lead.sessionCount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtTokens(lead.conversationCount)}
                  </TableCell>
                  <LeadUsageCells usage={lead.usage} />
                  <TableCell className="whitespace-nowrap">
                    <RelativeTimestamp iso={lead.lastActive} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminContentWrapper>
      </CardContent>
    </Card>
  );
}

// ── Transcript drill-in ──────────────────────────────────────────────

function TranscriptSheet({
  email,
  onClose,
}: {
  email: string | null;
  onClose: () => void;
}) {
  const { data, loading } = useAdminFetch(
    email
      ? `/api/v1/platform/demo/transcript?email=${encodeURIComponent(email)}`
      : "",
    { schema: DemoTranscriptResponseSchema, enabled: !!email },
  );

  return (
    <Sheet open={!!email} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="break-all">{email}</SheetTitle>
          <SheetDescription>
            Full demo question/answer transcript for this lead.
          </SheetDescription>
        </SheetHeader>
        {loading ? (
          <LoadingState message="Loading transcript..." />
        ) : data && data.conversations.length > 0 ? (
          <div className="mt-4 space-y-6">
            {data.conversations.map((conv) => (
              <div key={conv.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {conv.title ?? "Untitled conversation"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <RelativeTimestamp iso={conv.createdAt} />
                  </span>
                </div>
                <div className="space-y-2">
                  {conv.messages.map((msg, i) => (
                    <div
                      key={i}
                      className="rounded-md border bg-muted/40 p-2 text-sm"
                    >
                      <Badge
                        variant="outline"
                        className="mb-1 text-[10px] uppercase"
                      >
                        {msg.role}
                      </Badge>
                      <pre className="whitespace-pre-wrap break-words font-sans text-xs">
                        {extractText(msg.content)}
                      </pre>
                    </div>
                  ))}
                  {conv.messages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No messages recorded.
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center gap-2 text-muted-foreground">
            <Inbox className="size-8" />
            <p className="text-sm">No demo conversations for this lead.</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
